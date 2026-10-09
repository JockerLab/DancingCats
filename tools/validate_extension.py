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
    "assets/catalog.json",
}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid JSON {path.relative_to(ROOT)}: {error}")


def main() -> None:
    missing = sorted(path for path in REQUIRED_FILES if not (EXTENSION / path).is_file())
    if missing:
        fail(f"missing extension files: {', '.join(missing)}")

    manifest = read_json(EXTENSION / "manifest.json")
    if manifest.get("manifest_version") != 3:
        fail("manifest_version must be 3")
    if int(manifest.get("minimum_chrome_version", "0").split(".")[0]) < 116:
        fail("minimum_chrome_version must be at least 116")
    permissions = set(manifest.get("permissions", []))
    if permissions != ALLOWED_PERMISSIONS:
        fail(f"unexpected permissions: {sorted(permissions ^ ALLOWED_PERMISSIONS)}")
    # The content script must survive YouTube's SPA navigation from another
    # youtube.com page; executable code still gates activation to /watch.
    expected_hosts = {"https://www.youtube.com/*", "http://127.0.0.1:8765/*"}
    if set(manifest.get("host_permissions", [])) != expected_hosts:
        fail("host permissions must remain restricted to YouTube and the local analyzer")
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
        remote_urls = set(re.findall(r"https?://[^\"'`\s]+", source))
        allowed_prefixes = ("http://127.0.0.1:8765",) if javascript.name == "background.js" else ()
        unexpected_urls = {url for url in remote_urls if not url.startswith(allowed_prefixes)}
        if unexpected_urls:
            fail(f"unexpected remote URL found in executable source: {javascript.name}")
        if re.search(r"\beval\s*\(|\bnew\s+Function\s*\(", source):
            fail(f"dynamic code execution found: {javascript.name}")

    validate_catalog()
    print("Extension structure and asset catalog are valid.")


def validate_catalog() -> None:
    catalog_path = EXTENSION / "assets/catalog.json"
    catalog = read_json(catalog_path)
    if catalog.get("schemaVersion") != 1:
        fail("unsupported asset catalog schema")
    assets = catalog.get("assets")
    if not isinstance(assets, list) or not assets:
        fail("asset catalog must contain at least one asset")
    ids = [asset.get("id") for asset in assets]
    if len(ids) != len(set(ids)) or None in ids:
        fail("asset ids must be present and unique")
    if catalog.get("defaultAssetId") not in ids:
        fail("defaultAssetId does not exist")

    for descriptor in assets:
        if not isinstance(descriptor.get("name"), str) or not descriptor["name"].strip():
            fail(f"asset {descriptor.get('id')} needs a display name")
        map_relative = descriptor.get("motionMap")
        if not map_relative or Path(map_relative).is_absolute() or ".." in Path(map_relative).parts:
            fail(f"unsafe motionMap path for asset {descriptor.get('id')}")
        map_path = catalog_path.parent / map_relative
        motion_map = read_json(map_path)
        validate_motion_map(descriptor, map_path, motion_map)


