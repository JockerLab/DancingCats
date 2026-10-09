from __future__ import annotations

import logging
import math
import os
import threading
import time
from io import BytesIO
from dataclasses import dataclass
from pathlib import Path
from typing import Any


LOGGER = logging.getLogger(__name__)
DEFAULT_RHYTHM_MODEL = "small0"
_RHYTHM_ANALYZER = None
_RHYTHM_ANALYZER_LOCK = threading.Lock()
_AUDIO_STACK_WARM = False
_AUDIO_STACK_LOCK = threading.Lock()


@dataclass(frozen=True)
class SongBar:
    start: float
    end: float
    energy: float
    dynamics: float
    onset_density: float
    spectral_change: float
    trend: str


@dataclass(frozen=True)
class SongSegment:
    start: float
    end: float
    label: str
    energy: float
    dynamics: float = 0.5
    onset_density: float = 0.5
    spectral_change: float = 0.5
    trend: str = "stable"
    pattern_id: str = "A"
    repetition_index: int = 1
    label_confidence: float = 0.5


@dataclass(frozen=True)
class SongAnalysis:
    bpm: float
    beats: list[float]
    downbeats: list[float]
    beat_positions: list[int]
    segments: list[SongSegment]
    duration: float
    bars: list[SongBar] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "bpm": self.bpm,
            "beats": self.beats,
            "downbeats": self.downbeats,
            "beatPositions": self.beat_positions,
            "segments": [
                {
                    "start": segment.start,
                    "end": segment.end,
                    "label": segment.label,
                    "energy": segment.energy,
                    "dynamics": segment.dynamics,
                    "onsetDensity": segment.onset_density,
                    "spectralChange": segment.spectral_change,
                    "trend": segment.trend,
                    "patternId": segment.pattern_id,
                    "repetitionIndex": segment.repetition_index,
                    "labelConfidence": segment.label_confidence,
                }
                for segment in self.segments
            ],
            "bars": [
                {
                    "start": bar.start,
                    "end": bar.end,
                    "energy": bar.energy,
                    "dynamics": bar.dynamics,
                    "onsetDensity": bar.onset_density,
                    "spectralChange": bar.spectral_change,
                    "trend": bar.trend,
                }
                for bar in (self.bars or [])
            ],
            "duration": self.duration,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "SongAnalysis":
        """Restore a cached track analysis without running the ML model again."""
        return cls(
            bpm=float(payload["bpm"]),
            beats=[float(value) for value in payload["beats"]],
            downbeats=[float(value) for value in payload["downbeats"]],
            beat_positions=[int(value) for value in payload["beatPositions"]],
            segments=[
                SongSegment(
                    start=float(segment["start"]),
                    end=float(segment["end"]),
                    label=str(segment["label"]),
                    energy=float(segment["energy"]),
                    dynamics=float(segment.get("dynamics", 0.5)),
                    onset_density=float(segment.get("onsetDensity", 0.5)),
                    spectral_change=float(segment.get("spectralChange", 0.5)),
                    trend=str(segment.get("trend", "stable")),
                    pattern_id=str(segment.get("patternId", "A")),
                    repetition_index=int(segment.get("repetitionIndex", 1)),
                    label_confidence=float(segment.get("labelConfidence", 0.5)),
                )
                for segment in payload["segments"]
            ],
            duration=float(payload["duration"]),
            bars=[
                SongBar(
                    start=float(bar["start"]),
                    end=float(bar["end"]),
                    energy=float(bar["energy"]),
                    dynamics=float(bar["dynamics"]),
                    onset_density=float(bar["onsetDensity"]),
                    spectral_change=float(bar["spectralChange"]),
                    trend=str(bar["trend"]),
                )
                for bar in payload.get("bars", [])
            ],
        )


def analyzer_model_name() -> str:
    model = os.getenv("DANCING_CATS_RHYTHM_MODEL", DEFAULT_RHYTHM_MODEL)
    return f"beat-this-{model}+structure-v1"


