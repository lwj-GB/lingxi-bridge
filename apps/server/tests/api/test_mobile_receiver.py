from __future__ import annotations

import asyncio
import hashlib
import http.client
import json
import socket
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient
from lingxi.main import create_app
from lingxi.mobile.archive import MAX_BYTES
from lingxi.mobile.receiver import MobileReceiver
from lingxi.mobile.store import MobileArchiveStore

DEVICE = "fdc61f3b-39e9-4a88-a86b-9961ed82595d"


def payload():
    return {
        "type": "lingxi_mobile_archive",
        "version": 1,
        "deviceId": DEVICE,
        "date": "2026-11-10",
        "generatedAt": 1794268800000,
        "timeZone": "Asia/Shanghai",
        "lines": [
            {
                "id": f"{DEVICE}:line:1",
                "localId": 1,
                "segmentId": 2,
                "startAt": 1000,
                "endAt": 2000,
                "speaker": "我",
                "text": "虚构：明天交报告",
            }
        ],
        "todos": [
            {
                "id": f"{DEVICE}:item:3",
                "localId": 3,
                "category": "待办",
                "content": "交虚构报告",
                "status": "Pending",
                "at": 1000,
                "dueAt": None,
                "sourceLineId": f"{DEVICE}:line:1",
                "generatedBy": "ai",
            }
        ],
    }


def raw_payload():
    return json.dumps(payload(), ensure_ascii=False, indent=2).encode()


def send(status, raw=None, *, code=None, path="/archive", headers=None):
    address = urlsplit(status["addresses"][-1])
    connection = http.client.HTTPConnection(address.hostname, address.port, timeout=3)
    raw = raw_payload() if raw is None else raw
    merged = {
        "Authorization": f"Bearer {status['code'] if code is None else code}",
        "Content-Type": "application/json",
    }
    merged.update(headers or {})
    try:
        connection.request("POST", path, raw, merged)
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def test_direct_receipt_raw_bytes_retry_listing_and_read_survive_restart(tmp_path, capsys):
    app = create_app()
    raw = raw_payload()
    with TestClient(app) as client:
        assert client.get("/api/mobile/receiver").json()["active"] is False
        assert client.get("/api/mobile/archives").status_code == 422
        assert client.post("/api/mobile/receiver/start").status_code == 422
        client.post("/api/workspaces/open", json={"path": str(tmp_path)})
        status = client.post("/api/mobile/receiver/start").json()
        assert status["active"] and len(status["code"]) == 8
        assert status["code"].isdecimal()
        assert "code" not in str(status["addresses"])
        assert send(status, code="invalid")[0] == 401
        assert send(status, path="/api/workspaces/open")[0] == 404
        response_code, result = send(status, raw)
        assert response_code == 200 and result["status"] == "created"
        assert result["id"] == hashlib.sha256(raw).hexdigest()
        assert send(status, raw)[1]["status"] == "exists"
        original = next((tmp_path / "mobile-inbox").glob("*/original.json"))
        assert original.read_bytes() == raw
        records = client.get("/api/mobile/archives").json()["archives"]
        assert len(records) == 1
        assert records[0]["lineCount"] == 1 and records[0]["todoCount"] == 1
        assert records[0]["hasJournal"] is False
        read = client.get(f"/api/mobile/archives/{result['id']}").json()
        assert read["archive"] == payload()
        assert client.get("/api/mobile/archives/not-an-id").status_code == 404
        assert client.get("/api/mobile/receiver").json()["receivedCount"] == 1
        output = capsys.readouterr()
        assert status["code"] not in output.out + output.err
        assert payload()["lines"][0]["text"] not in output.out + output.err
    assert app.state.mobile_receiver.status()["active"] is False
    with TestClient(create_app()) as client:
        client.post("/api/workspaces/open", json={"path": str(tmp_path)})
        assert len(client.get("/api/mobile/archives").json()["archives"]) == 1
        assert client.get("/api/mobile/receiver").json()["active"] is False


