import os
import select
import shlex
import signal
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from lingxi.main import create_app
from lingxi.terminal import PtySession
from starlette.websockets import WebSocketDisconnect

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Unix PTY only")


def _read_until(session, expected: bytes, timeout=4):
    output = b""
    deadline = time.monotonic() + timeout
    while expected not in output and time.monotonic() < deadline:
        if select.select([session.master], [], [], 0.1)[0]:
            try:
                output += os.read(session.master, 16384)
            except OSError:
                break
    assert expected in output, output
    return output


def test_real_pty_input_resize_interrupt_and_cleanup(tmp_path, monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/sh")
    session = PtySession(tmp_path, "shell")
    try:
        session.resize(91, 37)
        session.write("printf '\\n%s\\n' 'fixture-terminal-output'; stty size\n")
        result = _read_until(session, b"37 91")
        assert b"fixture-terminal-output" in result
        session.write("printf '\\n%s%s\\n' 'sleep-' 'started'; sleep 30\n")
        _read_until(session, b"sleep-started")
        deadline = time.monotonic() + 2
        while os.tcgetpgrp(session.master) == session.process.pid and time.monotonic() < deadline:
            time.sleep(0.02)
        session.interrupt()
        time.sleep(0.15)
        session.write("printf '\\n%s%s\\n' 'after-' 'interrupt'\n")
        _read_until(session, b"after-interrupt")
        session.write("exit 7\n")
        deadline = time.monotonic() + 3
        while session.process.poll() is None and time.monotonic() < deadline:
            if select.select([session.master], [], [], 0.03)[0]:
                try:
                    os.read(session.master, 16384)
                except OSError:
                    pass
        assert session.process.poll() == 7
    finally:
        session.close()
    assert session.process.poll() is not None


def test_close_kills_foreground_job_even_after_shell_exits(tmp_path, monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/sh")
    child_pid_file = tmp_path / "foreground.pid"
    script = tmp_path / "ignore-signals.py"
    script.write_text(
        "import os,signal,time\n"
        "from pathlib import Path\n"
        "signal.signal(signal.SIGHUP, signal.SIG_IGN)\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        f"Path({str(child_pid_file)!r}).write_text(str(os.getpid()))\n"
        "time.sleep(60)\n"
    )
    session = PtySession(tmp_path, "shell")
    unrelated = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
    child_pid = None
    try:
        session.write(f"{shlex.quote(sys.executable)} {shlex.quote(str(script))}\n")
        deadline = time.monotonic() + 4
        while not child_pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert child_pid_file.exists()
        child_pid = int(child_pid_file.read_text())
        assert os.tcgetpgrp(session.master) == child_pid
        session.close()
        assert session.process.poll() is not None
        assert unrelated.poll() is None
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.02)
        else:
            pytest.fail("Foreground process survived terminal close")
    finally:
        # The deliberately stubborn fixture must not survive a regression failure.
        if child_pid:
            with suppress(ProcessLookupError):
                os.kill(child_pid, signal.SIGKILL)
        unrelated.terminate()
        unrelated.wait(timeout=2)
        session.close()


def test_websocket_origin_workspace_and_disconnect_cleanup(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/sh")
    app = create_app()
    with TestClient(app, base_url="http://127.0.0.1") as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "ws://127.0.0.1/api/terminal", headers={"origin": "https://evil.example"}
            ):
                pass
        with client.websocket_connect("ws://127.0.0.1/api/terminal") as ws:
            assert ws.receive_json()["type"] == "error"
        assert client.post("/api/workspaces/open", json={"path": str(tmp_path)}).status_code == 200
        with client.websocket_connect(
            "ws://127.0.0.1/api/terminal", headers={"origin": "http://localhost:5173"}
        ) as ws:
            ws.send_json({"type": "start", "engine": "shell", "cols": 80, "rows": 24})
            assert ws.receive_json()["type"] == "started"
            session = next(iter(app.state.terminal_sessions))
            ws.send_json(
                {
                    "type": "input",
                    "data": (
                        "printf '\\n%s%s\\n' 'websocket-' 'fixture'; "
                        "printf '\\n%s\\n' \"$LINGXI_API_BASE_URL\"\n"
                    ),
                }
            )
            output = ""
            while "websocket-fixture" not in output or "http://127.0.0.1/api" not in output:
                event = ws.receive_json()
                if event["type"] == "output":
                    output += event["data"]
            ws.send_json({"type": "resize", "cols": 100, "rows": 40})
            ws.send_json({"type": "stop"})
        deadline = time.monotonic() + 3
        while app.state.terminal_sessions and time.monotonic() < deadline:
            time.sleep(0.02)
        assert not app.state.terminal_sessions
        assert session.process.poll() is not None


def test_local_browser_can_preflight_event_patch():
    with TestClient(create_app()) as client:
        response = client.options(
            "/api/events/example",
            headers={
                "Origin": "http://127.0.0.1:5174",
                "Access-Control-Request-Method": "PATCH",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert response.status_code == 200
        assert "PATCH" in response.headers["access-control-allow-methods"]


def test_deepseek_profile_keeps_credentials_out_of_arguments(tmp_path, monkeypatch):
    import json
    import sqlite3

    from lingxi.terminal import deepseek_terminal_profile

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    folder = tmp_path / ".cc-switch"
    folder.mkdir()
    database = folder / "cc-switch.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE providers (app_type TEXT, name TEXT, settings_config TEXT)")
        connection.execute("INSERT INTO providers VALUES (?, ?, ?)", (
            "claude", "DeepSeek", json.dumps({"env": {
                "ANTHROPIC_BASE_URL": "https://example.invalid/anthropic",
                "ANTHROPIC_MODEL": "fixture-model",
                "ANTHROPIC_AUTH_TOKEN": "fixture-private-token",
                "UNRELATED_SECRET": "must-not-copy",
            }}),
        ))
    before = database.read_bytes()
    environment, arguments = deepseek_terminal_profile()
    assert environment["ANTHROPIC_AUTH_TOKEN"] == "fixture-private-token"
    assert "fixture-private-token" not in " ".join(arguments)
    assert "UNRELATED_SECRET" not in environment
    assert arguments[-2:] == ["--model", "fixture-model"]
    assert database.read_bytes() == before


def test_missing_deepseek_profile_fails_without_creating_database(tmp_path, monkeypatch):
    from lingxi.terminal import deepseek_terminal_profile

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    with pytest.raises(ValueError, match="CC Switch"):
        deepseek_terminal_profile()
    assert not (tmp_path / ".cc-switch").exists()
