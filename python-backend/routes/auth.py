"""Stage 2 — Auth probe.

Streams the SDK client construction + ``client.experiments.list(limit=1)``
probe as SSE events. On success, surfaces the discovered ``projectId`` so the
frontend can thread it into Stages 4 and 6.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from services.sdk_client import SANDBOX_BASE_URL, make_client
from services.snippet_emitter import SnippetEmitter

router = APIRouter()


def _frame(event_type: str, payload: dict) -> str:
  return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


def _mask(key: str) -> str:
  if not key:
    return "***"
  return key[:8] + "***"


async def _auth_stream(public_key: str, secret_key: str) -> AsyncIterator[str]:
  emitter = SnippetEmitter(stage="auth", language="python")
  async for ev in emitter.phase_start("auth-probe", 1, 1):
    yield ev

  pk_masked = _mask(public_key)
  sk_masked = _mask(secret_key)

  async for ev in emitter.code(
    f'client = AISDK(public_key="{pk_masked}", secret_key="{sk_masked}")'
  ):
    yield ev
  async for ev in emitter.code("result = client.experiments.list(limit=1)"):
    yield ev

  if not public_key or not secret_key:
    async for ev in emitter.error("Missing Sandbox keys."):
      yield ev
    yield _frame("done", {"type": "done"})
    return

  try:
    client = make_client(public_key, secret_key)
    result = client.experiments.list(limit=1)
  except Exception as exc:  # noqa: BLE001
    async for ev in emitter.error(str(exc)):
      yield ev
    yield _frame("done", {"type": "done"})
    return

  # Auth succeeded — set the env vars the Python SDK reads. Observe.init() is
  # NOT called here; Stage 3 is manual tracing and we don't want auto-instrumentation
  # double-counting those spans. Observe.init() fires on first /api/chat/auto call.
  os.environ["AISDK_PUBLIC_KEY"] = public_key
  os.environ["AISDK_SECRET_KEY"] = secret_key

  experiments = []
  if isinstance(result, dict):
    experiments = result.get("experiments") or []
  else:
    experiments = getattr(result, "experiments", []) or []

  project_id = ""
  if experiments:
    first = experiments[0]
    if isinstance(first, dict):
      project_id = first.get("projectId") or first.get("project_id") or ""
    else:
      project_id = getattr(first, "projectId", "") or getattr(first, "project_id", "") or ""

  if project_id:
    log = f"Authenticated. Project ID: {project_id}"
    url = f"{SANDBOX_BASE_URL}/project/{project_id}"
    label = "Open project"
  else:
    log = (
      "Authenticated, but no experiments found yet. "
      "Create at least one artifact in Sandbox to surface a project ID."
    )
    url = f"{SANDBOX_BASE_URL}/projects"
    label = "Open Sandbox"

  payload: dict = {
    "type": "result",
    "stage": "auth",
    "status": "done",
    "phase_id": "auth-probe",
    "phase_index": 1,
    "phase_total": 1,
    "log": log,
    "projectId": project_id,
    "view_in_sandbox": {"label": label, "url": url},
  }
  yield _frame("result", payload)

  async for ev in emitter.phase_end():
    yield ev
  yield _frame("done", {"type": "done"})


@router.post("/api/auth/validate")
async def validate(request: Request) -> StreamingResponse:
  """Stream the auth probe as SSE."""
  public_key = request.headers.get("x-sandbox-public-key", "")
  secret_key = request.headers.get("x-sandbox-secret-key", "")
  return StreamingResponse(_auth_stream(public_key, secret_key), media_type="text/event-stream")