def test_browser_origin_content_type_limits_invalid_json_and_lockout(tmp_path):
    with TestClient(create_app()) as client:
        client.post("/api/workspaces/open", json={"path": str(tmp_path)})
        for path in ("/receiver/start", "/receiver/stop", "/import"):
            response = client.post(
                "/api/mobile" + path,
                json={"archive": payload()},
                headers={"Origin": "https://example.invalid"},
            )
            assert response.status_code == 403
        status = client.post(
            "/api/mobile/receiver/start", headers={"Origin": "http://localhost:5173"}
        ).json()
        assert send(status, headers={"Origin": "https://example.invalid"})[0] == 403
        assert send(status, headers={"Content-Type": "text/plain"})[0] == 415
        assert send(status, raw=b"{}", headers={"Content-Length": str(MAX_BYTES + 1)})[0] == 413
        assert send(status, raw=b"{}")[0] == 422
        assert not (tmp_path / "mobile-inbox").exists()
        duplicate = raw_payload().replace(b'"version": 1', b'"version": 1, "version": 1')
        assert send(status, raw=duplicate)[0] == 422
        for _ in range(10):
            assert send(status, code="wrong")[0] == 401
        assert send(status)[0] == 429
        assert not (tmp_path / "mobile-inbox").exists()


def test_same_package_concurrent_receipt_is_idempotent_and_manual_edit_is_preserved(tmp_path):
    with TestClient(create_app()) as client:
        client.post("/api/workspaces/open", json={"path": str(tmp_path)})
        status = client.post("/api/mobile/receiver/start").json()
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: send(status), range(4)))
        assert all(result[0] == 200 for result in results)
        assert [r[1]["status"] for r in results].count("created") == 1
        markdown = next((tmp_path / "mobile-inbox").glob("*/记录.md"))
        markdown.write_text("用户修改的阅读副本，不得覆盖")
        assert send(status)[0] == 422
        assert markdown.read_text() == "用户修改的阅读副本，不得覆盖"
        original = markdown.with_name("original.json")
        original.write_bytes(raw_payload() + b" ")
        assert client.get("/api/mobile/archives").status_code == 422


def test_symlink_inbox_or_original_cannot_escape_workspace(tmp_path):
    root, outside = tmp_path / "vault", tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (root / "mobile-inbox").symlink_to(outside, target_is_directory=True)
    store = MobileArchiveStore(root)
    with pytest.raises(ValueError):
        store.receive(raw_payload())
    assert not list(outside.iterdir())
    with TestClient(create_app()) as client:
        client.post("/api/workspaces/open", json={"path": str(root)})
        assert client.get("/api/mobile/archives").status_code == 422
        assert client.post("/api/mobile/receiver/start").status_code == 503
    other_root = tmp_path / "other-vault"
    other_root.mkdir()
    store = MobileArchiveStore(other_root)
    store.receive(raw_payload())
    original = next((other_root / "mobile-inbox").glob("*/original.json"))
    original.rename(original.with_name("preserved.json"))
    original.symlink_to(original.with_name("preserved.json"))
    with pytest.raises(ValueError):
        store.read(hashlib.sha256(raw_payload()).hexdigest())


