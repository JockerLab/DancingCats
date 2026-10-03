from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .analyzer import SongAnalysis


@dataclass(frozen=True)
class PlannedCue:
    start_index: int
    end_index: int
    segment_id: str
    cost: float
    previous_key: tuple[int, str] | None


def load_motion_map(assets_dir: Path, asset_id: str) -> tuple[dict[str, Any], str]:
    catalog_path = assets_dir / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    descriptor = next((item for item in catalog["assets"] if item["id"] == asset_id), None)
    if descriptor is None:
        raise ValueError(f"Unknown asset: {asset_id}")
    map_path = (catalog_path.parent / descriptor["motionMap"]).resolve()
    if assets_dir.resolve() not in map_path.parents:
        raise ValueError("Motion map escapes the assets directory")
    payload = map_path.read_bytes()
    return json.loads(payload), hashlib.sha256(payload).hexdigest()[:12]


def build_choreography(
    analysis: SongAnalysis,
    motion_map: dict[str, Any],
    *,
    video_id: str,
    title: str,
    asset_version: str,
) -> dict[str, Any]:
    beats = analysis.beats
    if len(beats) < 9:
        raise RuntimeError("All-In-One found too few beats to build choreography")
    segments = {segment["id"]: segment for segment in motion_map["segments"]}
    start_index = _first_downbeat_index(analysis)
    states: dict[tuple[int, str], PlannedCue] = {}

    for segment in segments.values():
        cue = _candidate(None, segment, start_index, analysis)
        if cue:
            states[(cue.end_index, cue.segment_id)] = cue

    frontier = sorted(states)
    cursor = 0
    while cursor < len(frontier):
        key = frontier[cursor]
        cursor += 1
        current = states[key]
        previous = segments[current.segment_id]
        preferred_next = set(previous.get("next", []))
        candidates = list(segments.values())
        if len(candidates) > 1:
            candidates = [item for item in candidates if item["id"] != previous["id"]]
        for candidate in candidates:
            transition_penalty = 0 if candidate["id"] in preferred_next else 0.12
            cue = _candidate(
                previous,
                candidate,
                current.end_index,
                analysis,
                current.cost + transition_penalty,
                key,
            )
            if cue is None:
                continue
            candidate_key = (cue.end_index, cue.segment_id)
            known = states.get(candidate_key)
            if known is None or cue.cost < known.cost:
                states[candidate_key] = cue
                if candidate_key not in frontier:
                    frontier.append(candidate_key)
        frontier[cursor:] = sorted(frontier[cursor:])

    if not states:
        raise RuntimeError("No movement fits the detected beat grid")
    final_key = min(states, key=lambda item: (-item[0], states[item].cost))
    path: list[PlannedCue] = []
    while final_key is not None:
        cue = states[final_key]
        path.append(cue)
        final_key = cue.previous_key
    path.reverse()

    cues = []
    for index, cue in enumerate(path):
        segment = segments[cue.segment_id]
        start = beats[cue.start_index]
        end = beats[cue.end_index]
        energy = _energy_at(analysis, start)
        is_downbeat = analysis.beat_positions[cue.start_index] == 1
        cues.append({
            "start": round(start, 6),
            "end": round(end, 6),
            "segmentId": cue.segment_id,
            "sourceStart": segment["sourceStart"],
            "sourceEnd": segment["sourceEnd"],
            "playbackRate": round((segment["sourceEnd"] - segment["sourceStart"]) / (end - start), 5),
            "mirror": bool(index % 2 and energy >= 0.5 and is_downbeat),
            "scale": {
                "base": round(0.96 + energy * 0.09, 4),
                "pulse": round(0.025 + energy * (0.085 if is_downbeat else 0.055), 4),
            },
            "section": _section_at(analysis, start),
        })

    return {
        "schemaVersion": 1,
        "videoId": video_id,
        "title": title,
        "duration": analysis.duration,
        "assetId": motion_map["id"],
        "assetVersion": asset_version,
        "analyzer": "all-in-one",
        "song": analysis.to_dict(),
        "cues": cues,
    }


def _candidate(
    previous: dict[str, Any] | None,
    segment: dict[str, Any],
    start_index: int,
    analysis: SongAnalysis,
    base_cost: float = 0,
    previous_key: tuple[int, str] | None = None,
) -> PlannedCue | None:
    end_index = start_index + int(segment["beats"])
    if end_index >= len(analysis.beats):
        return None
    music_duration = analysis.beats[end_index] - analysis.beats[start_index]
    if music_duration <= 0:
        return None
    source_duration = float(segment["sourceEnd"]) - float(segment["sourceStart"])
    rate = source_duration / music_duration
    energy = _energy_at(analysis, analysis.beats[start_index])
    cost = base_cost + abs(float(segment["energy"]) - energy) * 4
    cost += abs(math.log(max(rate, 1e-6))) * 0.35
    if rate < 0.55 or rate > 1.8:
        cost += 25 + abs(rate - min(1.8, max(0.55, rate))) * 10
    if previous:
        if previous.get("exitPose") != segment.get("entryPose"):
            cost += 0.08
    return PlannedCue(start_index, end_index, segment["id"], cost, previous_key)


def _first_downbeat_index(analysis: SongAnalysis) -> int:
    for index, position in enumerate(analysis.beat_positions):
        if position == 1:
            return index
    return 0


def _energy_at(analysis: SongAnalysis, time: float) -> float:
    for segment in analysis.segments:
        if segment.start <= time < segment.end:
            return segment.energy
    return analysis.segments[-1].energy


def _section_at(analysis: SongAnalysis, time: float) -> str:
    for segment in analysis.segments:
        if segment.start <= time < segment.end:
            return segment.label
    return analysis.segments[-1].label
