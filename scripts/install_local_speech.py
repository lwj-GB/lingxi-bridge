#!/usr/bin/env python3
"""Explicit model download only; recognition never invokes this installer.

Run with the project's virtual environment after installing requirements-local-speech.txt.
The official model's license is separate from sherpa-onnx's Apache-2.0 runtime license:
https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/server"))
from lingxi.local_speech import MODEL, LocalSpeech, model_dir  # noqa: E402

URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/{MODEL}.tar.bz2"
HASHES = {
    "model.int8.onnx": "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
    "tokens.txt": "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
}
ARCHIVE_SHA256 = "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e"


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    destination = model_dir()
    if all(
        (destination / name).is_file() and digest(destination / name) == expected
        for name, expected in HASHES.items()
    ):
        print(f"模型已校验：{destination}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lingxi-model-", dir=destination.parent) as temporary:
        archive = Path(temporary) / "model.tar.bz2"
        print(f"下载固定模型（约156MB）：{URL}")
        with urllib.request.urlopen(URL, timeout=120) as source, archive.open("wb") as output:
            shutil.copyfileobj(source, output)
        if digest(archive) != ARCHIVE_SHA256:
            raise RuntimeError("官方文件与固定SHA-256不同，停止安装。")
        with tarfile.open(archive, "r:bz2") as bundle:
            for filename in (*HASHES, "LICENSE", "README.md"):
                member = bundle.getmember(f"{MODEL}/{filename}")
                if not member.isfile():
                    raise RuntimeError("模型压缩包结构无效。")
                source = bundle.extractfile(member)
                if source is None:
                    raise RuntimeError("模型压缩包文件缺失。")
                with source, (Path(temporary) / filename).open("wb") as output:
                    shutil.copyfileobj(source, output)
        for filename, expected in HASHES.items():
            if digest(Path(temporary) / filename) != expected:
                raise RuntimeError("模型内容校验失败。")
        destination.mkdir(parents=True, exist_ok=True)
        for filename in (*HASHES, "LICENSE", "README.md"):
            shutil.move(str(Path(temporary) / filename), destination / filename)
    print(f"模型已安装并校验：{destination}")
    print("模型专用许可：https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE")


def verify():
    """Use fixed fictional text, never the microphone or existing recordings."""
    if sys.platform != "darwin" or shutil.which("say") is None:
        raise RuntimeError("合成样本验证目前需要macOS内置say；没有读取任何录音。")
    text = "今天下午三点，我们在图书馆见面。我想先听听你的想法，再一起讨论下一步。"
    with tempfile.TemporaryDirectory(prefix="lingxi-speech-check-") as temporary:
        sample = Path(temporary) / "synthetic.aiff"
        subprocess.run(["say", "-v", "Tingting", "-r", "155", "-o", str(sample), text], check=True)
        speech = LocalSpeech()
        print(
            json.dumps(
                {
                    "sample_text": text,
                    "cold": speech.transcribe(sample),
                    "warm": speech.transcribe(sample),
                },
                ensure_ascii=False,
                indent=2,
            )
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="另用固定合成中文跑真实离线识别")
    arguments = parser.parse_args()
    main()
    if arguments.verify:
        verify()