def test_switch_workspace_stop_and_expiry_invalidate_old_connections(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    app = create_app()
    with TestClient(app) as client:
        client.post("/api/workspaces/open", json={"path": str(first)})
        status = client.post("/api/mobile/receiver/start").json()
        address = urlsplit(status["addresses"][-1])
        pending = socket.create_connection((address.hostname, address.port), timeout=3)
        raw = raw_payload()
        headers = (
            "POST /archive HTTP/1.1\r\nHost: localhost\r\n"
            f"Authorization: Bearer {status['code']}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {len(raw)}\r\n\r\n"
        ).encode()
        pending.sendall(headers + raw[:1])
        time.sleep(0.03)
        client.post("/api/workspaces/open", json={"path": str(second)})
        new_status = client.post("/api/mobile/receiver/start").json()
        pending.sendall(raw[1:])
        assert b"410" in pending.recv(4096)
        pending.close()
        assert not (first / "mobile-inbox").exists()
        assert not (second / "mobile-inbox").exists()
        assert send(new_status)[0] == 200
        assert client.post("/api/mobile/receiver/stop").json()["active"] is False
        with pytest.raises(OSError):
            send(new_status)
        status = client.post("/api/mobile/receiver/start").json()
        app.state.mobile_receiver._expires = time.time() - 1
        assert send(status)[0] == 410
        assert client.get("/api/mobile/receiver").json()["active"] is False


def test_expiry_closes_listener_without_status_poll(tmp_path):
    workspace = object()
    receiver = MobileReceiver(lambda: workspace, ttl=0.05)
    try:
        status = receiver.start(workspace, tmp_path)
        assert receiver._timer is not None
        receiver._timer.join(timeout=2)
        assert receiver.status()["active"] is False
        with pytest.raises(OSError):
            send(status)
    finally:
        receiver.stop()


def test_local_import_preserves_string_original_and_rejects_duplicate_fields(tmp_path):
    with TestClient(create_app()) as client:
        client.post("/api/workspaces/open", json={"path": str(tmp_path)})
        raw = raw_payload()
        first = client.post("/api/mobile/import", json={"archive": raw.decode()})
        assert first.status_code == 200 and first.json()["status"] == "created"
        assert next((tmp_path / "mobile-inbox").glob("*/original.json")).read_bytes() == raw
        assert (
            client.post("/api/mobile/import", json={"archive": raw.decode()}).json()["status"]
            == "exists"
        )
        duplicate = (
            b'{"archive":' + raw.replace(b'"version": 1', b'"version": 2, "version": 1') + b"}"
        )
        response = client.post(
            "/api/mobile/import", content=duplicate, headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 422
        assert (
            client.post(
                "/api/mobile/import", content=raw, headers={"Content-Type": "text/plain"}
            ).status_code
            == 415
        )


def test_workspace_header_rejects_stale_start_import_and_stop(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    with TestClient(create_app()) as client:
        client.post("/api/workspaces/open", json={"path": str(second)})
        stale = {"X-Lingxi-Workspace": str(first)}
        assert client.post("/api/mobile/receiver/start", headers=stale).status_code == 409
        assert (
            client.post(
                "/api/mobile/import", headers=stale, json={"archive": payload()}
            ).status_code
            == 409
        )
        status = client.post(
            "/api/mobile/receiver/start", headers={"X-Lingxi-Workspace": str(second)}
        ).json()
        assert status["active"] is True
        assert client.post("/api/mobile/receiver/stop", headers=stale).status_code == 409
        assert client.get("/api/mobile/receiver").json()["active"] is True
        assert not (second / "mobile-inbox").exists()
        preflight = client.options(
            "/api/mobile/import",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type,X-Lingxi-Workspace",
            },
        )
        assert preflight.status_code == 200


def test_chunked_local_import_rejects_workspace_switch_before_writing(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    app = create_app()

    async def exercise():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            await client.post("/api/workspaces/open", json={"path": str(first)})
            began, resume = asyncio.Event(), asyncio.Event()
            raw = json.dumps({"archive": raw_payload().decode()}).encode()

            async def chunks():
                yield raw[:1]
                began.set()
                await resume.wait()
                yield raw[1:]

            sending = asyncio.create_task(
                client.post(
                    "/api/mobile/import",
                    content=chunks(),
                    headers={
                        "Content-Type": "application/json",
                        "X-Lingxi-Workspace": str(first),
                    },
                )
            )
            await asyncio.wait_for(began.wait(), timeout=2)
            opened = await client.post("/api/workspaces/open", json={"path": str(second)})
            assert opened.status_code == 200
            resume.set()
            response = await asyncio.wait_for(sending, timeout=2)
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "mobile_workspace_changed"

    asyncio.run(exercise())
    assert not (first / "mobile-inbox").exists()
    assert not (second / "mobile-inbox").exists()


def test_encoded_chinese_workspace_header_preserves_spaces_and_rejects_bad_encoding(tmp_path):
    vault = tmp_path / "手机 资料"
    vault.mkdir()
    header = {"X-Lingxi-Workspace": quote(str(vault), safe="")}
    with TestClient(create_app()) as client:
        assert client.post("/api/workspaces/open", json={"path": str(vault)}).status_code == 200
        assert client.post("/api/mobile/receiver/start", headers=header).status_code == 200
        assert (
            client.post(
                "/api/mobile/import", json={"archive": payload()}, headers=header
            ).status_code
            == 200
        )
        wrong = {"X-Lingxi-Workspace": quote(str(tmp_path / "另一工作区"), safe="")}
        assert client.post("/api/mobile/receiver/stop", headers=wrong).status_code == 409
        for invalid in ("%FF", "%GG", "%", "%E4%B8"):
            response = client.post(
                "/api/mobile/receiver/stop", headers={"X-Lingxi-Workspace": invalid}
            )
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "mobile_workspace_changed"
        assert client.get("/api/mobile/receiver").json()["active"] is True
        assert client.post("/api/mobile/receiver/stop", headers=header).status_code == 200
