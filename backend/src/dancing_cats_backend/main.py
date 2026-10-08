from __future__ import annotations

import logging
import sys

import uvicorn

from .app import create_app
from .config import Settings


application_logger = logging.getLogger("dancing_cats_backend")
application_logger.setLevel(logging.INFO)
application_logger.propagate = False
if not application_logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    application_logger.addHandler(handler)
app = create_app()


def run() -> None:
    settings = Settings.from_environment()
    uvicorn.run(
        "dancing_cats_backend.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    run()
