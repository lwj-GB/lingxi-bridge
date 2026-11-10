"""Exports from the verified report snapshot, never model-supplied HTML or URLs."""

import hashlib
import html
import io
import json
import re
from functools import lru_cache
from pathlib import Path
from xml.sax.saxutils import escape

from fastapi import APIRouter, Request
from fastapi.responses import Response
from markdown_it import MarkdownIt
from reportlab.lib import colors
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from lingxi.api.errors import ApiError
from lingxi.workspace.service import WorkspaceError, _analysis_from_body, _report_body

router = APIRouter(prefix="/reports/snapshots")


def snapshot_file(request: Request, snapshot_id: str):
    workspace = request.app.state.workspace
    if workspace is None:
        raise ApiError(409, "workspace_not_open", "请先打开工作区。")
    try:
        item = workspace.get_record(snapshot_id)
        if item["record"]["entity_type"] != "report_snapshot":
            raise ApiError(404, "record_not_found", "未找到报告快照。")
        root, _ = workspace._require_open()
        root = root.resolve()
        path = (root / item["relative_path"]).resolve(strict=True)
        if not path.is_relative_to(root / "reports" / "snapshots") or path.suffix != ".md":
            raise ApiError(422, "invalid_report_path", "报告文件路径无效。")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != item["file_hash"]:
            raise ApiError(409, "workspace_conflict", "报告已被外部修改，请先刷新后再导出。")
        return workspace, root, item, raw
    except WorkspaceError as error:
        raise ApiError(error.status_code, error.code, error.message) from error
    except OSError as error:
        raise ApiError(409, "workspace_conflict", "报告文件不可读取，请刷新工作区。") from error


@lru_cache(maxsize=1)
def _pdf_font():
    for candidate in (
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/usr/share/fonts/truetype/arphic/uming.ttc",
    ):
        if Path(candidate).is_file():
            try:
                pdfmetrics.registerFont(TTFont("LingxiReport", candidate, subfontIndex=0))
                pdfmetrics.registerFontFamily(
                    "LingxiReport",
                    normal="LingxiReport",
                    bold="LingxiReport",
                    italic="LingxiReport",
                    boldItalic="LingxiReport",
                )
                return "LingxiReport"
            except Exception:
                continue
    # PDF standard CJK CID fallback: no developer machine font path is required.
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    pdfmetrics.registerFontFamily(
        "STSong-Light",
        normal="STSong-Light",
        bold="STSong-Light",
        italic="STSong-Light",
        boldItalic="STSong-Light",
    )
    return "STSong-Light"


def _inline_part(child):
    if child.type in {"text", "code_inline", "html_inline", "image"}:
        return escape(child.content)
    if child.type in {"softbreak", "hardbreak"}:
        return "<br/>"
    if child.type in {"strong_open", "strong_close"}:
        return "<b>" if child.type.endswith("open") else "</b>"
    if child.type in {"em_open", "em_close"}:
        return "<i>" if child.type.endswith("open") else "</i>"
    return ""


def _inline(token):
    return "".join(_inline_part(child) for child in token.children or [])


def _inline_fragments(token):
    parts, active_tags = [], []
    has_text = False
    for child in token.children or []:
        if child.type == "image":
            if has_text:
                yield "text", "".join(parts) + "".join(f"</{tag}>" for tag in reversed(active_tags))
            yield "image", child.attrGet("src")
            parts = [f"<{tag}>" for tag in active_tags]
            has_text = False
            continue
        if child.type in {"strong_open", "em_open"}:
            active_tags.append("b" if child.type == "strong_open" else "i")
        elif child.type in {"strong_close", "em_close"} and active_tags:
            active_tags.pop()
        parts.append(_inline_part(child))
        has_text = has_text or bool(child.content.strip())
    if has_text:
        yield "text", "".join(parts)


