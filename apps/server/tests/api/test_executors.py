from pathlib import Path
from subprocess import CompletedProcess
from typing import Any

from fastapi.testclient import TestClient
from lingxi.main import create_app


def test_executors_reports_paths_and_versions_with_an_isolated_probe(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls: list[list[str]] = []
    environments: list[dict[str, str]] = []
    working_directories: list[Path] = []
    existing_home = tmp_path / "existing-home"
    existing_claude = tmp_path / "existing-claude"
    existing_codex = tmp_path / "existing-codex"
    for directory in (existing_home, existing_claude, existing_codex):
        directory.mkdir()
    claude_settings = existing_claude / "settings.json"
    codex_settings = existing_codex / "config.toml"
    claude_settings.write_text('{"model":"existing"}\n', encoding="utf-8")
    codex_settings.write_text('model = "existing"\n', encoding="utf-8")
    before = (claude_settings.read_bytes(), codex_settings.read_bytes())
    monkeypatch.setenv("HOME", str(existing_home))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(existing_claude))
    monkeypatch.setenv("CODEX_HOME", str(existing_codex))
    monkeypatch.setenv("LINGXI_PROBE_SECRET", "must-not-cross-boundary")

    def fake_which(engine: str, **_kwargs) -> str | None:
        return "/opt/fake/claude" if engine == "claude" else None

    def fake_run(command: list[str], **kwargs: Any) -> CompletedProcess[str]:
        calls.append(command)
        environments.append(kwargs["env"])
        working_directories.append(kwargs["cwd"])
        return CompletedProcess(command, 0, stdout="Claude Code 9.8.7\n", stderr="")

    monkeypatch.setattr("lingxi.analysis.executors.shutil.which", fake_which)
    monkeypatch.setattr("lingxi.analysis.executors.subprocess.run", fake_run)

    with TestClient(create_app()) as client:
        response = client.get("/api/executors")

    assert response.status_code == 200
    assert response.json() == {
        "items": [
            {
                "engine": "claude",
                "name": "Claude Code CLI",
                "available": True,
                "path": "/opt/fake/claude",
                "version": "Claude Code 9.8.7",
                "degraded_reason": None,
            },
            {
                "engine": "codex",
                "name": "Codex CLI",
                "available": False,
                "path": None,
                "version": None,
                "degraded_reason": "executable_not_found",
            },
        ]
    }
    assert calls == [["/opt/fake/claude", "--version"]]
    assert len(environments) == 1
    probe_environment = environments[0]
    assert set(probe_environment) == {
        "HOME",
        "TMPDIR",
        "XDG_CONFIG_HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "PATH",
        "LANG",
    }
    assert probe_environment["HOME"] != str(existing_home)
    assert probe_environment["CLAUDE_CONFIG_DIR"] != str(existing_claude)
    assert probe_environment["CODEX_HOME"] != str(existing_codex)
    assert "LINGXI_PROBE_SECRET" not in probe_environment
    assert working_directories == [Path(probe_environment["HOME"]).parent]
    assert (claude_settings.read_bytes(), codex_settings.read_bytes()) == before


def test_finder_path_finds_user_cli_without_reading_shell_config(tmp_path, monkeypatch):
    from lingxi.analysis.executors import resolve_executable

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    executable = tmp_path / ".npm-global" / "bin" / "codex"
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o700)
    assert resolve_executable("codex") == str(executable)
    assert resolve_executable("../untrusted") is None
