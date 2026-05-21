"""FastAPI entrypoint for the walkthrough Python backend.

Wires up CORS, mounts the API routers, and serves the shared frontend at ``/``.
The static mount must come last because FastAPI matches routes top-down and a
``StaticFiles`` mount at ``/`` would otherwise swallow the API paths.

Phase A: no TestOps SDK imports anywhere in this app. The ``/chat`` endpoints
call OpenAI / Anthropic directly using the user-supplied keys.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from routes import auth, chat_auto, chat_manual, workflows

app = FastAPI(title="Sandbox SDK Walkthrough — Python", version="0.2.0")

# CORS: allow the frontend served from either backend's port plus 127.0.0.1
# variants. Headers are wide-open since the user-supplied keys come in as
# custom ``X-*`` headers (see CONTRACTS.md).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://localhost:3001",
        "http://127.0.0.1:8000",
        "http://127.0.0.1:3001",
    ],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    """Liveness probe used by docker-compose."""
    return {"ok": True, "runtime": "python"}


# API routers — must be registered BEFORE the static mount.
app.include_router(auth.router)
app.include_router(chat_manual.router)
app.include_router(chat_auto.router)
app.include_router(workflows.router)


# Static frontend mount — Docker copies the shared frontend to /app/shared-frontend.
# Fall back to a sibling ``../shared-frontend`` directory for local dev.
_FRONTEND_DIR = "/app/shared-frontend"
if not os.path.isdir(_FRONTEND_DIR):
    _local = os.path.join(os.path.dirname(__file__), "..", "shared-frontend")
    if os.path.isdir(_local):
        _FRONTEND_DIR = _local

if os.path.isdir(_FRONTEND_DIR):
    # MUST be the last mount: StaticFiles at "/" catches everything not matched above.
    app.mount("/", StaticFiles(directory=_FRONTEND_DIR, html=True), name="frontend")
