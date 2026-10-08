from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, HttpUrl


class AnalysisRequest(BaseModel):
    youtube_url: HttpUrl = Field(alias="youtubeUrl")
    asset_id: str = Field(default="three-cats", alias="assetId", pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")
    force: bool = False

    model_config = {"populate_by_name": True}


class JobResponse(BaseModel):
    job_id: str = Field(alias="jobId")
    status: Literal["queued", "running", "complete", "error"]
    stage: Literal[
        "queued", "downloading", "analyzing", "planning", "cached", "complete", "error"
    ]
    video_id: str = Field(alias="videoId")
    map_url: str | None = Field(default=None, alias="mapUrl")
    error: str | None = None

    model_config = {"populate_by_name": True}


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    analyzer: str = "beat-this+lightweight-structure"
