"""DEEPTRACE backend — FastAPI application.

Run:  cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router, warm_up
from app.config import get_settings

log = logging.getLogger("deeptrace")


@asynccontextmanager
async def lifespan(_: FastAPI):
    def _warm() -> None:
        try:
            warm_up()
            log.info("DEEPTRACE engine warm (baseline + N-1 metrics cached)")
        except Exception:  # noqa: BLE001
            log.exception("Engine warm-up failed")

    threading.Thread(target=_warm, name="engine-warmup", daemon=True).start()
    yield


app = FastAPI(
    title="DEEPTRACE API",
    description="Infrastructure network, cascade simulation and AI analyst for the DEEPTRACE digital twin.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(get_settings().cors_origins),
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/")
def root() -> dict[str, str]:
    return {"name": "DEEPTRACE API", "docs": "/docs", "health": "/api/health"}
