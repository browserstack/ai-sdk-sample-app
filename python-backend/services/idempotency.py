"""Idempotency helper for Stage 6 workflows.

Implements the ``ensure(resource)`` pattern from CONTRACTS.md section 5.
The helper looks up an existing resource by name; creates if missing; updates
(or deletes+recreates if no .update) on drift; reuses unchanged.

Decisions are surfaced via the optional ``log`` callable so the snippet emitter
can stream a human-readable trail to the frontend.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any


def first_match_by_name(items: list[Any], name: str) -> Any | None:
    """Return the first item whose ``name`` attribute/key equals ``name``."""
    for item in items or []:
        item_name = item.get("name") if isinstance(item, dict) else getattr(item, "name", None)
        if item_name == name:
            return item
    return None


def get_id(resource: Any) -> str | None:
    """Best-effort extraction of an id field from an SDK response."""
    if resource is None:
        return None
    if isinstance(resource, dict):
        return resource.get("id") or resource.get("evaluator_list_id") or resource.get("dataset_id")
    return getattr(resource, "id", None)


def ensure(
    *,
    name: str,
    list_fn: Callable[[], Any],
    create_fn: Callable[[dict], Any],
    update_fn: Callable[[str, dict], Any] | None,
    delete_fn: Callable[[str], Any] | None,
    expected: dict,
    drift_check: Callable[[Any, dict], bool],
    support_update: bool = True,
    log: Callable[[str], Any] | None = None,
) -> Any:
    """Ensure a resource matches ``expected``; return the live resource.

    Parameters mirror the contract spec. ``list_fn`` may return either a list
    or an SDK response object with a ``.data`` / ``.evaluators`` attribute;
    we normalize to a flat list before searching.
    """
    raw = list_fn()
    items: list[Any]
    if isinstance(raw, list):
        items = raw
    elif hasattr(raw, "data"):
        items = list(raw.data or [])
    elif hasattr(raw, "evaluators"):
        items = list(raw.evaluators or [])
    elif isinstance(raw, dict):
        items = list(raw.get("data") or raw.get("evaluators") or [])
    else:
        items = []

    existing = first_match_by_name(items, name)

    if existing is None:
        if log:
            log(f"'{name}' not found; creating")
        return create_fn(expected)

    if drift_check(existing, expected):
        rid = get_id(existing)
        if support_update and update_fn is not None and rid:
            if log:
                log(f"'{name}' drift detected; updating")
            return update_fn(rid, expected)
        if delete_fn is not None and rid:
            if log:
                log(f"'{name}' drift detected; deleting+recreating (no .update)")
            delete_fn(rid)
            return create_fn(expected)
        if log:
            log(f"'{name}' drift detected but no update/delete available; reusing")
        return existing

    if log:
        log(f"'{name}' exists with current spec; reusing")
    return existing