def validate_motion_map(descriptor: dict, map_path: Path, motion_map: dict) -> None:
    asset_id = descriptor["id"]
    if motion_map.get("schemaVersion") != 2 or motion_map.get("id") != asset_id:
        fail(f"invalid motion map identity for {asset_id}")
    if motion_map.get("entityMode") != "single-group":
        fail(f"{asset_id} must be described as one indivisible group")
    video_relative = motion_map.get("video")
    if not video_relative or Path(video_relative).is_absolute() or ".." in Path(video_relative).parts:
        fail(f"unsafe video path for {asset_id}")
    video_path = map_path.parent / video_relative
    video_available = video_path.is_file()
    if not video_available and descriptor.get("videoIncluded", True):
        fail(f"missing video for {asset_id}: {video_path.relative_to(ROOT)}")
    if not video_available:
        print(f"WARNING: local video is not installed for {asset_id}")

    segments = motion_map.get("segments")
    if not isinstance(segments, list) or not segments:
        fail(f"motion map {asset_id} has no segments")
    segment_ids = {segment.get("id") for segment in segments}
    if None in segment_ids or len(segment_ids) != len(segments):
        fail(f"segment ids must be present and unique for {asset_id}")
    if float(motion_map.get("nativeBpm", 0)) <= 0:
        fail(f"nativeBpm must be positive for {asset_id}")

    raw_exclusions = motion_map.get("excludedRanges", [])
    if not isinstance(raw_exclusions, list):
        fail(f"excludedRanges must be an array for {asset_id}")
    exclusions = []
    duration = float(motion_map.get("duration", 0))
    for excluded in raw_exclusions:
        if not isinstance(excluded, dict):
            fail(f"excludedRanges entries must be objects for {asset_id}")
        start = float(excluded.get("start", -1))
        end = float(excluded.get("end", -1))
        if start < 0 or end <= start or end > duration + 0.001:
            fail(f"invalid excluded source range for {asset_id}")
        if not excluded.get("reason"):
            fail(f"excluded source range needs a reason for {asset_id}")
        exclusions.append((start, end))
    exclusions.sort()
    for previous, current in zip(exclusions, exclusions[1:]):
        if current[0] < previous[1] - 0.001:
            fail(f"overlapping excluded source ranges for {asset_id}")

    def is_declared_gap(start: float, end: float) -> bool:
        return any(
            abs(excluded_start - start) <= 0.001
            and abs(excluded_end - end) <= 0.001
            for excluded_start, excluded_end in exclusions
        )

    total_beats = 0
    previous_end = 0.0
    observed_gaps = []
    for segment in segments:
        start = float(segment.get("sourceStart", -1))
        end = float(segment.get("sourceEnd", -1))
        beats = int(segment.get("beats", 0))
        energy = float(segment.get("energy", -1))
        next_ids = segment.get("next")
        tempo_range = segment.get("tempoRange")
        affinities = segment.get("sectionAffinity")
        if start < previous_end - 0.001 or end <= start or end > duration + 0.001:
            fail(f"invalid source range in {asset_id}/{segment.get('id')}")
        if start > previous_end + 0.001:
            if not is_declared_gap(previous_end, start):
                fail(f"undeclared source gap in {asset_id}/{segment.get('id')}")
            observed_gaps.append((previous_end, start))
        if beats <= 0:
            fail(f"beats must be positive in {asset_id}/{segment.get('id')}")
        if not 0 <= energy <= 1:
            fail(f"energy must be between 0 and 1 in {asset_id}/{segment.get('id')}")
        if not isinstance(segment.get("tags"), list):
            fail(f"tags must be an array in {asset_id}/{segment.get('id')}")
        if not isinstance(tempo_range, list) or len(tempo_range) != 2 or tempo_range[1] < tempo_range[0]:
            fail(f"tempoRange must contain an ordered pair in {asset_id}/{segment.get('id')}")
        if not isinstance(affinities, list) or not affinities:
            fail(f"sectionAffinity must be non-empty in {asset_id}/{segment.get('id')}")
        if not 0 <= float(segment.get("intensity", -1)) <= 1:
            fail(f"intensity must be between 0 and 1 in {asset_id}/{segment.get('id')}")
        if not 0 <= float(segment.get("fluidity", -1)) <= 1:
            fail(f"fluidity must be between 0 and 1 in {asset_id}/{segment.get('id')}")
        if not isinstance(segment.get("hardCutSafe"), bool):
            fail(f"hardCutSafe must be boolean in {asset_id}/{segment.get('id')}")
        if not isinstance(segment.get("loopable"), bool):
            fail(f"loopable must be boolean in {asset_id}/{segment.get('id')}")
        if int(segment.get("maxConsecutive", 0)) < 1:
            fail(f"maxConsecutive must be positive in {asset_id}/{segment.get('id')}")
        if not segment.get("entryPose") or not segment.get("exitPose"):
            fail(f"entryPose and exitPose are required in {asset_id}/{segment.get('id')}")
        if not isinstance(next_ids, list) or not next_ids:
            fail(f"next must contain at least one transition in {asset_id}/{segment.get('id')}")
        if any(next_id not in segment_ids for next_id in next_ids):
            fail(f"unknown transition target in {asset_id}/{segment.get('id')}")
        total_beats += beats
        previous_end = end

    if total_beats != motion_map.get("phraseBeats"):
        fail(f"phraseBeats mismatch for {asset_id}")
    if previous_end < duration - 0.001:
        if not is_declared_gap(previous_end, duration):
            fail(f"motion map does not cover complete video for {asset_id}")
        observed_gaps.append((previous_end, duration))
    if len(observed_gaps) != len(exclusions):
        fail(f"unused excluded source range for {asset_id}")
    reachable = {segments[0]["id"]}
    while True:
        expanded = reachable | {
            next_id
            for segment in segments
            if segment["id"] in reachable
            for next_id in segment["next"]
        }
        if expanded == reachable:
            break
        reachable = expanded
    if reachable != segment_ids:
        fail(f"unreachable motion segments for {asset_id}: {sorted(segment_ids - reachable)}")
    if video_available and video_path.stat().st_size > 8 * 1024 * 1024:
        print(f"WARNING: {asset_id} video exceeds the 8 MiB target")
    if video_available:
        validate_webm(video_path, duration, asset_id)


def validate_webm(asset: Path, expected_duration: float, asset_id: str) -> None:
    if not shutil.which("ffprobe"):
        print(f"WARNING: ffprobe is unavailable; {asset_id} metadata was not checked")
        return
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "stream=codec_name,width,height:stream_tags=alpha_mode:format=duration",
            "-of", "json", str(asset),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    metadata = json.loads(result.stdout)
    stream = metadata.get("streams", [{}])[0]
    if stream.get("codec_name") != "vp9":
        fail(f"{asset_id} must use VP9")
    if stream.get("tags", {}).get("alpha_mode") != "1":
        fail(f"{asset_id} does not declare an alpha channel")
    if stream.get("width", 0) <= 0 or stream.get("height", 0) <= 0:
        fail(f"{asset_id} has invalid dimensions")
    actual_duration = float(metadata.get("format", {}).get("duration", 0))
    if abs(actual_duration - expected_duration) > 0.05:
        fail(f"{asset_id} duration differs from its motion map")


if __name__ == "__main__":
    main()
