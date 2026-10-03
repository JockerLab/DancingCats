from __future__ import annotations

import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import Settings
from .jobs import Job, JobManager
from .schemas import AnalysisRequest, HealthResponse, JobResponse


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or Settings.from_environment()
    active_settings.prepare()
    manager = JobManager(active_settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        manager.shutdown()

    app = FastAPI(
        title="Dancing Cats local analyzer",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = active_settings
    app.state.jobs = manager
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"chrome-extension://[a-p]{32}",
        allow_methods=["GET", "POST"],
        allow_headers=["content-type"],
    )

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse()

    @app.post("/v1/analysis", response_model=JobResponse, response_model_by_alias=True)
    def create_analysis(payload: AnalysisRequest, request: Request) -> JobResponse:
        try:
            job = manager.submit(str(payload.youtube_url), payload.asset_id, payload.force)
        except (ValueError, OSError, json.JSONDecodeError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return _job_response(job, request)

    @app.get("/v1/analysis/{job_id}", response_model=JobResponse, response_model_by_alias=True)
    def get_analysis(job_id: str, request: Request) -> JobResponse:
        job = manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Unknown analysis job")
        return _job_response(job, request)

    @app.get("/v1/maps/{cache_key}")
    def get_map(cache_key: str) -> JSONResponse:
        if len(cache_key) != 24 or any(character not in "0123456789abcdef" for character in cache_key):
            raise HTTPException(status_code=404, detail="Unknown choreography map")
        path = manager.map_path(cache_key)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Choreography map is not ready")
        return JSONResponse(json.loads(path.read_text(encoding="utf-8")))

    return app


def _job_response(job: Job, request: Request) -> JobResponse:
    map_url = None
    if job.status == "complete":
        map_url = str(request.base_url).rstrip("/") + f"/v1/maps/{job.cache_key}"
    return JobResponse(
        jobId=job.job_id,
        status=job.status,
        videoId=job.video_id,
        mapUrl=map_url,
        error=job.error,
    )
