from __future__ import annotations

import math
import logging
import os
import threading
import wave
from array import array
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


LOGGER = logging.getLogger(__name__)
DEFAULT_MODEL = "harmonix-fold0"
_SESSION = None
_SESSION_LOCK = threading.Lock()


@dataclass(frozen=True)
class SongSegment:
    start: float
    end: float
    label: str
    energy: float


@dataclass(frozen=True)
class SongAnalysis:
    bpm: float
    beats: list[float]
    downbeats: list[float]
    beat_positions: list[int]
    segments: list[SongSegment]
    duration: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "bpm": self.bpm,
            "beats": self.beats,
            "downbeats": self.downbeats,
            "beatPositions": self.beat_positions,
            "segments": [asdict(segment) for segment in self.segments],
            "duration": self.duration,
        }


def analyzer_model_name() -> str:
    return os.getenv("DANCING_CATS_ANALYZER_MODEL", DEFAULT_MODEL)


def warm_up_analyzer() -> None:
    allin1 = _import_all_in_one()
    session = _get_session(allin1)
    if session is None:
        LOGGER.info(
            "All-In-One reusable sessions are unavailable; model %s will load per job",
            analyzer_model_name(),
        )
    else:
        LOGGER.info("All-In-One model %s is ready", analyzer_model_name())


def analyze_with_all_in_one(wav_path: Path) -> SongAnalysis:
    allin1 = _import_all_in_one()
    session = _get_session(allin1)
    if session is not None:
        result = session.infer(str(wav_path))
    else:
        result = allin1.analyze(str(wav_path), model=analyzer_model_name())

    return _normalize_analysis(result, wav_path)


def _import_all_in_one():
    try:
        import allin1_infer as allin1
    except ImportError:
        try:
            import allin1
        except ImportError as error:
            raise RuntimeError(
                "All-In-One is not installed. Use the Docker image or install the analysis extra."
            ) from error
    return allin1


def _get_session(allin1):
    global _SESSION
    session_class = getattr(allin1, "AllInOneSession", None)
    if session_class is None:
        return None
    with _SESSION_LOCK:
        if _SESSION is None:
            LOGGER.info("Loading reusable All-In-One model %s", analyzer_model_name())
            session = session_class(model=analyzer_model_name())
            session.load()
            _SESSION = session
        return _SESSION


def _normalize_analysis(result, wav_path: Path) -> SongAnalysis:
    beats = [round(float(value), 6) for value in result.beats]
    raw_positions = list(getattr(result, "beat_positions", []))
    beat_positions = [int(value) for value in raw_positions]
    if len(beat_positions) != len(beats):
        beat_positions = [index % 4 + 1 for index in range(len(beats))]
    downbeats = [round(float(value), 6) for value in getattr(result, "downbeats", [])]
    duration, energy_reader = _load_wav_energy(wav_path)
    raw_segments = list(getattr(result, "segments", []))
    segments = [
        SongSegment(
            start=round(float(segment.start), 6),
            end=round(float(segment.end), 6),
            label=str(segment.label),
            energy=energy_reader(float(segment.start), float(segment.end)),
        )
        for segment in raw_segments
        if float(segment.end) > float(segment.start)
    ]
    if not segments:
        segments = [SongSegment(start=0, end=duration, label="unknown", energy=0.5)]
    return SongAnalysis(
        bpm=round(float(result.bpm), 3),
        beats=beats,
        downbeats=downbeats,
        beat_positions=beat_positions,
        segments=segments,
        duration=round(duration, 6),
    )


def _load_wav_energy(wav_path: Path):
    with wave.open(str(wav_path), "rb") as audio:
        if audio.getsampwidth() != 2 or audio.getnchannels() != 1:
            raise RuntimeError("Expected mono 16-bit PCM from FFmpeg")
        sample_rate = audio.getframerate()
        samples = array("h", audio.readframes(audio.getnframes()))
    if samples.itemsize != 2:
        raise RuntimeError("Unexpected PCM sample width")
    duration = len(samples) / sample_rate

    windows: list[float] = []
    window_size = max(1, sample_rate // 2)
    for offset in range(0, len(samples), window_size):
        chunk = samples[offset:offset + window_size]
        if not chunk:
            continue
        mean_square = sum(value * value for value in chunk) / len(chunk)
        windows.append(math.sqrt(mean_square) / 32768)
    reference = _percentile(windows, 0.9) or 1

    def energy(start: float, end: float) -> float:
        left = max(0, int(start * 2))
        right = min(len(windows), max(left + 1, math.ceil(end * 2)))
        selected = windows[left:right]
        if not selected:
            return 0
        rms = math.sqrt(sum(value * value for value in selected) / len(selected))
        return round(min(1, max(0, rms / reference)), 4)

    return duration, energy


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * fraction))
    return ordered[index]