def _source_notes(workspace, record):
    notes = []
    for position, evidence_id in enumerate(record.get("evidence_ids", []), 1):
        try:
            evidence = workspace.get_entity(evidence_id, "evidence")
            source = workspace.get_entity(evidence["source_id"], "source")
        except WorkspaceError as error:
            raise ApiError(error.status_code, error.code, error.message) from error
        notes.append((position, str(source["title"]), str(evidence["quote"])))
    return notes


def _markdown_literal(text):
    for character in "\\`*_[]{}()!#":
        text = text.replace(character, "\\" + character)
    return escape(text)


def render_report_pdf(workspace, item) -> bytes:
    record = item["record"]
    font = _pdf_font()
    normal = ParagraphStyle(
        "body",
        fontName=font,
        fontSize=10.5,
        leading=18,
        spaceAfter=9,
        wordWrap="CJK",
        alignment=TA_JUSTIFY,
    )
    heading = {
        level: ParagraphStyle(
            "h" + str(level),
            parent=normal,
            fontSize=size,
            leading=size * 1.5,
            spaceBefore=12,
            spaceAfter=9,
            keepWithNext=True,
            alignment=0,
        )
        for level, size in [(1, 20), (2, 14), (3, 12), (4, 11)]
    }
    small = ParagraphStyle(
        "small",
        parent=normal,
        fontSize=8,
        leading=12,
        textColor=colors.HexColor("#5b6570"),
        alignment=0,
    )
    code = ParagraphStyle(
        "code",
        parent=small,
        backColor=colors.HexColor("#f3f5f7"),
        borderPadding=7,
        spaceBefore=5,
        spaceAfter=12,
    )
    clean_body = re.sub(
        r"<!-- lingxi-structured-analysis\n.*?\n-->", "", item["body"], flags=re.DOTALL
    )
    body = re.sub(r"!\[\[([^\]]+)\]\]", r"![](\1)", clean_body)
    clean_body = re.sub(r"<!-- lingxi-report-origin: [^>]* -->", "", body)
    body = clean_body
    body = re.sub(r"\[\[[^\]|]+\|([^\]]+)\]\]", r"\1", body)
    parser = MarkdownIt("commonmark", {"html": False}).enable("table")
    tokens = parser.parse(body)
    story = [
        Paragraph(f"报告版本 {record['version']}　·　{escape(record['created_at'][:10])}", small)
    ]
    images = {}
    for asset in record.get("charts", {}).get("assets", []):
        if asset.get("kind") == "image":
            try:
                verified = workspace.get_report_asset(record["id"], asset["name"])
            except WorkspaceError as error:
                raise ApiError(error.status_code, error.code, error.message) from error
            if verified["mime_type"] != "image/png":
                raise ApiError(422, "report_asset_invalid", "报告图表格式无效。")
            image_bytes = Path(verified["path"]).read_bytes()
            if hashlib.sha256(image_bytes).hexdigest() != asset["sha256"]:
                raise ApiError(409, "report_asset_invalid", "报告图表已改变，请刷新后导出。")
            images[f"attachments/reports/{record['id']}/{asset['name']}"] = image_bytes
            images[f"../../attachments/reports/{record['id']}/{asset['name']}"] = image_bytes
    used = set()

    def add_image(src):
        if src not in images:
            raise ApiError(
                422, "report_asset_invalid", "PDF仅支持本报告已校验的图表，不能加载外部图像。"
            )
        image = Image(io.BytesIO(images[src]))
        width = A4[0] - 108
        ratio = min(width / image.imageWidth, 310 / image.imageHeight)
        image.drawWidth, image.drawHeight = image.imageWidth * ratio, image.imageHeight * ratio
        story.extend([Spacer(1, 8), image, Spacer(1, 10)])
        used.add(Path(src).name)

    level = 0
    table_rows = None
    row = None
    for token in tokens:
        if token.type == "heading_open":
            level = min(int(token.tag[1:]), 4)
        elif token.type == "table_open":
            table_rows = []
        elif token.type == "tr_open":
            row = []
        elif token.type == "tr_close" and table_rows is not None:
            table_rows.append(row)
        elif token.type == "table_close":
            if table_rows:
                cols = max(map(len, table_rows))
                table = Table(table_rows, colWidths=[(A4[0] - 108) / cols] * cols, repeatRows=1)
                table.setStyle(
                    TableStyle(
                        [
                            ("VALIGN", (0, 0), (-1, -1), "TOP"),
                            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef1f4")),
                            ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.grey),
                            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                            ("TOPPADDING", (0, 0), (-1, -1), 7),
                        ]
                    )
                )
                story.extend([table, Spacer(1, 10)])
            table_rows = None
        elif token.type == "inline":
            pictures = [c for c in token.children or [] if c.type == "image"]
            if pictures:
                for kind, value in _inline_fragments(token):
                    if kind == "image":
                        add_image(value)
                    else:
                        story.append(Paragraph(value, heading.get(level, normal)))
            else:
                paragraph = Paragraph(_inline(token), heading.get(level, normal))
                if table_rows is not None and row is not None:
                    row.append(paragraph)
                else:
                    story.append(paragraph)
            level = 0
        elif token.type in {"fence", "code_block"}:
            # Older snapshots store the validated analysis as JSON; export prose.
            try:
                value = (
                    json.loads(token.content)
                    if token.type == "fence" and token.info.strip() == "json"
                    else None
                )
            except ValueError:
                value = None
            if isinstance(value, dict) and isinstance(value.get("claims"), list):
                for claim in value["claims"]:
                    story.append(Paragraph(escape(str(claim.get("text", ""))), normal))
                    for alternative in claim.get("alternatives", []):
                        story.append(Paragraph("替代解释：" + escape(str(alternative)), normal))
                    if claim.get("uncertainty"):
                        uncertainty = {"high": "高", "medium": "中", "low": "低"}.get(
                            claim["uncertainty"], "未知"
                        )
                        story.append(Paragraph("不确定性：" + uncertainty, small))
                    ids = claim.get("evidence_ids", [])
                    if ids:
                        labels = {
                            eid: str(i + 1) for i, eid in enumerate(record.get("evidence_ids", []))
                        }
                        story.append(
                            Paragraph(
                                "依据：引文" + "、".join(labels.get(eid, "待核对") for eid in ids),
                                small,
                            )
                        )
            else:
                for line in token.content.splitlines():
                    story.append(Paragraph(escape(line) or "　", code))
    for src in images:
        if Path(src).name not in used:
            add_image(src)
    story.append(Spacer(1, 12))
    if not re.search(r"^#{1,3}\s+资料依据\s*$", body, re.MULTILINE):
        story.append(Paragraph("资料依据", heading[2]))
        for position, title, quote in _source_notes(workspace, record):
            story.append(
                Paragraph(f"来源{position}：" + escape(title) + f" / 引文{position}", small)
            )
            story.append(Paragraph(escape(quote), small))
    output = io.BytesIO()
    doc = SimpleDocTemplate(
        output,
        pagesize=A4,
        leftMargin=54,
        rightMargin=54,
        topMargin=48,
        bottomMargin=48,
        title="灵犀桥分析报告",
        author="灵犀桥",
        subject="source snapshot: " + record["id"],
        pageCompression=1,
    )

    def footer(canvas, document):
        canvas.setFont(font, 8)
        canvas.setFillColor(colors.HexColor("#68717b"))
        canvas.drawString(54, 27, "灵犀桥 · 分析报告")
        canvas.drawRightString(A4[0] - 54, 27, str(document.page))

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()


