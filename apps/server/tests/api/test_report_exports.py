import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from lingxi.analysis.report_charts import plotting_capabilities
from lingxi.main import create_app
from pypdf import PdfReader


def prepare(client, root, charts=False):
    assert client.post("/api/workspaces/open", json={"path": str(root)}).status_code == 200
    person = client.post(
        "/api/people", json={"display_name": "林舟（虚构）", "relation_to_user": "朋友"}
    ).json()
    text = "2026-11-09 10:00 林舟：明天一起散步。\n2026-11-09 10:02 我：好的。"
    src = client.post(
        "/api/sources/text",
        json={
            "title": "虚构聊天",
            "text": text,
            "source_kind": "chat_export",
            "person_ids": [person["id"]],
        },
    ).json()
    evidence = client.post(
        "/api/evidence",
        json={
            "source_id": src["id"],
            "quote": text,
            "locator": {"kind": "text_quote", "start": 0, "end": len(text)},
            "evidence_kind": "direct_quote",
            "reliability": "high",
            "person_ids": [person["id"]],
        },
    ).json()
    report = client.post(
        "/api/reports",
        json={
            "title": "中文分析报告",
            "template_family": "special",
            "template_variant": "communication_prep",
            "person_ids": [person["id"]],
            "evidence_ids": [evidence["id"]],
            "engine": "safe_placeholder",
            "include_charts": charts,
        },
    )
    assert report.status_code == 201, report.text
    return report.json()


def test_editable_copy_never_changes_snapshot_and_exports_current_text(tmp_path):
    with TestClient(create_app()) as client:
        report = prepare(client, tmp_path)
        sid = report["snapshot"]["id"]
        prefix = f"/api/reports/snapshots/{sid}"
        snapshot = tmp_path / "reports/snapshots" / f"{sid}.md"
        original = snapshot.read_bytes()
        assert client.get(prefix + "/source-markdown").content == original
        document = client.get(prefix + "/document").json()
        assert document["is_editable_copy"]
        copy = tmp_path / document["relative_path"]
        copy.write_text("# 人工修订的报告\n\n这段内容来自人工编辑。\n\n## 依据\n\n保留原始来源。\n")
        reloaded = client.get(prefix + "/document").json()
        assert "人工编辑" in reloaded["body"]
        assert client.get(prefix + "/markdown").content == copy.read_bytes()
        assert snapshot.read_bytes() == original
        assert client.post("/api/workspaces/refresh").status_code == 200
        pdf = client.get(prefix + "/pdf")
        assert pdf.status_code == 200, pdf.text
        assert pdf.content.startswith(b"%PDF-")
        reader = PdfReader(io.BytesIO(pdf.content))
        assert "人工修订的报告" in reader.pages[0].extract_text()
        assert "人工编辑" in "".join(page.extract_text() for page in reader.pages)


def test_real_r_images_and_chinese_font_are_in_pdf(tmp_path):
    if not plotting_capabilities()["available"]:
        pytest.skip("Requires actual R and ggplot2")
    with TestClient(create_app()) as client:
        report = prepare(client, tmp_path, charts=True)
        sid = report["snapshot"]["id"]
        prefix = f"/api/reports/snapshots/{sid}"
        response = client.get(prefix + "/pdf")
        assert response.status_code == 200, response.text
        reader = PdfReader(io.BytesIO(response.content))
        text = "".join(page.extract_text() for page in reader.pages)
        assert "中文分析报告" in text
        assert "lingxi-structured-analysis" not in text
        assert "material_scope" not in text
        assert sid not in text
        assert "来源1：虚构聊天 / 引文1" in text
        assert sum(len(page.images) for page in reader.pages) >= 2
        assert len(reader.pages) >= 2
        if Path("/System/Library/Fonts/Supplemental/Songti.ttc").is_file():
            fonts = [
                font.get_object()
                for page in reader.pages
                for font in page["/Resources"]["/Font"].values()
            ]
            assert any(
                font.get("/FontDescriptor") and "/FontFile2" in font["/FontDescriptor"]
                for font in fonts
            )
        document = client.get(prefix + "/document").json()
        draft = tmp_path / document["relative_path"]
        draft.write_text(
            "# 中文分析报告\n\n"
            "**图前重要结论 ![](../../attachments/reports/"
            + sid
            + "/frequency.png) 图后限制条件**\n\n"
            "    复现参数 n=42\n    重要计算依据\n\n这段正常文字。\n"
        )
        mixed = client.get(prefix + "/pdf")
        assert mixed.status_code == 200, mixed.text
        mixed_reader = PdfReader(io.BytesIO(mixed.content))
        mixed_text = "".join(page.extract_text() for page in mixed_reader.pages)
        assert "图前重要结论" in mixed_text
        assert "图后限制条件" in mixed_text
        assert mixed_text.index("图前重要结论") < mixed_text.index("图后限制条件")
        assert "复现参数 n=42" in mixed_text
        assert "重要计算依据" in mixed_text
        assert "这段正常文字" in mixed_text
        assert sum(len(page.images) for page in mixed_reader.pages) >= 2
        asset = tmp_path / "attachments/reports" / sid / "frequency.png"
        asset.write_bytes(asset.read_bytes() + b"changed")
        failed = client.get(prefix + "/pdf")
        assert failed.status_code == 409


