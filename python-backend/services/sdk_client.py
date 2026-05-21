"""TestOps SDK client factory + Sandbox URL helpers.

Exposes:
  * ``make_client(public_key, secret_key)`` — per-request SDK client.
  * ``view_in_sandbox(project_id, kind, artifact_id, parent_id=None)`` — builds
    deep-link URLs that match the canonical webapp routes (verified against
    https://evals.browserstack.com).
"""
from __future__ import annotations

import asyncio
import base64
import os

import httpx

from browserstack_ai_sdk import AISDK


SANDBOX_BASE_URL = os.environ.get("TESTOPS_HOST", "https://evals.browserstack.com")


def make_client(public_key: str, secret_key: str) -> AISDK:
    """Per-request client. ``TESTOPS_HOST`` env var drives the base URL."""
    return AISDK(public_key=public_key, secret_key=secret_key)


async def trace_exists(
    public_key: str,
    secret_key: str,
    trace_id: str,
    *,
    max_attempts: int = 6,
    delay_seconds: float = 0.5,
) -> bool:
    """Poll ``GET /api/public/traces/<id>`` until the span batch lands.

    Mirrors the ``fetch_trace_from_server`` helper used in SDK integration
    tests. Returns ``True`` once the trace is queryable, ``False`` after the
    retry budget is exhausted (used to gate the "View trace" button).
    """
    if not trace_id:
        return False
    auth = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
    headers = {"Authorization": f"Basic {auth}"}
    path = f"/api/public/traces/{trace_id}"
    async with httpx.AsyncClient(base_url=SANDBOX_BASE_URL, timeout=2.0) as http:
        for attempt in range(max_attempts):
            try:
                resp = await http.get(path, headers=headers)
                if resp.status_code == 200:
                    return True
                if resp.status_code != 404:
                    return False
            except httpx.HTTPError:
                return False
            if attempt < max_attempts - 1:
                await asyncio.sleep(delay_seconds)
    return False


def view_in_sandbox(
    project_id: str,
    kind: str,
    artifact_id: str | None = None,
    parent_id: str | None = None,
) -> str:
    """Build a deep-link URL for the "View in Sandbox" button.

    URL shapes verified against the live webapp:

      * ``trace``           → /logs/traces?peek=<trace_id>&timestamp=<iso>
      * ``prompt``          → /prompts/<name>      (name preferred over ID)
      * ``dataset``         → /datasets/<dataset_id>
      * ``dataset-run``     → /datasets/<dataset_id>/runs/<run_id>
      * ``tool``            → /tools/<tool_id>     (or /tools page if no ID)
      * ``evaluator``       → /evals-crud/<evaluator_id>
      * ``evaluator-list``  → /evals-crud           (specific-id route 404s)
      * ``experiment``      → /experiments/<experiment_id>
      * ``experiment-run``  → /experiments/<experiment_id>/runs

    For runs (`dataset-run`, `experiment-run`), pass the parent's ID via
    ``parent_id`` and the run's ID via ``artifact_id``.
    """
    base = f"{SANDBOX_BASE_URL}/project/{project_id}"
    aid = artifact_id or ""
    pid = parent_id or ""

    if kind == "trace":
        if aid:
            from datetime import datetime, timezone
            from urllib.parse import quote
            ts = quote(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(datetime.now(timezone.utc).microsecond / 1000):03d}Z")
            return f"{base}/logs/traces?peek={aid}&timestamp={ts}"
        return f"{base}/logs/traces"
    if kind == "prompt":
        return f"{base}/prompts/{aid}" if aid else f"{base}/prompts"
    if kind == "dataset":
        return f"{base}/datasets/{aid}" if aid else f"{base}/datasets"
    if kind == "dataset-run":
        if pid and aid:
            return f"{base}/datasets/{pid}/runs/{aid}"
        if pid:
            return f"{base}/datasets/{pid}/runs"
        return f"{base}/datasets"
    if kind == "tool":
        return f"{base}/tools/{aid}" if aid else f"{base}/tools"
    if kind == "evaluator":
        return f"{base}/evals-crud/{aid}" if aid else f"{base}/evals-crud"
    if kind == "evaluator-list":
        return f"{base}/evals-crud"
    if kind == "experiment":
        return f"{base}/experiments/{aid}" if aid else f"{base}/experiments"
    if kind == "experiment-run":
        # Always link to the experiment's runs list, not the individual run —
        # the per-run page sometimes 404s on freshly-created runs and the
        # runs list is more useful regardless.
        if pid:
            return f"{base}/experiments/{pid}/runs"
        return f"{base}/experiments"
    return base