def editable_document(request: Request, snapshot_id: str):
    workspace, root, item, _ = snapshot_file(request, snapshot_id)
    exports = root / "exports"
    folder = exports / "reports"
    if exports.is_symlink() or folder.is_symlink():
        raise ApiError(422, "invalid_report_path", "阅读稿目录不能是符号链接。")
    folder = folder.resolve()
    if not folder.is_relative_to(root):
        raise ApiError(422, "invalid_report_path", "阅读稿目录超出工作区。")
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{item['record']['id']}.md"
    if path.is_symlink():
        raise ApiError(422, "invalid_report_path", "阅读稿文件不能是符号链接。")
    path = path.resolve()
    if not path.is_relative_to(folder):
        raise ApiError(422, "invalid_report_path", "阅读稿路径无效。")
    try:
        original_body = item["body"]
        if (
            "<!-- lingxi-structured-analysis" not in original_body
            and "## 结构化分析\n\n```json\n" in original_body
        ):
            start = original_body.index("```json\n")
            end = original_body.index("\n```", start) + len("\n```")
            title = html.unescape(original_body.splitlines()[0].removeprefix("# ").strip())
            original_body = (
                _report_body(title, _analysis_from_body(original_body)) + original_body[end:]
            )
        body = re.sub(r"!\[\[(attachments/reports/[^\]]+)\]\]", r"![](../../\1)", original_body)
        body = re.sub(r"\[\[(attachments/reports/[^\]|]+)\|([^\]]+)\]\]", r"[\2](../../\1)", body)
        if not re.search(r"^#{1,3}\s+资料依据\s*$", body, re.MULTILINE):
            notes = ["\n\n## 资料依据\n"]
            for position, title, quote in _source_notes(workspace, item["record"]):
                notes.extend(
                    [
                        f"\n来源{position}：{_markdown_literal(title)} / 引文{position}\n",
                        "\n"
                        + "\n".join("> " + _markdown_literal(line) for line in quote.splitlines())
                        + "\n",
                    ]
                )
            body += "".join(notes)
        body += "\n<!-- lingxi-report-origin: " + item["record"]["id"] + " -->\n"
        with path.open("xb") as stream:
            stream.write(body.encode())
    except FileExistsError:
        pass
    raw = path.read_bytes()
    try:
        body = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ApiError(422, "invalid_report_markdown", "阅读稿应保存为UTF-8 Markdown。") from error
    return (
        workspace,
        item,
        raw,
        {
            "body": body,
            "is_editable_copy": True,
            "source_snapshot_id": item["record"]["id"],
            "workspace_path": str(root),
            "relative_path": str(path.relative_to(root)),
            "file_hash": hashlib.sha256(raw).hexdigest(),
        },
    )


