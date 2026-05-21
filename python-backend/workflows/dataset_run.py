"""Workflow 2 — Dataset Run (Confluence v0.1 Script 2).

Four phases:

    1. Prompt CRUD     — text prompt 'support-bot-reranker'
    2. Prompt update   — bump labels via client.prompt.update(...)
    3. Dataset prep    — list/create 'support-bot-reranker-eval'
    4. Dataset run     — create + (mock) iterate items
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from services.sdk_client import view_in_sandbox
from services.snippet_emitter import SnippetEmitter

PROMPT_NAME = "support-bot-reranker"
DATASET_NAME = "support-bot-reranker-eval"


def _safe(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs), None
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)


def _id(x):
    if isinstance(x, dict):
        return x.get("id") or "n/a"
    return getattr(x, "id", "n/a")


async def _phase_1(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in emitter.phase_start("phase-1-prompt-crud", 1, 4):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Prompt\n"
        "\n"
        f'existing = Prompt.list(name="{PROMPT_NAME}", limit=10)',
        log="Look up reranker prompt",
    ):
        yield ev
    listed, err = _safe(client.prompt.list, name=PROMPT_NAME, limit=10)
    items = listed if isinstance(listed, list) else (getattr(listed, "data", None) or [])
    found = next((p for p in items if (p.get("name") if isinstance(p, dict) else getattr(p, "name", None)) == PROMPT_NAME), None)

    if found is None:
        async for ev in emitter.code(
            "Prompt.create(\n"
            f'    name="{PROMPT_NAME}",\n'
            '    type="text",\n'
            '    prompt="Re-rank these candidate answers by helpfulness.",\n'
            '    labels=["v1"],\n'
            ")",
            log="Prompt missing; creating",
        ):
            yield ev
        created, cerr = _safe(
            client.prompt.create,
            name=PROMPT_NAME,
            type="text",
            prompt="Re-rank these candidate answers by helpfulness.",
            labels=["v1"],
        )
        prompt_id = _id(created)
        state["prompt_id"] = prompt_id
        async for ev in emitter.result(
            f"Created prompt (id={prompt_id})" + (f" — {cerr}" if cerr else ""),
            view_in_sandbox={"label": "View prompt", "url": view_in_sandbox(project_id, "prompt", PROMPT_NAME)},
        ):
            yield ev
    else:
        prompt_id = _id(found)
        state["prompt_id"] = prompt_id
        async for ev in emitter.code(
            "# Prompt exists — reuse",
            log="Reusing existing prompt",
        ):
            yield ev
        async for ev in emitter.result(
            f"Reused prompt (id={prompt_id})" + (f" — {err}" if err else ""),
            view_in_sandbox={"label": "View prompt", "url": view_in_sandbox(project_id, "prompt", PROMPT_NAME)},
        ):
            yield ev

    async for ev in emitter.phase_end():
        yield ev


async def _phase_2(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    """List the prompt's existing versions.

    The Python SDK does not expose ``client.prompt.update``; instead, calling
    ``client.prompt.create(name=...)`` again with new content auto-bumps the
    version on the server. To stay idempotent across multiple runs, this
    phase only *inspects* existing versions. (Need a new version? Edit the
    seed text and the next run will bump.)
    """
    async for ev in emitter.phase_start("phase-2-prompt-versions", 2, 4):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Prompt\n"
        "\n"
        f'existing = Prompt.list(name="{PROMPT_NAME}", limit=10)\n'
        "# read .versions off the matching entry to inspect history",
        log="Inspect existing versions of the prompt",
    ):
        yield ev
    listed, err = _safe(client.prompt.list, name=PROMPT_NAME, limit=10)
    items = listed if isinstance(listed, list) else (getattr(listed, "data", None) or [])
    found = next(
        (
            p
            for p in items
            if (p.get("name") if isinstance(p, dict) else getattr(p, "name", None)) == PROMPT_NAME
        ),
        None,
    )
    versions = []
    if isinstance(found, dict):
        versions = found.get("versions") or []
    elif found is not None:
        versions = list(getattr(found, "versions", []) or [])

    async for ev in emitter.code(
        "# To bump a prompt version: call Prompt.create with the same name\n"
        "# and updated content — the server treats it as a new version automatically.",
        log="Versioning is implicit: re-create with new content to bump",
    ):
        yield ev

    async for ev in emitter.result(
        f"Found {len(versions)} version(s): {versions}" if versions else (f"No versions yet" + (f" ({err})" if err else "")),
        view_in_sandbox={"label": "View prompt", "url": view_in_sandbox(project_id, "prompt", PROMPT_NAME)},
    ):
        yield ev

    async for ev in emitter.phase_end():
        yield ev


async def _phase_3(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in emitter.phase_start("phase-3-dataset-prep", 3, 4):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Evaluate\n"
        "\n"
        f'existing = Evaluate.dataset.list(name="{DATASET_NAME}")',
        log="Pick or create reranker eval dataset",
    ):
        yield ev
    listed, err = _safe(client.evaluate.dataset.list, name=DATASET_NAME)
    items = listed if isinstance(listed, list) else (getattr(listed, "data", None) or [])
    found = next((d for d in items if (d.get("name") if isinstance(d, dict) else getattr(d, "name", None)) == DATASET_NAME), None)

    if found is None:
        async for ev in emitter.code(
            "Evaluate.dataset.create(\n"
            f'    name="{DATASET_NAME}",\n'
            '    description="Reranker eval inputs",\n'
            ")",
            log="Dataset missing; creating",
        ):
            yield ev
        created, cerr = _safe(
            client.evaluate.dataset.create, name=DATASET_NAME, description="Reranker eval inputs"
        )
        ds_id = _id(created)
        state["dataset_id"] = ds_id
        async for ev in emitter.result(
            f"Created dataset (id={ds_id})" + (f" — {cerr}" if cerr else ""),
            view_in_sandbox={"label": "View dataset", "url": view_in_sandbox(project_id, "dataset", ds_id)},
        ):
            yield ev
    else:
        ds_id = _id(found)
        state["dataset_id"] = ds_id
        async for ev in emitter.code(
            "# Dataset exists; reusing",
            log="Reusing existing dataset",
        ):
            yield ev
        async for ev in emitter.result(
            f"Reused dataset (id={ds_id})",
            view_in_sandbox={"label": "View dataset", "url": view_in_sandbox(project_id, "dataset", ds_id)},
        ):
            yield ev

    async for ev in emitter.phase_end():
        yield ev


async def _phase_4(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in emitter.phase_start("phase-4-dataset-run", 4, 4):
        yield ev

    # Create the dataset run anchored to the dataset (positional name).
    async for ev in emitter.code(
        "from browserstack_ai_sdk import Evaluate\n"
        "\n"
        "run = Evaluate.dataset_run.create(\n"
        f'    "{DATASET_NAME}",\n'
        '    name="reranker-walkthrough",\n'
        '    tag="walkthrough",\n'
        ")",
        log="Create the dataset run",
    ):
        yield ev
    run, err = _safe(
        client.evaluate.dataset_run.create,
        DATASET_NAME,
        name="reranker-walkthrough",
        tag="walkthrough",
    )
    run_id = _id(run)
    if run_id == "n/a":
        async for ev in emitter.error(f"dataset_run.create failed: {err or 'unknown'}"):
            yield ev
        async for ev in emitter.phase_end():
            yield ev
        return

    # Seed items into the run so the walkthrough actually shows data flowing.
    items = [
        {"input": "Where is order #4831?", "expectedOutput": "shipped Monday"},
        {"input": "How do I return a damaged item?", "expectedOutput": "Use the returns portal."},
        {"input": "What's your refund policy?", "expectedOutput": "Within 30 days, full refund."},
    ]
    async for ev in emitter.code(
        "Evaluate.dataset_run.create_items(\n"
        f'    "{DATASET_NAME}",\n'
        f'    "{run_id}",\n'
        "    [\n"
        '        {"input": "...", "expectedOutput": "..."},\n'
        '        ... 2 more items ...\n'
        "    ],\n"
        ")",
        log=f"Add {len(items)} items to the run",
    ):
        yield ev
    created, ierr = _safe(
        client.evaluate.dataset_run.create_items,
        DATASET_NAME,
        run_id,
        items,
    )

    # Verify by listing the items back.
    listed, lerr = _safe(
        client.evaluate.dataset_run.list_items,
        DATASET_NAME,
        run_id,
        limit=10,
    )
    listed_items = []
    if isinstance(listed, dict):
        listed_items = listed.get("items") or listed.get("data") or []
    elif listed is not None:
        listed_items = list(getattr(listed, "items", None) or getattr(listed, "data", None) or [])

    if ierr:
        result_log = f"Run created (id={run_id}); item creation failed: {ierr}"
        is_error = True
    else:
        result_log = f"Run created (id={run_id}) with {len(listed_items)} items verified via list_items()"
        is_error = False

    async for ev in (emitter.error(result_log) if is_error else emitter.result(
        result_log,
        view_in_sandbox={
            "label": "View dataset run",
            "url": view_in_sandbox(
                project_id, "dataset-run", run_id, parent_id=state.get("dataset_id")
            ),
        },
    )):
        yield ev

    async for ev in emitter.phase_end():
        yield ev


async def run_dataset_run(
    emitter: SnippetEmitter, client: Any, project_id: str
) -> AsyncIterator[str]:
    state: dict = {}
    async for ev in _phase_1(emitter, client, project_id, state):
        yield ev
    async for ev in _phase_2(emitter, client, project_id, state):
        yield ev
    async for ev in _phase_3(emitter, client, project_id, state):
        yield ev
    async for ev in _phase_4(emitter, client, project_id, state):
        yield ev
    async for ev in emitter.done():
        yield ev
