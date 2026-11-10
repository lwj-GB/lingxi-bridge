"""Local Unix PTY sessions. No command or output is persisted."""

import asyncio
import codecs
import contextlib
import json
import os
import select
import signal
import sqlite3
import struct
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit

from anyio import BrokenResourceError, CancelScope, ClosedResourceError
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from lingxi.analysis.executors import cli_search_path, resolve_executable
from lingxi.realtime.router import _origin_is_allowed

if os.name == "posix":
    import fcntl
    import pty
    import termios


router = APIRouter(prefix="/api")


def _take_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def deepseek_terminal_profile() -> tuple[dict[str, str], list[str]]:
    """Read the user's saved provider; secrets stay in the child environment."""
    database = Path.home() / ".cc-switch" / "cc-switch.db"
    try:
        with sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True) as connection:
            rows = connection.execute(
                "SELECT settings_config FROM providers WHERE app_type = ? AND name = ?",
                ("claude", "DeepSeek"),
            ).fetchall()
        if len(rows) != 1:
            raise ValueError("请先在 CC Switch 保存唯一的 DeepSeek Claude Code 配置。")
        settings = json.loads(rows[0][0])
        values = settings.get("env", {})
        allowed = {
            key: value
            for key, value in values.items()
            if isinstance(value, str)
            and (
                key
                in {
                    "ANTHROPIC_BASE_URL",
                    "ANTHROPIC_MODEL",
                    "ANTHROPIC_REASONING_MODEL",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL",
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                    "CLAUDE_CODE_SUBAGENT_MODEL",
                    "API_TIMEOUT_MS",
                }
            )
        }
        if not allowed.get("ANTHROPIC_MODEL") or not allowed.get("ANTHROPIC_BASE_URL"):
            raise ValueError("DeepSeek 配置缺少模型或接口地址。")
        if not (allowed.get("ANTHROPIC_AUTH_TOKEN") or allowed.get("ANTHROPIC_API_KEY")):
            raise ValueError("DeepSeek 配置缺少凭据，请在 CC Switch 中补全。")
        public = {
            key: value
            for key, value in allowed.items()
            if key not in {"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"}
        }
        return allowed, [
            "--setting-sources",
            "project,local",
            "--settings",
            json.dumps({"env": public}),
            "--model",
            allowed["ANTHROPIC_MODEL"],
        ]
    except (OSError, sqlite3.Error, json.JSONDecodeError, TypeError, AttributeError) as error:
        raise ValueError("无法读取现有 DeepSeek 配置，请检查 CC Switch。") from error


class PtySession:
    def __init__(
        self, cwd: Path, engine: str, cols: int = 80, rows: int = 24, api_base_url: str = ""
    ):
        if os.name != "posix":
            raise ValueError("本版本终端仅支持macOS/Unix。")
        if engine == "shell":
            executable = os.environ.get("SHELL", "/bin/sh")
        elif engine in {"claude", "codex", "claude-deepseek"}:
            executable = resolve_executable("claude" if engine == "claude-deepseek" else engine)
        else:
            raise ValueError("未知终端执行器。")
        if not executable or not Path(executable).is_file():
            raise ValueError("本机没有安装所选CLI，请先安装或选择系统Shell。")
        profile_env, arguments = (
            deepseek_terminal_profile() if engine == "claude-deepseek" else ({}, [])
        )
        self.master, slave = pty.openpty()
        self.process = None
        try:
            self.resize(cols, rows)
            env = {
                **os.environ,
                **profile_env,
                "TERM": "xterm-256color",
                "COLORTERM": "truecolor",
                "PATH": cli_search_path(),
                "LINGXI_WORKSPACE": str(cwd),
                "LINGXI_API_BASE_URL": api_base_url,
                "LINGXI_OPENAPI_URL": api_base_url.removesuffix("/api") + "/openapi.json"
                if api_base_url
                else "",
            }
            if profile_env:
                for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
                    if key not in profile_env:
                        env.pop(key, None)
            self.process = subprocess.Popen(
                [executable, "-l"] if engine == "shell" else [executable, *arguments],
                cwd=cwd,
                env=env,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                preexec_fn=_take_terminal,
            )
        except Exception:
            os.close(self.master)
            raise
        finally:
            os.close(slave)
        self.closed = False

    def resize(self, cols: int, rows: int):
        if not 2 <= cols <= 500 or not 2 <= rows <= 300:
            raise ValueError("终端尺寸无效。")
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def write(self, data: str):
        if len(data) > 65536:
            raise ValueError("单次终端输入过长。")
        payload = data.encode()
        while payload:
            written = os.write(self.master, payload)
            payload = payload[written:]

    def _signal_groups(self) -> set[int]:
        if not self.process:
            return set()
        groups = {self.process.pid} if self.process.poll() is None else set()
        with contextlib.suppress(OSError):
            groups.add(os.tcgetpgrp(self.master))
        return {group for group in groups if group > 1 and group != os.getpgrp()}

    def _signal(self, signum: int, groups: set[int] | None = None):
        captured = groups is not None
        groups = self._signal_groups() if groups is None else groups
        for group in groups:
            # macOS denies getsid() across sessions; the foreground group comes
            # from our own controlling PTY, never from client-supplied input.
            if group > 1 and group != os.getpgrp():
                if not captured and group == self.process.pid and self.process.poll() is not None:
                    continue
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(group, signum)

    def interrupt(self):
        self._signal(signal.SIGINT)

    def close(self):
        if self.closed:
            return
        self.closed = True
        os.set_blocking(self.master, False)
        if self.process:
            # Capture foreground ownership before HUP can terminate the shell.
            # A foreground job may deliberately ignore HUP/TERM and outlive it.
            groups = self._signal_groups()
            self._signal(signal.SIGHUP, groups)
            self._signal(signal.SIGTERM, groups)
            deadline = time.monotonic() + 1
            while groups and time.monotonic() < deadline:
                for group in tuple(groups):
                    try:
                        os.killpg(group, 0)
                    except (ProcessLookupError, PermissionError):
                        # Never target this numeric group again once it vanishes.
                        groups.discard(group)
                self.process.poll()
                # macOS may wait for PTY output to drain before reaping a child.
                if select.select([self.master], [], [], 0.03)[0]:
                    with contextlib.suppress(OSError):
                        os.read(self.master, 16384)
            self._signal(signal.SIGKILL, groups)
        with contextlib.suppress(OSError):
            os.close(self.master)
        if self.process:
            self.process.wait(timeout=2)