def warm_up_analyzer() -> None:
    started_at = time.perf_counter()
    _get_rhythm_analyzer()
    _warm_up_audio_stack()
    LOGGER.info(
        "Analyzer %s warmed in %.2fs",
        analyzer_model_name(),
        time.perf_counter() - started_at,
    )


def analyze_music(wav_path: Path) -> SongAnalysis:
    _warm_up_audio_stack()
    try:
        import librosa
        import numpy as np
    except ImportError as error:
        raise RuntimeError(
            "The lightweight analyzer is not installed. Use the Docker image or install the analysis extra."
        ) from error

    stage_started_at = time.perf_counter()
    signal, sample_rate = librosa.load(wav_path, sr=22050, mono=True, dtype=np.float32)
    duration = float(librosa.get_duration(y=signal, sr=sample_rate))
    LOGGER.info("Loaded %.1fs audio in %.2fs", duration, time.perf_counter() - stage_started_at)

    stage_started_at = time.perf_counter()
    beat_values, downbeat_values = _get_rhythm_analyzer()(signal, sample_rate)
    beats = _clean_times(beat_values, duration)
    downbeats = _clean_times(downbeat_values, duration)
    if len(beats) < 9:
        raise RuntimeError("Beat tracker found too few beats to build choreography")
    LOGGER.info(
        "Detected %d beats and %d downbeats in %.2fs",
        len(beats),
        len(downbeats),
        time.perf_counter() - stage_started_at,
    )

    stage_started_at = time.perf_counter()
    bpm = _estimate_bpm(beats)
    beat_positions = _infer_beat_positions(beats, downbeats)
    bars, segments = _analyze_structure(
        signal,
        sample_rate,
        duration,
        beats,
        downbeats,
        beat_positions,
        librosa,
        np,
    )
    LOGGER.info(
        "Extracted %d bars and %d structural sections in %.2fs",
        len(bars),
        len(segments),
        time.perf_counter() - stage_started_at,
    )
    return SongAnalysis(
        bpm=round(bpm, 3),
        beats=beats,
        downbeats=downbeats,
        beat_positions=beat_positions,
        segments=segments,
        duration=round(duration, 6),
        bars=bars,
    )


def _get_rhythm_analyzer():
    global _RHYTHM_ANALYZER
    with _RHYTHM_ANALYZER_LOCK:
        if _RHYTHM_ANALYZER is None:
            try:
                from beat_this.inference import Audio2Beats
            except ImportError as error:
                raise RuntimeError(
                    "beat-this is not installed. Use the Docker image or install the analysis extra."
                ) from error
            model = os.getenv("DANCING_CATS_RHYTHM_MODEL", DEFAULT_RHYTHM_MODEL)
            LOGGER.info("Loading reusable Beat This! model %s", model)
            _RHYTHM_ANALYZER = Audio2Beats(
                checkpoint_path=model,
                device="cpu",
                float16=False,
                dbn=False,
            )
        return _RHYTHM_ANALYZER


