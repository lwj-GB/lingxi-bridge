from __future__ import annotations

import hashlib
import re
import threading
from datetime import UTC, datetime
from pathlib import Path

from .archive import MAX_BYTES, archive_bytes, validate

_FOLDER = re.compile(r"\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}-([a-f0-9]{64})")
_ID = re.compile(r"[a-f0-9]{64}")


class MobileArchiveStore:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.inbox = self.root / "mobile-inbox"
        self.lock = threading.RLock()

    def _check_inbox(self) -> None:
        if self.inbox.is_symlink() or (self.inbox.exists() and not self.inbox.is_dir()):
            raise ValueError("手机收件箱路径异常，请检查 mobile-inbox。")

    def receive(self, raw: bytes) -> dict:
        with self.lock:
            self._check_inbox()
            result = archive_bytes(raw, self.inbox)
            data = validate(raw)
            return {
                "id": result["sha256"],
                "status": result["status"],
                "date": data["date"],
                "lineCount": len(data["lines"]),
                "todoCount": len(data["todos"]),
            }

    def _entries(self):
        self._check_inbox()
        if not self.inbox.exists():
            return
        for entry in self.inbox.iterdir():
            match = _FOLDER.fullmatch(entry.name)
            if match is None:
                continue
            if entry.is_symlink() or not entry.is_dir():
                raise ValueError("手机归档目录异常，请核对后再打开。")
            original = entry / "original.json"
            if original.is_symlink() or not original.is_file():
                raise ValueError("手机归档原件异常，请核对后再打开。")
            with original.open("rb") as stream:
                raw = stream.read(MAX_BYTES + 1)
            data = validate(raw)
            digest = hashlib.sha256(raw).hexdigest()
            expected_name = f"{data['date']}-{data['deviceId']}-{digest}"
            if digest != match[1] or expected_name != entry.name:
                raise ValueError("手机归档原件已被修改，请核对文件。")
            yield entry, digest, data

    def list_archives(self) -> list[dict]:
        with self.lock:
            result = [
                {
                    "id": digest,
                    "date": data["date"],
                    "deviceId": data["deviceId"],
                    "generatedAt": data["generatedAt"],
                    "receivedAt": datetime.fromtimestamp(entry.stat().st_mtime, UTC).isoformat(),
                    "lineCount": len(data["lines"]),
                    "todoCount": len(data["todos"]),
                    "hasJournal": "journal" in data,
                }
                for entry, digest, data in self._entries()
            ]
            return sorted(
                result,
                key=lambda item: (item["date"], item["generatedAt"], item["id"]),
                reverse=True,
            )

    def read(self, archive_id: str) -> dict:
        if not _ID.fullmatch(archive_id):
            raise KeyError("invalid archive ID")
        with self.lock:
            for _, digest, data in self._entries():
                if digest == archive_id:
                    return {"id": digest, "archive": data}
        raise KeyError("archive not found")
