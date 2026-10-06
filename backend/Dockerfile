# syntax=docker/dockerfile:1.7

FROM python:3.11-slim

ARG PYTORCH_WHEEL_CHANNEL=cpu

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DANCING_CATS_HOST=0.0.0.0 \
    DANCING_CATS_ASSETS_DIR=/assets \
    DANCING_CATS_ANALYZER_MODEL=harmonix-fold0 \
    HF_HOME=/models/huggingface \
    TORCH_HOME=/models/torch \
    XDG_CACHE_HOME=/models/cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg nodejs libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src

# Installing CPU wheels first prevents pip from resolving the multi-gigabyte
# NVIDIA CUDA dependency set. Override the channel only for a GPU image.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install \
      --index-url "https://download.pytorch.org/whl/${PYTORCH_WHEEL_CHANNEL}" \
      torch torchaudio

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install ".[analysis]"

EXPOSE 8765
VOLUME ["/app/data", "/assets", "/models"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=3)"]
CMD ["dancing-cats-backend"]
