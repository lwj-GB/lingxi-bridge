#!/usr/bin/env python3
"""Explicitly fetch pinned public CAM++ weights, verify SHA-256, then install in cache.

Model card (Apache-2.0):
https://www.modelscope.ai/models/iic/speech_campplus_sv_zh-cn_16k-common
ONNX conversion/distribution: https://github.com/k2-fsa/sherpa-onnx
The pinned hash was measured from the official release; upstream has no signed digest.
No audio is read, sent or recorded by this script. Normal inference never downloads.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "server"))
from lingxi.realtime.voiceprint import MODEL_FILENAME, MODEL_SHA256, default_model_path

URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"
    + MODEL_FILENAME
)
SIZE = 28_281_138


def main() -> int:
    target = default_model_path()
    if not target.is_absolute():
        raise ValueError("LINGXI_VOICEPRINT_MODEL must be an absolute path")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError("Existing model differs; preserved without overwrite")
    else:
        temporary = None
        try:
            fd, temporary = tempfile.mkstemp(prefix=".campplus-", dir=target.parent)
            digest = hashlib.sha256()
            total = 0
            with os.fdopen(fd, "wb") as output, urllib.request.urlopen(URL, timeout=60) as source:
                while chunk := source.read(1024 * 1024):
                    total += len(chunk)
                    if total > SIZE:
                        raise ValueError("Unexpected model size")
                    digest.update(chunk)
                    output.write(chunk)
            if total != SIZE or digest.hexdigest() != MODEL_SHA256:
                raise ValueError("Model SHA-256 or size check failed")
            os.link(temporary, target)
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)
    print(
        json.dumps(
            {"model": str(target), "sha256": MODEL_SHA256, "bytes": SIZE, "license": "Apache-2.0"}
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
