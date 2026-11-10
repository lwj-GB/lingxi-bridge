from __future__ import annotations

import json
import selectors
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "apps" / "desktop" / "sidecar" / "lingxi_server.py"


def _read_ready_line(process: subprocess.Popen[str], timeout: float) -> dict[str, object]:
    assert process.stdout is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(f"sidecar exited before ready: {process.stderr.read()}")
            if selector.select(timeout=0.1):
                return json.loads(process.stdout.readline())
    finally:
        selector.close()
    raise AssertionError("sidecar did not become ready")


def test_sidecar_exits_when_desktop_parent_exits() -> None:
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    sidecar = subprocess.Popen(
        [
            sys.executable,
            str(SIDECAR),
            "--port",
            "0",
            "--parent-pid",
            str(parent.pid),
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        ready = _read_ready_line(sidecar, timeout=10)
        assert ready["event"] == "ready"
        parent.terminate()
        parent.wait(timeout=5)
        assert sidecar.wait(timeout=5) == 0
    finally:
        if parent.poll() is None:
            parent.terminate()
            parent.wait(timeout=5)
        if sidecar.poll() is None:
            sidecar.terminate()
            sidecar.wait(timeout=5)