@router.get("/{snapshot_id}/document")
def report_document(snapshot_id: str, request: Request):
    return editable_document(request, snapshot_id)[3]


@router.get("/{snapshot_id}/file")
def report_file(snapshot_id: str, request: Request):
    return {
        key: value
        for key, value in editable_document(request, snapshot_id)[3].items()
        if key != "body"
    }


@router.get("/{snapshot_id}/source-markdown")
def report_source_markdown(snapshot_id: str, request: Request):
    _, _, _, raw = snapshot_file(request, snapshot_id)
    return Response(
        raw,
        media_type="text/markdown",
        headers={
            "Content-Disposition": f'attachment; filename="snapshot-{snapshot_id}.md"',
        },
    )


@router.get("/{snapshot_id}/markdown")
def report_markdown(snapshot_id: str, request: Request):
    _, _, raw, _ = editable_document(request, snapshot_id)
    return Response(
        raw,
        media_type="text/markdown",
        headers={
            "Content-Disposition": f'attachment; filename="report-{snapshot_id}.md"',
        },
    )


@router.get("/{snapshot_id}/pdf")
def report_pdf(snapshot_id: str, request: Request):
    workspace, item, _, document = editable_document(request, snapshot_id)
    try:
        raw = render_report_pdf(workspace, {**item, "body": document["body"]})
    except ApiError:
        raise
    except Exception as error:
        raise ApiError(422, "report_pdf_failed", "报告排版失败，请检查正文与图表。") from error
    return Response(
        raw,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="report-{snapshot_id}.pdf"',
        },
    )
