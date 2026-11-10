import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

_EXECUTORS = (
    ("claude", "Claude Code CLI"),
    ("codex", "Codex CLI"),
)


def cli_search_path() -> str:
    paths = os.environ.get("PATH", os.defpath).split(os.pathsep)
    paths.extend([str(Path.home() / ".local/bin"), str(Path.home() / ".npm-global/bin"),
                  "/opt/homebrew/bin", "/usr/local/bin"])
    return os.pathsep.join(dict.fromkeys(paths))


def _probe_environment(root: Path) -> dict[str, str]:
    home_dir = root / "home"
    config_dir = root / "cli-config"
    temp_dir = root / "tmp"
    environment = {
        "HOME": str(home_dir),
        "TMPDIR": str(temp_dir),
        "XDG_CONFIG_HOME": str(config_dir / "xdg"),
        "CLAUDE_CONFIG_DIR": str(config_dir / "claude"),
        "CODEX_HOME": str(config_dir / "codex"),
        "PATH": cli_search_path(),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
    }
    for path in (
        home_dir,
        temp_dir,
        Path(environment["XDG_CONFIG_HOME"]),
        Path(environment["CLAUDE_CONFIG_DIR"]),
        Path(environment["CODEX_HOME"]),
    ):
        path.mkdir(parents=True, exist_ok=True)
    return environment


def resolve_executable(engine: str) -> str | None:
    if engine not in {item[0] for item in _EXECUTORS}:
        return None
    found = shutil.which(engine)
    if found:
        return found
    # Finder-launched apps do not inherit the user's interactive shell PATH.
    home = Path.home()
    directories = [
        home / ".local/bin",
        home / ".npm-global/bin",
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
    ]
    for directory in directories:
        found = shutil.which(engine, path=str(directory))
        if found:
            return found
    return None


def discover_executors() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="lingxi-executor-probe-") as temp_name:
        root = Path(temp_name).resolve()
        environment = _probe_environment(root)
        for engine, name in _EXECUTORS:
            path = resolve_executable(engine)
            if path is None:
                items.append(
                    {
                        "engine": engine,
                        "name": name,
                        "available": False,
                        "path": None,
                        "version": None,
                        "degraded_reason": "executable_not_found",
                    }
                )
                continue

            version: str | None = None
            degraded_reason: str | None = None
            try:
                completed = subprocess.run(
                    [path, "--version"],
                    capture_output=True,
                    text=True,
                    timeout=2,
                    check=False,
                    cwd=root,
                    env=environment,
                )
                if completed.returncode == 0:
                    version = completed.stdout.strip().splitlines()[0][:200]
                else:
                    degraded_reason = "version_probe_failed"
            except (OSError, subprocess.SubprocessError):
                degraded_reason = "version_probe_failed"
            items.append(
                {
                    "engine": engine,
                    "name": name,
                    "available": True,
                    "path": path,
                    "version": version,
                    "degraded_reason": degraded_reason,
                }
            )
    return items
