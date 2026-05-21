"""Stage 6 — Workflow dispatch.

Four POST endpoints:

    /api/workflows/experiment-run
    /api/workflows/dataset-run
    /api/workflows/eval-execution
    /api/workflows/prompt-compile

Each opens an SSE stream and forwards events from the matching workflow module.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from services.sdk_client import make_client
from services.snippet_emitter import SnippetEmitter
from workflows import (
    run_dataset_run,
    run_eval_execution,
    run_experiment_run,
    run_prompt_compile,
)

router = APIRouter()

_KNOWN_WORKFLOWS = {"experiment-run", "dataset-run", "eval-execution", "prompt-compile"}

_DISPATCH = {
    "experiment-run": run_experiment_run,
    "dataset-run": run_dataset_run,
    "eval-execution": run_eval_execution,
    "prompt-compile": run_prompt_compile,
}


def _frame(event_type: str, payload: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


async def _error_stream(msg: str) -> AsyncIterator[str]:
    yield _frame("error", {"type": "error", "stage": "workflow", "status": "error", "error": msg})
    yield _frame("done", {"type": "done"})


async def _workflow_stream(
    name: str,
    public_key: str,
    secret_key: str,
    project_id: str,
    openai_key: str,
    extra: dict,
) -> AsyncIterator[str]:
    emitter = SnippetEmitter(stage="workflow", language="python")
    try:
        client = make_client(public_key, secret_key)
    except Exception as exc:  # noqa: BLE001
        async for ev in emitter.error(f"Failed to build SDK client: {exc}"):
            yield ev
        yield _frame("done", {"type": "done"})
        return

    runner = _DISPATCH[name]
    try:
        if name == "prompt-compile":
            user_vars = (extra or {}).get("vars") if isinstance(extra, dict) else None
            async for ev in runner(emitter, client, project_id, openai_key, user_vars):
                yield ev
        else:
            async for ev in runner(emitter, client, project_id):
                yield ev
    except Exception as exc:  # noqa: BLE001
        async for ev in emitter.error(f"Workflow {name} crashed: {exc}"):
            yield ev
        yield _frame("done", {"type": "done"})


@router.post("/api/workflows/{name}")
async def run_workflow(name: str, request: Request) -> StreamingResponse:
    """Stream the named workflow's phases as SSE events."""
    if name not in _KNOWN_WORKFLOWS:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown workflow '{name}'. Expected one of {sorted(_KNOWN_WORKFLOWS)}.",
        )

    public_key = request.headers.get("x-sandbox-public-key", "")
    secret_key = request.headers.get("x-sandbox-secret-key", "")
    openai_key = request.headers.get("x-openai-key", "")
    if not public_key or not secret_key:
        return StreamingResponse(
            _error_stream("Missing Sandbox keys (X-Sandbox-Public-Key / X-Sandbox-Secret-Key)."),
            media_type="text/event-stream",
        )

    body: dict = {}
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    project_id = (body or {}).get("projectId") or "unknown-project"

    return StreamingResponse(
        _workflow_stream(name, public_key, secret_key, project_id, openai_key, body),
        media_type="text/event-stream",
    )
