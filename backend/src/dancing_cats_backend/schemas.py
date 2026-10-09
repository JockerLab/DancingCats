from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, model_validator


ASSET_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class AnalysisRequest(BaseModel):
    youtube_url: HttpUrl = Field(alias="youtubeUrl")
    asset_ids: list[str] | None = Field(default=None, alias="assetIds")
    asset_id: str | None = Field(default=None, alias="assetId")
    force: bool = False

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def normalize_assets(self) -> "AnalysisRequest":
        requested = self.asset_ids if self.asset_ids is not None else [self.asset_id or "three-cats"]
        requested = list(dict.fromkeys(requested))
        if not requested or len(requested) > 32:
            raise ValueError("assetIds must contain between 1 and 32 assets")
        if any(not ASSET_ID_PATTERN.fullmatch(asset_id) for asset_id in requested):
            raise ValueError("assetIds contains an invalid asset id")
        self.asset_ids = requested
        return self


class JobResponse(BaseModel):
    job_id: str = Field(alias="jobId")
    status: Literal["queued", "running", "complete", "error"]
    stage: Literal[
        "queued", "downloading", "analyzing", "planning", "cached", "complete", "error"
    ]
    video_id: str = Field(alias="videoId")
    map_url: str | None = Field(default=None, alias="mapUrl")
    map_urls: dict[str, str] | None = Field(default=None, alias="mapUrls")
    error: str | None = None

    model_config = {"populate_by_name": True}


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    analyzer: str = "beat-this+lightweight-structure"
