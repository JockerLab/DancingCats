from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlparse


VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}


@dataclass(frozen=True)
class DownloadedAudio:
    video_id: str
    title: str
    duration: float
    wav_path: Path


def extract_video_id(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError("Only public HTTPS YouTube URLs are accepted")
    if parsed.hostname == "youtu.be":
        candidate = parsed.path.strip("/").split("/", 1)[0]
    elif parsed.path == "/watch":
        candidate = parse_qs(parsed.query).get("v", [""])[0]
    elif parsed.path.startswith("/shorts/"):
        candidate = parsed.path.split("/", 3)[2]
    else:
        raise ValueError("Expected a YouTube watch, shorts, or youtu.be URL")
    if not VIDEO_ID.fullmatch(candidate):
        raise ValueError("Invalid YouTube video id")
    return candidate


def download_audio(raw_url: str, destination: Path, max_duration: int) -> DownloadedAudio:
    try:
        import yt_dlp
    except ImportError as error:
        raise RuntimeError("yt-dlp is not installed; install the backend dependencies") from error

    expected_id = extract_video_id(raw_url)
    destination.mkdir(parents=True, exist_ok=True)

    def reject_long_video(info: dict, *, incomplete: bool) -> str | None:
        duration = info.get("duration")
        if duration and float(duration) > max_duration:
            return f"Video exceeds the {max_duration}-second local limit"
        return None

    options = {
        "format": "bestaudio/best",
        "outtmpl": str(destination / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "match_filter": reject_long_video,
    }
    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info(raw_url, download=True)
        if not info:
            raise RuntimeError("yt-dlp rejected the video")
        if info.get("_type") == "playlist":
            raise ValueError("Playlists are not supported")
        if info.get("id") != expected_id:
            raise RuntimeError("Downloaded video id does not match the request")
        source = Path(downloader.prepare_filename(info))

    wav_path = destination / "audio.wav"
    conversion = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-vn", "-ac", "1", "-ar", "44100",
            "-c:a", "pcm_s16le", str(wav_path),
        ],
        capture_output=True,
        text=True,
    )
    if conversion.returncode:
        raise RuntimeError(f"FFmpeg failed: {conversion.stderr.strip()[-500:]}")
    return DownloadedAudio(
        video_id=expected_id,
        title=str(info.get("title") or expected_id),
        duration=float(info.get("duration") or 0),
        wav_path=wav_path,
    )
