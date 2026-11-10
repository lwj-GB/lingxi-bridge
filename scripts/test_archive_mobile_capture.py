"""Fictional exports exercise append-only archival and rejection before writes."""

import json
import tempfile
import unittest
from pathlib import Path

from archive_mobile_capture import archive


class MobileArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "export.json"
        self.inbox = self.root / "inbox"
        self.device = "fdc61f3b-39e9-4a88-a86b-9961ed82595d"
        self.data = {"type": "lingxi_mobile_archive", "version": 1, "deviceId": self.device,
                     "date": "2026-11-10", "generatedAt": 1794268800000, "timeZone": "Asia/Shanghai",
                     "lines": [{"id": f"{self.device}:line:1", "localId": 1, "segmentId": 2,
                                "startAt": 1000, "endAt": 2000, "speaker": "我", "text": "虚构：明天交报告"}],
                     "todos": [{"id": f"{self.device}:item:3", "localId": 3, "category": "待办",
                                "content": "交虚构报告", "status": "Pending", "at": 1000,
                                "dueAt": None, "sourceLineId": f"{self.device}:line:1", "generatedBy": "ai"}]}

    def write(self):
        self.source.write_text(json.dumps(self.data, ensure_ascii=False))

    def test_original_bytes_are_preserved_and_repeat_is_idempotent(self):
        self.write()
        first = archive(self.source, self.inbox)
        self.assertEqual(first["status"], "created")
        self.assertEqual((Path(first["path"]) / "original.json").read_bytes(), self.source.read_bytes())
        self.assertEqual(archive(self.source, self.inbox)["status"], "exists")
        self.assertIn("虚构报告", (Path(first["path"]) / "记录.md").read_text())

    def test_new_content_keeps_old_snapshot_and_manual_edits_stop_overwrite(self):
        self.write()
        first = archive(self.source, self.inbox)
        self.data["todos"][0]["status"] = "Done"
        self.write()
        second = archive(self.source, self.inbox)
        self.assertNotEqual(first["path"], second["path"])
        original = Path(first["path"]) / "original.json"
        self.assertEqual(json.loads(original.read_text())["todos"][0]["status"], "Pending")
        (Path(second["path"]) / "记录.md").write_text("用户手改")
        with self.assertRaises(ValueError):
            archive(self.source, self.inbox)
        self.assertEqual((Path(second["path"]) / "记录.md").read_text(), "用户手改")

    def test_missing_source_or_secret_config_is_rejected_before_writing(self):
        self.data["todos"][0]["sourceLineId"] = f"{self.device}:line:999"
        self.write()
        with self.assertRaises(ValueError):
            archive(self.source, self.inbox)
        self.assertFalse(self.inbox.exists())
        self.data["todos"][0]["sourceLineId"] = None
        self.data["apiKey"] = "fictional"
        self.write()
        with self.assertRaises(ValueError):
            archive(self.source, self.inbox)
        self.assertFalse(self.inbox.exists())

    def test_duplicate_json_keys_are_rejected(self):
        self.write()
        self.source.write_text(self.source.read_text().replace('"version": 1', '"version": 1, "version": 1'))
        with self.assertRaises(ValueError):
            archive(self.source, self.inbox)

    def test_context_is_preserved_as_user_statement_and_must_reference_exported_audio(self):
        self.data["contexts"] = [{"segmentId": 2, "participants": "虚构联系人小林",
                                  "background": "用户补充：讨论虚构作业", "updatedAt": 3000, "source": "user"}]
        self.write()
        result = archive(self.source, self.inbox)
        text = (Path(result["path"]) / "记录.md").read_text()
        self.assertIn("用户补充：讨论虚构作业", text)
        self.assertIn("不是原话或经过声纹验证的身份", text)
        self.data["contexts"][0]["segmentId"] = 999
        self.write()
        with self.assertRaises(ValueError):
            archive(self.source, self.inbox)

    def journal(self):
        unavailable = lambda: {"state": "NotAuthorized", "value": None, "sourcePackages": [], "message": "未授权"}
        return {"markdown": "虚构日记：今天和小林讨论项目。", "statistics": {
            "usage": {"state": "PermissionRequired", "message": "未授权", "apps": [], "timeline": []},
            "notifications": {"state": "PermissionRequired", "message": "未授权", "observedFromMillis": None,
                              "observedUntilMillis": None, "coveredMillis": 0, "total": None, "apps": [], "hourly": []},
            "health": {"availability": "Available", **{key: unavailable() for key in
                       ("steps", "distanceMeters", "exerciseMinutes", "hourlySteps", "sessions")}}}}

    def test_daily_journal_keeps_unknown_statistics_distinct_from_zero(self):
        self.data["journal"] = self.journal()
        self.write()
        result = archive(self.source, self.inbox)
        text = (Path(result["path"]) / "记录.md").read_text()
        self.assertIn("虚构日记", text)
        self.assertIn("无可用数据", text)
        self.assertNotIn("步数：0", text)

    def test_diary_rejects_notification_contents_and_fabricated_zero_for_missing_health(self):
        self.data["journal"] = self.journal()
        self.data["journal"]["statistics"]["notifications"]["apps"] = [
            {"packageName": "fictional.app", "label": "虚构应用", "count": 1, "text": "不允许的通知正文"}]
        self.write()
        with self.assertRaises(ValueError):
            archive(self.source, self.inbox)
        self.assertFalse(self.inbox.exists())
        self.data["journal"] = self.journal()
        self.data["journal"]["statistics"]["health"]["steps"]["value"] = 0
        self.write()
        with self.assertRaises(ValueError):
            archive(self.source, self.inbox)


if __name__ == "__main__":
    unittest.main()
