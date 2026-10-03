#!/usr/bin/env python3
"""Dependency-free structural checks for the unpacked Chromium extension."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"
ALLOWED_PERMISSIONS = {"storage"}
REQUIRED_FILES = {
    "manifest.json",
    "background.js",
    "shared.js",
    "content.js",
}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    missing = sorted(path for path in REQUIRED_FILES if not (EXTENSION / path).is_file())
    if missing:
        fail(f"missing extension files: {', '.join(missing)}")

    try:
        manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid manifest: {error}")

    if manifest.get("manifest_version") != 3:
        fail("manifest_version must be 3")
    if int(manifest.get("minimum_chrome_version", "0").split(".")[0]) < 116:
        fail("minimum_chrome_version must be at least 116")

    permissions = set(manifest.get("permissions", []))
    if permissions != ALLOWED_PERMISSIONS:
        fail(f"unexpected permissions: {sorted(permissions ^ ALLOWED_PERMISSIONS)}")
    if manifest.get("host_permissions") != ["https://www.youtube.com/*"]:
        fail("host permissions must remain restricted to www.youtube.com")
    if manifest.get("action", {}).get("default_popup"):
        fail("default_popup prevents action.onClicked from toggling the overlay")

    referenced = {manifest.get("background", {}).get("service_worker")}
    for entry in manifest.get("content_scripts", []):
        referenced.update(entry.get("js", []))
        referenced.update(entry.get("css", []))
    referenced.discard(None)
    missing_references = sorted(path for path in referenced if not (EXTENSION / path).is_file())
    if missing_references:
        fail(f"manifest references missing files: {', '.join(missing_references)}")

    for javascript in EXTENSION.glob("*.js"):
        source = javascript.read_text(encoding="utf-8")
        if re.search(r"https?://", source):
            fail(f"remote URL found in executable source: {javascript.name}")
        if re.search(r"\beval\s*\(|\bnew\s+Function\s*\(", source):
            fail(f"dynamic code execution found: {javascript.name}")

    asset = EXTENSION / "assets/cats/three-cats.webm"
    if not asset.exists():
        print("WARNING: three-cats.webm is absent; emoji fallback will be used")
    else:
        if asset.stat().st_size > 8 * 1024 * 1024:
            print("WARNING: three-cats.webm exceeds the 8 MiB target")
        validate_webm(asset)

    print("Extension structure is valid.")


def validate_webm(asset: Path) -> None:
    if not shutil.which("ffprobe"):
        print("WARNING: ffprobe is unavailable; WebM metadata was not checked")
        return

    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,width,height:stream_tags=alpha_mode:format=duration",
            "-of",
            "json",
            str(asset),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    metadata = json.loads(result.stdout)
    stream = metadata.get("streams", [{}])[0]
    if stream.get("codec_name") != "vp9":
        fail("three-cats.webm must use VP9")
    if stream.get("tags", {}).get("alpha_mode") != "1":
        fail("three-cats.webm does not declare an alpha channel")
    if stream.get("width") != 608 or stream.get("height") != 690:
        fail("three-cats.webm has unexpected dimensions")
    duration = float(metadata.get("format", {}).get("duration", 0))
    if not 11.75 <= duration <= 11.85:
        fail("three-cats.webm must contain the complete reference")


if __name__ == "__main__":
    main()
