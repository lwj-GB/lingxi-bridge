from __future__ import annotations

import json
import os
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class IndexRecord:
    record: dict
    relative_path: str
    body: str
    file_hash: str
    fingerprint: str


class DerivedIndex:
    """A disposable index whose complete input is the open workspace files."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def rebuild(self, records: list[IndexRecord]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with sqlite3.connect(temporary) as connection:
                connection.execute("PRAGMA journal_mode=DELETE")
                connection.execute("PRAGMA synchronous=FULL")
                connection.executescript(
                    """
                    CREATE TABLE records (
                        id TEXT PRIMARY KEY,
                        entity_type TEXT NOT NULL,
                        relative_path TEXT NOT NULL UNIQUE,
                        file_hash TEXT NOT NULL,
                        fingerprint TEXT NOT NULL,
                        body TEXT NOT NULL,
                        record_json TEXT NOT NULL
                    );
                    CREATE INDEX records_by_type
                        ON records(entity_type, id);
                    CREATE VIRTUAL TABLE records_fts USING fts5(
                        id UNINDEXED,
                        entity_type UNINDEXED,
                        title,
                        body,
                        tokenize='trigram'
                    );
                    """
                )
                for item in records:
                    record = item.record
                    record_json = json.dumps(
                        record,
                        ensure_ascii=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                    connection.execute(
                        """
                        INSERT INTO records(
                            id, entity_type, relative_path, file_hash,
                            fingerprint, body, record_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            record["id"],
                            record["entity_type"],
                            item.relative_path,
                            item.file_hash,
                            item.fingerprint,
                            item.body,
                            record_json,
                        ),
                    )
                    connection.execute(
                        """
                        INSERT INTO records_fts(id, entity_type, title, body)
                        VALUES (?, ?, ?, ?)
                        """,
                        (
                            record["id"],
                            record["entity_type"],
                            _title(record),
                            item.body,
                        ),
                    )
                connection.commit()

            with temporary.open("rb") as file:
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
            _fsync_directory(self.path.parent)
        finally:
            temporary.unlink(missing_ok=True)

    def fingerprints(self) -> dict[str, str]:
        if not self.path.is_file():
            return {}
        try:
            with sqlite3.connect(self.path) as connection:
                return dict(connection.execute("SELECT id, fingerprint FROM records"))
        except sqlite3.DatabaseError:
            return {}

    def list(self, entity_type: str) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT record_json
                FROM records
                WHERE entity_type = ?
                ORDER BY id
                """,
                (entity_type,),
            )
            return [json.loads(row[0]) for row in rows]

    def get(self, record_id: str) -> IndexRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT record_json, relative_path, body, file_hash, fingerprint
                FROM records
                WHERE id = ?
                """,
                (record_id,),
            ).fetchone()
        if row is None:
            return None
        return IndexRecord(
            record=json.loads(row[0]),
            relative_path=row[1],
            body=row[2],
            file_hash=row[3],
            fingerprint=row[4],
        )

    def _connect(self) -> sqlite3.Connection:
        if not self.path.is_file():
            raise sqlite3.DatabaseError(f"index does not exist: {self.path}")
        return sqlite3.connect(self.path)


def _title(record: dict) -> str:
    return str(
        record.get("title")
        or record.get("display_name")
        or record.get("relation_kind")
        or record["entity_type"]
    )


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
