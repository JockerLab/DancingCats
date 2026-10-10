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
    repeat_count: int
    cost: float
    previous_key: tuple[int, str, int] | None


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
        raise RuntimeError("Rhythm analyzer found too few beats to build choreography")
    segments = {segment["id"]: segment for segment in motion_map["segments"]}
    start_index = _first_downbeat_index(analysis)
    states: dict[tuple[int, str, int], PlannedCue] = {}

    for segment in segments.values():
        cue = _candidate(None, segment, start_index, analysis)
        if cue:
            states[(cue.end_index, cue.segment_id, cue.repeat_count)] = cue

    frontier = sorted(states)
    cursor = 0
    while cursor < len(frontier):
        key = frontier[cursor]
        cursor += 1
        current = states[key]
        previous = segments[current.segment_id]
        preferred_next = set(previous.get("next", []))
        for candidate in segments.values():
            repeated = candidate["id"] == previous["id"]
            if repeated and not candidate.get("loopable", False):
                continue
            repeat_count = current.repeat_count + 1 if repeated else 1
            if repeat_count > int(candidate.get("maxConsecutive", 1)):
                continue
            preferred = candidate["id"] in preferred_next
            if not preferred and not candidate.get("hardCutSafe", True):
                continue
            transition_penalty = 0 if preferred else 0.25
            if repeated:
                transition_penalty += 0.12 * (repeat_count - 1)
            cue = _candidate(
                previous,
                candidate,
                current.end_index,
                analysis,
                current.cost + transition_penalty,
                key,
                repeat_count,
            )
            if cue is None:
                continue
            candidate_key = (cue.end_index, cue.segment_id, cue.repeat_count)
            known = states.get(candidate_key)
            if known is None or cue.cost < known.cost:
                states[candidate_key] = cue
                if candidate_key not in frontier:
                    frontier.append(candidate_key)
        frontier[cursor:] = sorted(frontier[cursor:])

    if not states:
        raise RuntimeError("No movement fits the detected beat grid")
    final_key: tuple[int, str, int] | None = min(
        states,
        key=lambda item: (-item[0], states[item].cost),
    )
    path: list[PlannedCue] = []
    while final_key is not None:
        cue = states[final_key]
        path.append(cue)
        final_key = cue.previous_key
    path.reverse()

    cues = []
    for cue in path:
        segment = segments[cue.segment_id]
        start = beats[cue.start_index]
        end = beats[cue.end_index]
        source_start, source_end, ping_pong_reverse = _playback_range(
            motion_map,
            segment,
            cue.repeat_count,
        )
        cues.append({
            "start": round(start, 6),
            "end": round(end, 6),
            "segmentId": cue.segment_id,
            "sourceStart": source_start,
            "sourceEnd": source_end,
            "playbackRate": round((segment["sourceEnd"] - segment["sourceStart"]) / (end - start), 5),
            "repeatIndex": cue.repeat_count,
            "playbackMode": "ping-pong-reverse" if ping_pong_reverse else "forward",
            "section": _section_at(analysis, start),
            "musicProfile": _music_profile_at(analysis, start),
            "motionProfile": {
                "intensity": float(segment.get("intensity", segment["energy"])),
                "fluidity": float(segment.get("fluidity", 0.5)),
                "tags": segment.get("tags", []),
                "hardCutSafe": bool(segment.get("hardCutSafe", True)),
            },
        })

    return {
        "schemaVersion": 3,
        "videoId": video_id,
        "title": title,
        "duration": analysis.duration,
        "assetId": motion_map["id"],
        "assetVersion": asset_version,
        "analyzer": "beat-this+lightweight-structure",
        "song": analysis.to_dict(),
        "effects": {
            "pulse": {
                "anchor": "all-beats",
                "events": _build_pulse_events(
                    analysis,
                    cues[0]["start"] if cues else 0,
                    cues[-1]["end"] if cues else 0,
                ),
            },
        },
        "cues": cues,
    }


def _playback_range(
    motion_map: dict[str, Any],
    segment: dict[str, Any],
    repeat_count: int,
) -> tuple[float, float, bool]:
    source_start = float(segment["sourceStart"])
    source_end = float(segment["sourceEnd"])
    ping_pong_reverse = bool(
        repeat_count > 1
        and repeat_count % 2 == 0
        and segment.get("pingPongSafe", False)
        and motion_map.get("reverseOffset") is not None
    )
    if not ping_pong_reverse:
        return source_start, source_end, False
    forward_duration = float(motion_map["duration"])
    reverse_offset = float(motion_map["reverseOffset"])
    return (
        round(reverse_offset + forward_duration - source_end, 6),
        round(reverse_offset + forward_duration - source_start, 6),
        True,
    )


