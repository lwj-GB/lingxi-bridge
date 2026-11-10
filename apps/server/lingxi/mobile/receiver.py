from __future__ import annotations

import hmac
import json
import secrets
import socket
import threading
import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .archive import MAX_BYTES
from .store import MobileArchiveStore


class ArchiveHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, address, handler):
        self._slots = threading.BoundedSemaphore(8)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def handle_error(self, request, client_address):
        # Keep malformed requests and connection exceptions out of content-bearing logs.
        pass


class MobileReceiver:
    """A user-enabled archive-only LAN endpoint; never expose the desktop API."""

    def __init__(self, current_workspace: Callable[[], object], *, ttl: float = 1800):
        self.lock = threading.RLock()
        self._current_workspace = current_workspace
        self._ttl = ttl
        self._server: ThreadingHTTPServer | None = None
        self._timer: threading.Timer | None = None
        self._workspace: object | None = None
        self._store: MobileArchiveStore | None = None
        self._code: str | None = None
        self._expires = 0.0
        self._count = 0
        self._bad_attempts: deque[float] = deque()

    def _valid(self) -> bool:
        return (
            self._server is not None
            and self._workspace is self._current_workspace()
            and time.time() < self._expires
        )

    def status(self) -> dict:
        with self.lock:
            if self._server is not None and not self._valid():
                self.stop()
            active = self._server is not None
            return {
                "active": active,
                "addresses": self._addresses(self._server.server_port) if active else [],
                "code": self._code if active else None,
                "expiresAt": datetime.fromtimestamp(self._expires, UTC).isoformat()
                if active
                else None,
                "receivedCount": self._count,
            }

    @staticmethod
    def _addresses(port: int) -> list[str]:
        hosts = set()
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                address = info[4][0]
                if not address.startswith("127.") and address != "0.0.0.0":
                    hosts.add(address)
        except OSError:
            pass
        # UDP connect selects the LAN interface without sending packets.
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect(("10.255.255.255", 1))
                hosts.add(probe.getsockname()[0])
        except OSError:
            pass
        return [f"http://{host}:{port}" for host in sorted(hosts)] + [f"http://127.0.0.1:{port}"]

    def start(self, workspace: object, root: Path) -> dict:
        with self.lock:
            self.stop()
            self._workspace = workspace
            self._store = MobileArchiveStore(root)
            self._store._check_inbox()
            self._code = f"{secrets.randbelow(100_000_000):08d}"
            self._expires = time.time() + self._ttl
            self._count = 0
            self._bad_attempts.clear()
            owner = self

            class Handler(BaseHTTPRequestHandler):
                def setup(self):
                    self.request.settimeout(15)
                    super().setup()

                def log_message(self, _format, *args):
                    # Private text and pairing credentials must not enter request logs.
                    pass

                def send_json(self, code: int, value: dict):
                    raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
                    self.send_response(code)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(raw)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(raw)

                def do_POST(self):
                    self.connection.settimeout(15)
                    if self.headers.get("Origin") is not None:
                        return self.send_json(403, {"error": "origin_forbidden"})
                    if self.path != "/archive":
                        return self.send_json(404, {"error": "not_found"})
                    with owner.lock:
                        if not owner._valid() or owner._server is not self.server:
                            return self.send_json(410, {"error": "receiver_expired"})
                        now = time.monotonic()
                        while owner._bad_attempts and owner._bad_attempts[0] <= now - 60:
                            owner._bad_attempts.popleft()
                        if len(owner._bad_attempts) >= 10:
                            return self.send_json(429, {"error": "too_many_attempts"})
                        auth = self.headers.get("Authorization", "")
                        expected = f"Bearer {owner._code}"
                        if len(
                            self.headers.get_all("Authorization", [])
                        ) != 1 or not hmac.compare_digest(auth.encode(), expected.encode()):
                            owner._bad_attempts.append(now)
                            return self.send_json(401, {"error": "pairing_code_invalid"})
                    if (
                        self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                        != "application/json"
                    ):
                        return self.send_json(415, {"error": "content_type_invalid"})
                    if self.headers.get("Transfer-Encoding"):
                        return self.send_json(400, {"error": "content_length_required"})
                    lengths = self.headers.get_all("Content-Length", [])
                    if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdecimal():
                        return self.send_json(411, {"error": "content_length_required"})
                    length = int(lengths[0])
                    if length <= 0 or length > MAX_BYTES:
                        return self.send_json(413, {"error": "archive_too_large"})
                    try:
                        raw = self.rfile.read(length)
                        if len(raw) != length:
                            return self.send_json(400, {"error": "archive_incomplete"})
                        with owner.lock:
                            if not owner._valid() or owner._server is not self.server:
                                return self.send_json(410, {"error": "receiver_expired"})
                            result = owner._store.receive(raw)
                            if result["status"] == "created":
                                owner._count += 1
                        return self.send_json(200, result)
                    except (
                        ValueError,
                        KeyError,
                        TypeError,
                        OverflowError,
                        UnicodeError,
                        RecursionError,
                    ):
                        return self.send_json(422, {"error": "archive_invalid"})
                    except OSError:
                        return self.send_json(503, {"error": "archive_unavailable"})

            server = ArchiveHTTPServer(("0.0.0.0", 0), Handler)
            server.daemon_threads = True
            server.block_on_close = False
            self._server = server
            threading.Thread(
                target=server.serve_forever, daemon=True, name="mobile-receiver"
            ).start()
            generation = server

            def expire():
                with self.lock:
                    if self._server is generation:
                        self.stop()

            self._timer = threading.Timer(self._ttl, expire)
            self._timer.daemon = True
            self._timer.start()
            return self.status()

    def stop(self) -> dict:
        with self.lock:
            timer, server = self._timer, self._server
            self._timer = self._server = None
            self._workspace = self._store = self._code = None
            self._expires = 0
            if timer is not None:
                timer.cancel()
            if server is not None:
                server.shutdown()
                server.server_close()
            return {
                "active": False,
                "addresses": [],
                "code": None,
                "expiresAt": None,
                "receivedCount": self._count,
            }