def test_export_refuses_untrusted_images_and_changed_snapshot(tmp_path):
    with TestClient(create_app()) as client:
        report = prepare(client, tmp_path)
        sid = report["snapshot"]["id"]
        prefix = f"/api/reports/snapshots/{sid}"
        copy = tmp_path / client.get(prefix + "/document").json()["relative_path"]
        copy.write_text("# 不可信图片\n\n![image](https://example.invalid/external.png)\n")
        assert client.get(prefix + "/pdf").status_code == 422
        original = tmp_path / "reports/snapshots" / f"{sid}.md"
        original.write_bytes(original.read_bytes() + b"externally changed")
        assert client.get(prefix + "/source-markdown").status_code == 409
        assert client.get(prefix + "/pdf").status_code == 409


@pytest.mark.parametrize("alias", ["exports", "reports", "file"])
def test_editable_copy_rejects_internal_aliases_to_history(tmp_path, alias):
    with TestClient(create_app()) as client:
        report = prepare(client, tmp_path)
        sid = report["snapshot"]["id"]
        original = tmp_path / "reports/snapshots" / f"{sid}.md"
        saved = original.read_bytes()
        exports = tmp_path / "exports"
        if alias == "exports":
            exports.symlink_to(tmp_path / "reports", target_is_directory=True)
        elif alias == "reports":
            exports.mkdir()
            (exports / "reports").symlink_to(
                tmp_path / "reports/snapshots", target_is_directory=True
            )
        else:
            (exports / "reports").mkdir(parents=True)
            (exports / "reports" / f"{sid}.md").symlink_to(original)
        response = client.get(f"/api/reports/snapshots/{sid}/document")
        assert response.status_code == 422, response.text
        assert original.read_bytes() == saved


def test_legacy_report_copy_is_readable_without_rewriting_original(tmp_path):
    import json

    from lingxi.workspace.service import _markdown_bytes, _parse_markdown

    with TestClient(create_app()) as client:
        report = prepare(client, tmp_path)
        sid = report["snapshot"]["id"]
        legacy = (
            "# 旧版报告\n\n## 结构化分析\n\n```json\n"
            + json.dumps(report["analysis"], ensure_ascii=False)
            + "\n```\n\n## 旧报告附录\n\n这段原有内容应保留。\n"
        )
        files = [
            tmp_path / "reports/snapshots" / f"{sid}.md",
            tmp_path / "reports" / f"{report['topic']['id']}.md",
        ]
        for file in files:
            record, _ = _parse_markdown(file.read_text())
            file.write_bytes(_markdown_bytes(record, legacy))
        raw = files[0].read_bytes()
        assert client.post("/api/workspaces/refresh").status_code == 200
        body = client.get(f"/api/reports/snapshots/{sid}/document").json()["body"]
        assert "## 材料里看到了什么" in body
        assert "<!-- lingxi-structured-analysis" in body
        assert "这段原有内容应保留" in body
        assert "## 资料依据" in body
        assert "来源1：虚构聊天 / 引文1" in body
        assert files[0].read_bytes() == raw