def _warm_up_audio_stack() -> None:
    """Pay librosa's lazy-import/JIT cost while the backend starts."""
    global _AUDIO_STACK_WARM
    if _AUDIO_STACK_WARM:
        return
    with _AUDIO_STACK_LOCK:
        if _AUDIO_STACK_WARM:
            return
        try:
            import librosa
            import numpy as np
            import soundfile
        except ImportError as error:
            raise RuntimeError(
                "The lightweight analyzer is not installed. Use the Docker image or install the analysis extra."
            ) from error

        sample_rate = 22050
        time_axis = np.arange(sample_rate * 2, dtype=np.float32) / sample_rate
        signal = (0.05 * np.sin(2 * np.pi * 220 * time_axis)).astype(np.float32)
        signal[:: sample_rate // 2] += 0.5
        buffer = BytesIO()
        soundfile.write(buffer, signal, sample_rate, format="WAV", subtype="PCM_16")
        buffer.seek(0)
        loaded, loaded_rate = librosa.load(buffer, sr=sample_rate, mono=True, dtype=np.float32)
        librosa.feature.rms(y=loaded, frame_length=2048, hop_length=512)
        librosa.onset.onset_strength(y=loaded, sr=loaded_rate, hop_length=512)
        librosa.feature.chroma_stft(y=loaded, sr=loaded_rate, n_fft=2048, hop_length=512)
        librosa.feature.mfcc(y=loaded, sr=loaded_rate, n_mfcc=8, n_fft=2048, hop_length=512)
        librosa.feature.spectral_centroid(
            y=loaded, sr=loaded_rate, n_fft=2048, hop_length=512
        )
        _AUDIO_STACK_WARM = True


def _clean_times(values, duration: float) -> list[float]:
    return sorted({
        round(float(value), 6)
        for value in values
        if math.isfinite(float(value)) and 0 <= float(value) <= duration
    })


def _estimate_bpm(beats: list[float]) -> float:
    intervals = [
        right - left
        for left, right in zip(beats, beats[1:])
        if 0.2 <= right - left <= 2.0
    ]
    if not intervals:
        return 120.0
    ordered = sorted(intervals)
    return 60.0 / ordered[len(ordered) // 2]


def _infer_beat_positions(beats: list[float], downbeats: list[float]) -> list[int]:
    downbeat_indices = []
    for downbeat in downbeats:
        nearest = min(range(len(beats)), key=lambda index: abs(beats[index] - downbeat))
        if abs(beats[nearest] - downbeat) <= 0.12:
            downbeat_indices.append(nearest)
    downbeat_indices = sorted(set(downbeat_indices))
    meters = [
        right - left
        for left, right in zip(downbeat_indices, downbeat_indices[1:])
        if 2 <= right - left <= 8
    ]
    meter = sorted(meters)[len(meters) // 2] if meters else 4
    anchor = downbeat_indices[0] if downbeat_indices else 0
    positions = [((index - anchor) % meter) + 1 for index in range(len(beats))]
    for index in downbeat_indices:
        positions[index] = 1
    return positions


def _analyze_structure(
    signal,
    sample_rate: int,
    duration: float,
    beats: list[float],
    downbeats: list[float],
    beat_positions: list[int],
    librosa,
    np,
) -> tuple[list[SongBar], list[SongSegment]]:
    hop_length = 512
    rms = librosa.feature.rms(y=signal, frame_length=2048, hop_length=hop_length)[0]
    onset = librosa.onset.onset_strength(y=signal, sr=sample_rate, hop_length=hop_length)
    chroma = librosa.feature.chroma_stft(
        y=signal, sr=sample_rate, n_fft=2048, hop_length=hop_length
    )
    mfcc = librosa.feature.mfcc(
        y=signal, sr=sample_rate, n_mfcc=8, n_fft=2048, hop_length=hop_length
    )[1:]
    centroid = librosa.feature.spectral_centroid(
        y=signal, sr=sample_rate, n_fft=2048, hop_length=hop_length
    )[0]
    frame_count = min(len(rms), len(onset), chroma.shape[1], mfcc.shape[1], len(centroid))
    frame_times = librosa.frames_to_time(
        np.arange(frame_count), sr=sample_rate, hop_length=hop_length
    )

    boundaries = _bar_boundaries(duration, beats, downbeats, beat_positions)
    raw_energy = []
    raw_onset = []
    raw_centroid = []
    harmonic_features = []
    for start, end in zip(boundaries, boundaries[1:]):
        left = int(np.searchsorted(frame_times, start, side="left"))
        right = int(np.searchsorted(frame_times, end, side="left"))
        right = min(frame_count, max(left + 1, right))
        raw_energy.append(float(np.sqrt(np.mean(np.square(rms[left:right])))))
        raw_onset.append(float(np.mean(onset[left:right])))
        raw_centroid.append(float(np.mean(centroid[left:right])))
        harmonic_features.append(np.concatenate((
            np.mean(chroma[:, left:right], axis=1),
            np.mean(mfcc[:, left:right], axis=1),
        )))

    energy = _robust_unit(raw_energy, np)
    onset_density = _robust_unit(raw_onset, np)
    brightness = _robust_unit(raw_centroid, np)
    harmonic = _standardize_columns(np.asarray(harmonic_features, dtype=np.float32), np)
    structure_features = np.column_stack((harmonic, energy, onset_density, brightness))
    structure_features = _smooth_rows(structure_features, np)
    novelty = np.zeros(len(structure_features), dtype=np.float32)
    if len(structure_features) > 1:
        novelty[1:] = np.linalg.norm(np.diff(structure_features, axis=0), axis=1)
    novelty_unit = _robust_unit(novelty.tolist(), np)

    bars = []
    for index, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
        bars.append(SongBar(
            start=round(start, 6),
            end=round(end, 6),
            energy=round(float(energy[index]), 4),
            dynamics=round(float((onset_density[index] + novelty_unit[index]) / 2), 4),
            onset_density=round(float(onset_density[index]), 4),
            spectral_change=round(float(novelty_unit[index]), 4),
            trend=_trend_at(energy, index),
        ))

    section_slices = _section_slices(novelty, len(bars), duration)
    pattern_ids = _cluster_sections(section_slices, structure_features, np)
    labels, confidences = _label_sections(section_slices, pattern_ids, bars)
    repetition_counts: dict[str, int] = {}
    segments = []
    for index, ((left, right), pattern_id) in enumerate(zip(section_slices, pattern_ids)):
        repetition_counts[pattern_id] = repetition_counts.get(pattern_id, 0) + 1
        selected = bars[left:right]
        segments.append(SongSegment(
            start=selected[0].start,
            end=selected[-1].end,
            label=labels[index],
            energy=round(sum(bar.energy for bar in selected) / len(selected), 4),
            dynamics=round(sum(bar.dynamics for bar in selected) / len(selected), 4),
            onset_density=round(sum(bar.onset_density for bar in selected) / len(selected), 4),
            spectral_change=round(sum(bar.spectral_change for bar in selected) / len(selected), 4),
            trend=_section_trend(selected),
            pattern_id=pattern_id,
            repetition_index=repetition_counts[pattern_id],
            label_confidence=confidences[index],
        ))
    return bars, segments


def _bar_boundaries(
    duration: float,
    beats: list[float],
    downbeats: list[float],
    beat_positions: list[int],
) -> list[float]:
    candidates = downbeats or [
        beat for beat, position in zip(beats, beat_positions) if position == 1
    ]
    boundaries = [0.0]
    boundaries.extend(value for value in candidates if 0.1 < value < duration - 0.1)
    if duration > boundaries[-1] + 0.1:
        boundaries.append(duration)
    boundaries = sorted(set(boundaries))
    if len(boundaries) >= 3:
        return boundaries
    boundaries = [0.0]
    boundaries.extend(beats[index] for index in range(0, len(beats), 4) if beats[index] > 0.1)
    boundaries.append(duration)
    return sorted(set(boundaries))


def _robust_unit(values: list[float], np):
    array = np.asarray(values, dtype=np.float32)
    if not len(array):
        return array
    low, high = np.percentile(array, [10, 90])
    if high - low < 1e-8:
        return np.full_like(array, 0.5)
    return np.clip((array - low) / (high - low), 0, 1)


def _standardize_columns(matrix, np):
    if not len(matrix):
        return matrix
    mean = np.mean(matrix, axis=0, keepdims=True)
    deviation = np.std(matrix, axis=0, keepdims=True)
    deviation[deviation < 1e-6] = 1
    return (matrix - mean) / deviation


def _smooth_rows(matrix, np):
    if len(matrix) < 3:
        return matrix
    padded = np.pad(matrix, ((1, 1), (0, 0)), mode="edge")
    return (padded[:-2] + padded[1:-1] * 2 + padded[2:]) / 4


def _section_slices(novelty, bar_count: int, duration: float) -> list[tuple[int, int]]:
    if bar_count <= 4:
        return [(0, bar_count)]
    desired_sections = min(12, max(3, round(duration / 25)))
    min_bars = 3 if bar_count < 32 else 4
    candidates = sorted(range(1, bar_count), key=lambda index: float(novelty[index]), reverse=True)
    boundaries = [0, bar_count]
    for candidate in candidates:
        if all(abs(candidate - boundary) >= min_bars for boundary in boundaries):
            boundaries.append(candidate)
            if len(boundaries) >= desired_sections + 1:
                break
    boundaries.sort()
    return list(zip(boundaries, boundaries[1:]))


def _cluster_sections(section_slices, features, np) -> list[str]:
    centroids = []
    lengths = []
    pattern_ids = []
    for left, right in section_slices:
        vector = np.mean(features[left:right], axis=0)
        length = right - left
        best_index = None
        best_similarity = -1.0
        for index, known in enumerate(centroids):
            denominator = float(np.linalg.norm(vector) * np.linalg.norm(known))
            similarity = float(np.dot(vector, known) / denominator) if denominator else 0.0
            length_ratio = min(length, lengths[index]) / max(length, lengths[index])
            if length_ratio >= 0.55 and similarity > best_similarity:
                best_index = index
                best_similarity = similarity
        if best_index is not None and best_similarity >= 0.72:
            pattern_ids.append(_pattern_name(best_index))
            centroids[best_index] = (centroids[best_index] + vector) / 2
            lengths[best_index] = round((lengths[best_index] + length) / 2)
        else:
            pattern_ids.append(_pattern_name(len(centroids)))
            centroids.append(vector)
            lengths.append(length)
    return pattern_ids


def _pattern_name(index: int) -> str:
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return alphabet[index] if index < len(alphabet) else f"S{index + 1}"


def _label_sections(section_slices, pattern_ids: list[str], bars: list[SongBar]):
    pattern_stats: dict[str, dict[str, float]] = {}
    for (left, right), pattern_id in zip(section_slices, pattern_ids):
        selected = bars[left:right]
        stats = pattern_stats.setdefault(pattern_id, {"count": 0, "energy": 0, "dynamics": 0})
        stats["count"] += 1
        stats["energy"] += sum(bar.energy for bar in selected) / len(selected)
        stats["dynamics"] += sum(bar.dynamics for bar in selected) / len(selected)
    for stats in pattern_stats.values():
        stats["energy"] /= stats["count"]
        stats["dynamics"] /= stats["count"]

    repeated = [item for item in pattern_stats.items() if item[1]["count"] >= 2]
    chorus_pattern = max(
        repeated,
        key=lambda item: item[1]["energy"] * 0.65 + item[1]["dynamics"] * 0.35,
        default=(None, {}),
    )[0]
    verse_candidates = [item for item in repeated if item[0] != chorus_pattern]
    verse_pattern = max(verse_candidates, key=lambda item: item[1]["count"], default=(None, {}))[0]

    labels = []
    confidences = []
    last_index = len(section_slices) - 1
    for index, ((_left, _right), pattern_id) in enumerate(zip(section_slices, pattern_ids)):
        stats = pattern_stats[pattern_id]
        if index == 0 and stats["count"] == 1:
            label, confidence = "intro", 0.72
        elif index == last_index and stats["count"] == 1:
            label, confidence = "outro", 0.68
        elif pattern_id == chorus_pattern:
            label, confidence = "chorus", 0.76
        elif pattern_id == verse_pattern:
            label, confidence = "verse", 0.7
        elif stats["count"] == 1 and 0 < index < last_index:
            label, confidence = "bridge", 0.56
        else:
            label, confidence = "inst", 0.48
        labels.append(label)
        confidences.append(confidence)
    return labels, confidences


def _trend_at(values, index: int) -> str:
    left = float(values[max(0, index - 1)])
    right = float(values[min(len(values) - 1, index + 1)])
    delta = right - left
    if delta > 0.12:
        return "rising"
    if delta < -0.12:
        return "falling"
    return "stable"


def _section_trend(bars: list[SongBar]) -> str:
    if len(bars) < 2:
        return bars[0].trend
    delta = bars[-1].energy - bars[0].energy
    if delta > 0.12:
        return "rising"
    if delta < -0.12:
        return "falling"
    return "stable"
