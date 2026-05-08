"""SSE snippet emitter — Phase B prep.

A small helper that yields events conforming to the SSE shape documented in
CONTRACTS.md. Phase A endpoints don't use this yet; it's wired up in Phase B
when each chat / workflow phase emits a ``code-snippet`` followed by a
``result``.

Each method is an async generator so callers can ``async for`` and forward the
strings straight into ``sse_starlette.EventSourceResponse``.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator


def _format(event_type: str, payload: dict) -> str:
    """Turn a dict into the ``event: <type>\\ndata: <json>\\n\\n`` SSE frame."""
    return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


class SnippetEmitter:
    """Builds CONTRACTS.md-compliant SSE events for one walkthrough stage.

    The emitter is stateless beyond the stage name and (optional) phase tracking
    bookkeeping. Each method is an async generator yielding exactly one frame so
    callers can compose streams without juggling formatting.
    """

    def __init__(self, stage: str, language: str = "python") -> None:
        self.stage = stage
        self.language = language
        self._phase_id: str | None = None
        self._phase_index: int | None = None
        self._phase_total: int | None = None

    async def phase_start(
        self,
        phase_id: str,
        phase_index: int,
        phase_total: int,
    ) -> AsyncIterator[str]:
        """Emit a ``phase-start`` frame and remember the phase context."""
        self._phase_id = phase_id
        self._phase_index = phase_index
        self._phase_total = phase_total
        yield _format(
            "phase-start",
            {
                "type": "phase-start",
                "stage": self.stage,
                "phase_id": phase_id,
                "phase_index": phase_index,
                "phase_total": phase_total,
                "status": "running",
            },
        )

    async def code(self, code: str, log: str | None = None) -> AsyncIterator[str]:
        """Emit a ``code-snippet`` frame for a chunk of teaching code."""
        payload: dict = {
            "type": "code-snippet",
            "stage": self.stage,
            "language": self.language,
            "code": code,
            "status": "pending",
        }
        if self._phase_id is not None:
            payload["phase_id"] = self._phase_id
            payload["phase_index"] = self._phase_index
            payload["phase_total"] = self._phase_total
        if log is not None:
            payload["log"] = log
        yield _format("code-snippet", payload)

    async def result(
        self,
        log: str,
        view_in_sandbox: dict | None = None,
    ) -> AsyncIterator[str]:
        """Emit a ``result`` frame describing the outcome of the previous code."""
        payload: dict = {
            "type": "result",
            "stage": self.stage,
            "status": "done",
            "log": log,
        }
        if self._phase_id is not None:
            payload["phase_id"] = self._phase_id
            payload["phase_index"] = self._phase_index
            payload["phase_total"] = self._phase_total
        if view_in_sandbox is not None:
            payload["view_in_sandbox"] = view_in_sandbox
        yield _format("result", payload)

    async def phase_end(self) -> AsyncIterator[str]:
        """Emit a ``phase-end`` frame for the current phase."""
        payload: dict = {
            "type": "phase-end",
            "stage": self.stage,
            "status": "done",
        }
        if self._phase_id is not None:
            payload["phase_id"] = self._phase_id
            payload["phase_index"] = self._phase_index
            payload["phase_total"] = self._phase_total
        yield _format("phase-end", payload)

    async def done(self) -> AsyncIterator[str]:
        """Emit the terminal ``done`` frame."""
        yield _format("done", {"type": "done"})

    async def error(self, msg: str) -> AsyncIterator[str]:
        """Emit an ``error`` frame; callers should stop the stream after."""
        yield _format(
            "error",
            {
                "type": "error",
                "stage": self.stage,
                "status": "error",
                "error": msg,
            },
        )