def _build_pulse_events(
    analysis: SongAnalysis,
    start: float,
    end: float,
) -> list[dict[str, Any]]:
    events = []
    section_multipliers = {
        "intro": 0.58,
        "verse": 0.76,
        "bridge": 0.88,
        "chorus": 1.16,
        "drop": 1.24,
        "solo": 1.08,
        "inst": 1.0,
        "outro": 0.68,
        "end": 0.55,
    }
    beat_multipliers = {
        1: 1.0,
        2: 0.38,
        3: 0.58,
        4: 0.38,
    }
    for index, (beat, position) in enumerate(zip(analysis.beats, analysis.beat_positions)):
        if beat < start - 1e-6 or beat >= end - 1e-6:
            continue
        profile = _music_profile_at(analysis, beat)
        section = _section_at(analysis, beat)
        loudness = float(profile["energy"])
        dynamics = float(profile["dynamics"])
        onset_density = float(profile["onsetDensity"])
        energy_score = min(1, max(0, loudness * 0.5 + dynamics * 0.3 + onset_density * 0.2))
        section_multiplier = section_multipliers.get(section, 0.9)
        strong_amplitude = min(0.1, max(0.01, 0.008 + energy_score * 0.074 * section_multiplier))
        beat_multiplier = beat_multipliers.get(position, 0.38)
        amplitude = max(0.004, strong_amplitude * beat_multiplier)
        next_beat = analysis.beats[index + 1] if index + 1 < len(analysis.beats) else beat + 0.5
        beat_interval = max(0.2, next_beat - beat)
        events.append({
            "time": round(beat, 6),
            "amplitude": round(amplitude, 4),
            "attack": round(min(0.07, beat_interval * 0.12), 4),
            "release": round(min(0.34, max(0.14, beat_interval * 0.55)), 4),
            "beatPosition": position,
            "section": section,
            "energy": round(energy_score, 4),
            "loudness": round(loudness, 4),
        })
    return events


def _candidate(
    previous: dict[str, Any] | None,
    segment: dict[str, Any],
    start_index: int,
    analysis: SongAnalysis,
    base_cost: float = 0,
    previous_key: tuple[int, str, int] | None = None,
    repeat_count: int = 1,
) -> PlannedCue | None:
    end_index = start_index + int(segment["beats"])
    if end_index >= len(analysis.beats):
        return None
    music_duration = analysis.beats[end_index] - analysis.beats[start_index]
    if music_duration <= 0:
        return None
    source_duration = float(segment["sourceEnd"]) - float(segment["sourceStart"])
    rate = source_duration / music_duration
    profile = _music_profile_at(analysis, analysis.beats[start_index])
    energy = float(profile["energy"])
    dynamics = float(profile["dynamics"])
    onset_density = float(profile["onsetDensity"])
    target_intensity = min(1, max(0, energy * 0.55 + dynamics * 0.25 + onset_density * 0.2))
    cost = base_cost + abs(float(segment["energy"]) - energy) * 2.5
    cost += abs(float(segment.get("intensity", segment["energy"])) - target_intensity) * 2.25
    target_fluidity = min(
        0.95,
        max(
            0.15,
            0.95
            - dynamics * 0.42
            - onset_density * 0.28
            - max(0, analysis.bpm - 100) / 300,
        ),
    )
    cost += abs(float(segment.get("fluidity", 0.5)) - target_fluidity) * 0.8
    tempo_min, tempo_max = segment.get("tempoRange", [0, float("inf")])
    if analysis.bpm < float(tempo_min):
        cost += (float(tempo_min) - analysis.bpm) / 40
    elif analysis.bpm > float(tempo_max):
        cost += (analysis.bpm - float(tempo_max)) / 40
    section = _section_at(analysis, analysis.beats[start_index])
    affinities = segment.get("sectionAffinity", [])
    if affinities and section not in affinities:
        cost += 0.45
    tags = set(segment.get("tags", []))
    if profile["trend"] == "rising" and "rise" in tags:
        cost -= 0.18
    elif profile["trend"] == "falling" and "smooth" in tags:
        cost -= 0.12
    if onset_density >= 0.72 and "accent" in tags:
        cost -= 0.16
    cost += abs(math.log(max(rate, 1e-6))) * 0.35
    if rate < 0.25 or rate > 4:
        cost += 25 + abs(rate - min(4, max(0.25, rate))) * 10
    if previous:
        if previous.get("exitPose") != segment.get("entryPose"):
            cost += 0.08
    return PlannedCue(
        start_index,
        end_index,
        segment["id"],
        repeat_count,
        cost,
        previous_key,
    )


def _first_downbeat_index(analysis: SongAnalysis) -> int:
    for index, position in enumerate(analysis.beat_positions):
        if position == 1:
            return index
    return 0


def _music_profile_at(analysis: SongAnalysis, time: float) -> dict[str, float | str]:
    for bar in analysis.bars or []:
        if bar.start <= time < bar.end:
            return {
                "energy": bar.energy,
                "dynamics": bar.dynamics,
                "onsetDensity": bar.onset_density,
                "spectralChange": bar.spectral_change,
                "trend": bar.trend,
            }
    for segment in analysis.segments:
        if segment.start <= time < segment.end:
            return {
                "energy": segment.energy,
                "dynamics": segment.dynamics,
                "onsetDensity": segment.onset_density,
                "spectralChange": segment.spectral_change,
                "trend": segment.trend,
            }
    segment = analysis.segments[-1]
    return {
        "energy": segment.energy,
        "dynamics": segment.dynamics,
        "onsetDensity": segment.onset_density,
        "spectralChange": segment.spectral_change,
        "trend": segment.trend,
    }


def _section_at(analysis: SongAnalysis, time: float) -> str:
    for segment in analysis.segments:
        if segment.start <= time < segment.end:
            return segment.label
    return analysis.segments[-1].label
