from __future__ import annotations

import uvicorn

from .app import create_app
from .config import Settings


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
