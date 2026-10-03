from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    project_root: Path
    data_dir: Path
    cache_dir: Path
    assets_dir: Path
    host: str
    port: int
    max_duration_seconds: int

    @classmethod
    def from_environment(cls) -> "Settings":
        backend_root = Path(__file__).resolve().parents[2]
        project_root = backend_root.parent
        data_dir = Path(os.getenv("DANCING_CATS_DATA_DIR", backend_root / "data")).resolve()
        assets_dir = Path(
            os.getenv("DANCING_CATS_ASSETS_DIR", project_root / "extension" / "assets")
        ).resolve()
        return cls(
            project_root=project_root,
            data_dir=data_dir,
            cache_dir=data_dir / "maps",
            assets_dir=assets_dir,
            host=os.getenv("DANCING_CATS_HOST", "127.0.0.1"),
            port=int(os.getenv("DANCING_CATS_PORT", "8765")),
            max_duration_seconds=int(os.getenv("DANCING_CATS_MAX_DURATION", "900")),
        )

    def prepare(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