@router.websocket("/terminal")
async def terminal_socket(socket: WebSocket):
    if not _origin_is_allowed(socket.headers.get("origin")):
        await socket.close(code=1008)
        return
    await socket.accept()
    session = None
    tasks = []
    registry = socket.app.state.terminal_sessions
    try:
        workspace = socket.app.state.workspace
        if workspace is None:
            raise ValueError("请先打开工作区。")
        root, _ = workspace._require_open()
        start = await asyncio.wait_for(socket.receive_json(), timeout=15)
        if (
            start.get("type") != "start"
            or len(registry) >= 4
            or Path(str(start.get("workspace_path", root))).resolve() != root
        ):
            raise ValueError("终端启动请求无效或会话已满。")
        address = urlsplit(str(socket.url))
        if address.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("终端只接受本机服务地址。")
        api_base_url = (
            ("https" if address.scheme == "wss" else "http") + "://" + address.netloc + "/api"
        )
        session = PtySession(
            root,
            start.get("engine", "shell"),
            int(start.get("cols", 80)),
            int(start.get("rows", 24)),
            api_base_url=api_base_url,
        )
        registry.add(session)
        await socket.send_json(
            {"type": "started", "cwd": str(root), "engine": start.get("engine", "shell")}
        )

        async def output():
            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            while True:
                try:
                    data = await asyncio.to_thread(os.read, session.master, 16384)
                except OSError:
                    data = b""
                if not data:
                    tail = decoder.decode(b"", final=True)
                    if tail:
                        await socket.send_json({"type": "output", "data": tail})
                    code = await asyncio.to_thread(session.process.wait)
                    await socket.send_json({"type": "exit", "code": code})
                    return
                text = decoder.decode(data)
                if text:
                    await socket.send_json({"type": "output", "data": text})

        async def input_events():
            while True:
                message = await socket.receive_json()
                kind = message.get("type")
                if kind == "input":
                    await asyncio.to_thread(session.write, str(message.get("data", "")))
                elif kind == "resize":
                    session.resize(int(message["cols"]), int(message["rows"]))
                elif kind == "interrupt":
                    session.interrupt()
                elif kind == "stop":
                    return
                else:
                    raise ValueError("未知终端操作。")

        async def workspace_watch():
            while True:
                await asyncio.sleep(0.25)
                current = socket.app.state.workspace
                if current is None or current._require_open()[0] != root:
                    await socket.send_json(
                        {"type": "error", "message": "工作区已切换，终端已结束。"}
                    )
                    return

        tasks = [asyncio.create_task(fn()) for fn in (output, input_events, workspace_watch)]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except (WebSocketDisconnect, asyncio.CancelledError, BrokenResourceError, ClosedResourceError):
        pass
    except (TimeoutError, ValueError, TypeError, KeyError, OSError):
        with contextlib.suppress(Exception):
            await socket.send_json(
                {"type": "error", "message": "终端无法启动或已结束，请检查工作区与执行器。"}
            )
    finally:
        # Client disconnect cancellation must not interrupt OS-process cleanup.
        with CancelScope(shield=True):
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            if session:
                try:
                    await asyncio.to_thread(session.close)
                finally:
                    registry.discard(session)
            with contextlib.suppress(Exception):
                await socket.close()
