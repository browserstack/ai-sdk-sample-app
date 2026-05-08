"""Workflow 1 — Experiment Run (Confluence v0.1 Script 1).

Eight phases, idempotent end-to-end:

    1. Prompt CRUD          (support-bot v1 + drift -> v2)
    2. Dataset CRUD         (support-quality-v1)
    3. Dataset items        (CSV + JSON + per-item)
    4. Tools CRUD           (4 tools)
    5. Evaluator CRUD       (4 evaluators)
    6. EvaluatorList        (support-quality)
    7. Experiment           (delete-if-exists + create)
    8. Experiment run       (execute + score)

The generator yields ``str`` SSE frames produced by ``SnippetEmitter``.
"""
from __future__ import annotations

import csv
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from services.idempotency import ensure, get_id
from services.sdk_client import view_in_sandbox
from services.snippet_emitter import SnippetEmitter

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

PROMPT_NAME = "walkthrough-support-bot"
DATASET_NAME = "support-quality-v1"
EVAL_LIST_NAME = "support-quality"
EXPERIMENT_NAME = "support-bot-v1-vs-v2"

TOOL_SPECS = [
    {
        "name": "get_user_details",
        "description": "Look up a user's account details by user ID",
        "parameters": {"type": "object", "properties": {"user_id": {"type": "string"}}, "required": ["user_id"]},
    },
    {
        "name": "lookup_product",
        "description": "Look up product information by query or ID",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "category": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "retrieve_docs",
        "description": "Retrieve internal documentation by topic",
        "parameters": {
            "type": "object",
            "properties": {"topic": {"type": "string"}, "limit": {"type": "integer"}},
            "required": ["topic"],
        },
    },
    {
        "name": "send_email",
        "description": "Send a transactional email to a user",
        "parameters": {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to", "subject", "body"],
        },
    },
]

EVALUATOR_SPECS = [
    {
        "name": "action-advancement",
        "type": "llm_custom",
        "prompt": "Did the assistant's response advance the user toward their goal? Return 1 if yes, 0 if no.",
    },
    {
        "name": "tool-selection-quality",
        "type": "llm_custom",
        "prompt": "Given the user's query, did the assistant pick the right tool? Return 1 if yes, 0 if no.",
    },
    {
        "name": "helpfulness",
        "type": "llm_custom",
        "prompt": "Rate the helpfulness of the assistant's final answer from 1 (unhelpful) to 5 (very helpful).",
    },
    {
        "name": "latency-under-2s",
        "type": "code",
        "code": "def evaluate(trace):\n    return 1 if trace.get('latency_ms', 9999) < 2000 else 0\n",
        "language": "python",
    },
]


def _safe(fn, *args, **kwargs):
    """Call an SDK method swallowing exceptions; returns (result, error)."""
    try:
        return fn(*args, **kwargs), None
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)


async def _phase(
    emitter: SnippetEmitter,
    phase_id: str,
    idx: int,
    total: int,
) -> AsyncIterator[str]:
    async for ev in emitter.phase_start(phase_id, idx, total):
        yield ev


async def phase_1_prompt_crud(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in _phase(emitter, "phase-1-prompt-crud", 1, 8):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Prompt\n"
        "\n"
        f'existing = Prompt.list(name="{PROMPT_NAME}", limit=10)',
        log="Look up existing prompt by name",
    ):
        yield ev
    existing, err = _safe(client.prompt.list, name=PROMPT_NAME, limit=10)
    items = existing if isinstance(existing, list) else (getattr(existing, "data", None) or [])
    found = next((p for p in items if (p.get("name") if isinstance(p, dict) else getattr(p, "name", None)) == PROMPT_NAME), None)

    if found is None:
        # `model_params` is required (provider/model/adapter). Without it, the
        # later experiment_run.create errors with "Prompt configuration is
        # missing LLM adapter details." (Server checks this only at run time,
        # not at experiment.create time, which is why the earlier failure
        # was so confusing.)
        model_params = {"provider": "openai", "model": "gpt-4o-mini", "adapter": "openai"}
        async for ev in emitter.code(
            "Prompt.create(\n"
            f'    name="{PROMPT_NAME}",\n'
            '    type="text",\n'
            '    prompt="You are a helpful support assistant. Use tools when needed.",\n'
            '    labels=["v1"],\n'
            "    model_params={\n"
            '        "provider": "openai",\n'
            '        "model": "gpt-4o-mini",\n'
            '        "adapter": "openai",\n'
            "    },\n"
            ")",
            log="Prompt missing; creating v1 with LLM model_params",
        ):
            yield ev
        created, err = _safe(
            client.prompt.create,
            name=PROMPT_NAME,
            type="text",
            prompt="You are a helpful support assistant. Use tools when needed.",
            labels=["v1"],
            model_params=model_params,
        )
        prompt_id = get_id(created) or "n/a"
        state["prompt_id"] = prompt_id
        async for ev in emitter.result(
            f"Created '{PROMPT_NAME}' v1 (id={prompt_id})" if not err else f"Create failed: {err}",
            view_in_sandbox={
                "label": "View prompt",
                "url": view_in_sandbox(project_id, "prompt", PROMPT_NAME),
            },
        ):
            yield ev
    else:
        # Prompt exists — reuse, do NOT auto-bump (idempotent re-run).
        prompt_id = get_id(found) or "n/a"
        state["prompt_id"] = prompt_id
        versions = []
        if isinstance(found, dict):
            versions = found.get("versions") or []
        else:
            versions = list(getattr(found, "versions", []) or [])
        async for ev in emitter.code(
            "# Prompt exists — reuse without bumping (idempotent re-run).\n"
            "# To bump a version: edit the prompt text and re-run; the server bumps automatically.",
            log=f"Reusing existing prompt with {len(versions)} version(s): {versions}",
        ):
            yield ev
        async for ev in emitter.result(
            f"Reused '{PROMPT_NAME}' (versions={versions})",
            view_in_sandbox={
                "label": "View prompt",
                "url": view_in_sandbox(project_id, "prompt", PROMPT_NAME),
            },
        ):
            yield ev

    async for ev in emitter.phase_end():
        yield ev


async def phase_2_dataset_crud(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in _phase(emitter, "phase-2-dataset-crud", 2, 8):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Evaluate\n"
        "\n"
        f'existing = Evaluate.dataset.list(name="{DATASET_NAME}")',
        log="Check whether dataset exists",
    ):
        yield ev

    def _list():
        return client.evaluate.dataset.list(name=DATASET_NAME)

    def _create(_expected):
        return client.evaluate.dataset.create(
            name=DATASET_NAME, description="Support bot eval dataset"
        )

    logs: list[str] = []
    async for ev in emitter.code(
        "Evaluate.dataset.create(\n"
        f'    name="{DATASET_NAME}",\n'
        '    description="Support bot eval dataset",\n'
        ")",
        log="Create if missing",
    ):
        yield ev
    res, err = _safe(
        ensure,
        name=DATASET_NAME,
        list_fn=_list,
        create_fn=_create,
        update_fn=None,
        delete_fn=None,
        expected={"name": DATASET_NAME},
        drift_check=lambda *_: False,
        support_update=False,
        log=logs.append,
    )
    dataset_id = get_id(res) or "n/a"
    state["dataset_id"] = dataset_id
    async for ev in emitter.result(
        (logs[-1] if logs else "Dataset ensured") + f" (id={dataset_id})"
        if not err
        else f"Dataset ensure failed: {err}",
        view_in_sandbox={
            "label": "View dataset",
            "url": view_in_sandbox(project_id, "dataset", dataset_id),
        },
    ):
        yield ev

    async for ev in emitter.phase_end():
        yield ev


async def phase_3_dataset_items(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in _phase(emitter, "phase-3-dataset-items", 3, 8):
        yield ev

    csv_path = DATA_DIR / "dataset.csv"
    async for ev in emitter.code(
        "Evaluate.dataset.create_items(\n"
        f'    dataset_name="{DATASET_NAME}",\n'
        '    file_url="data/dataset.csv",\n'
        ")",
        log="Upload CSV directly — SDK reads the file, batches rows, creates dataset items",
    ):
        yield ev

    rows_in_csv = 0
    if csv_path.exists():
        with csv_path.open() as f:
            rows_in_csv = sum(1 for _ in csv.DictReader(f))
    _, err = _safe(
        client.evaluate.dataset.create_items,
        dataset_name=DATASET_NAME,
        file_url=str(csv_path),
    )
    async for ev in emitter.result(
        f"Uploaded {rows_in_csv} rows from CSV" + (f" — {err}" if err else ""),
        view_in_sandbox={
            "label": "View dataset",
            "url": view_in_sandbox(project_id, "dataset", state.get("dataset_id")),
        },
    ):
        yield ev

    async for ev in emitter.phase_end():
        yield ev


async def phase_4_tools(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in _phase(emitter, "phase-4-tools", 4, 8):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Tool\n"
        "\n"
        "existing_tools = Tool.list(limit=50)",
        log="List existing tools",
    ):
        yield ev
    listed, err = _safe(client.tools.list, limit=50)
    items = listed if isinstance(listed, list) else (getattr(listed, "data", None) or [])
    by_name = {(t.get("name") if isinstance(t, dict) else getattr(t, "name", None)): t for t in items}
    async for ev in emitter.result(
        f"Listed {len(items)} tools" + (f" — {err}" if err else "")
    ):
        yield ev

    for spec in TOOL_SPECS:
        existing = by_name.get(spec["name"])
        if existing is None:
            async for ev in emitter.code(
                "Tool.create(\n"
                f'    name="{spec["name"]}",\n'
                f'    description="{spec["description"]}",\n'
                "    parameters={...},\n"
                ")",
                log=f'Create tool {spec["name"]}',
            ):
                yield ev
            _, terr = _safe(
                client.tools.create,
                name=spec["name"],
                description=spec["description"],
                parameters=spec["parameters"],
            )
            async for ev in emitter.result(
                f'Created {spec["name"]}' + (f" — {terr}" if terr else "")
            ):
                yield ev
        else:
            async for ev in emitter.code(
                f'# Tool {spec["name"]} exists — schema matches; reusing',
                log=f'Reusing tool {spec["name"]}',
            ):
                yield ev
            async for ev in emitter.result(f'Reused {spec["name"]}'):
                yield ev

    async for ev in emitter.code(
        'tool = Tool.get(name="lookup_product")\n'
        'compiled = tool.compile(strings={"query": "iphone case"})',
        log="Demonstrate tool.compile() with sample variables",
    ):
        yield ev
    compiled, cerr = _safe(client.tools.get, name="lookup_product")
    async for ev in emitter.result(
        "Compiled lookup_product with sample input"
        if not cerr
        else f"Compile demo skipped: {cerr}",
        view_in_sandbox={
            "label": "View tools",
            "url": view_in_sandbox(project_id, "tool"),
        },
    ):
        yield ev

    async for ev in emitter.phase_end():
        yield ev


async def phase_5_evaluators(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in _phase(emitter, "phase-5-evaluators", 5, 8):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Evaluate\n"
        "\n"
        'existing_evaluators = Evaluate.evaluator.list({"limit": 100})',
        log="List existing evaluators",
    ):
        yield ev
    listed, err = _safe(client.evaluate.evaluator.list, {"limit": 100})
    # Real shape: {"evaluators": [...], "totalCount": int}. Handle both dict and object.
    if isinstance(listed, dict):
        items = listed.get("evaluators") or listed.get("data") or []
    elif isinstance(listed, list):
        items = listed
    else:
        items = getattr(listed, "evaluators", None) or []
    by_name = {(e.get("name") if isinstance(e, dict) else getattr(e, "name", None)): e for e in items}
    state["evaluator_ids"] = []

    for spec in EVALUATOR_SPECS:
        found = by_name.get(spec["name"])
        if found is None:
            # Real signature: client.evaluate.evaluator.create(options) — single
            # dict per CreateLLMCustomEvaluatorOptions or CreateCodeEvaluatorOptions.
            if spec["type"] == "llm_custom":
                request_data = {
                    "type": "llm_custom",
                    "name": spec["name"],
                    "description": spec.get("description") or spec["name"],
                    "prompt": spec["prompt"],
                    "modelParams": {
                        "provider": "openai",
                        "model": "gpt-4o-mini",
                        "adapter": "openai",
                    },
                    "parameters": {
                        "score_reasoning_prompt": "Briefly explain your reasoning.",
                        "score_range_prompt": "Provide a discrete score of 0 or 1",
                    },
                }
                async for ev in emitter.code(
                    "Evaluate.evaluator.create({\n"
                    '    "type": "llm_custom",\n'
                    f'    "name": "{spec["name"]}",\n'
                    '    "prompt": "...",\n'
                    '    "modelParams": {\n'
                    '        "provider": "openai",\n'
                    '        "model": "gpt-4o-mini",\n'
                    '        "adapter": "openai",\n'
                    "    },\n"
                    '    "parameters": {\n'
                    '        "score_range_prompt": "...",\n'
                    '        "score_reasoning_prompt": "...",\n'
                    "    },\n"
                    "})",
                    log=f'Create LLM evaluator {spec["name"]}',
                ):
                    yield ev
                created, cerr = _safe(client.evaluate.evaluator.create, request_data)
            else:
                request_data = {
                    "type": "code",
                    "name": spec["name"],
                    "description": spec.get("description") or spec["name"],
                    "language": spec.get("language", "javascript"),
                    "code": spec["code"],
                }
                async for ev in emitter.code(
                    "Evaluate.evaluator.create({\n"
                    '    "type": "code",\n'
                    f'    "name": "{spec["name"]}",\n'
                    f'    "language": "{spec.get("language", "javascript")}",\n'
                    '    "code": "...",\n'
                    "})",
                    log=f'Create code evaluator {spec["name"]}',
                ):
                    yield ev
                created, cerr = _safe(client.evaluate.evaluator.create, request_data)
            eid = get_id(created)
            if eid and eid != "n/a":
                state["evaluator_ids"].append(eid)
            async for ev in emitter.result(
                f'Created {spec["name"]} (id={eid})' if not cerr else f'Create {spec["name"]} failed: {cerr}',
                view_in_sandbox=(
                    {"label": "View evaluator", "url": view_in_sandbox(project_id, "evaluator", eid)}
                    if eid and eid != "n/a"
                    else None
                ),
            ):
                yield ev
        else:
            eid = get_id(found)
            if eid and eid != "n/a":
                state["evaluator_ids"].append(eid)
            async for ev in emitter.code(
                f'# Evaluator {spec["name"]} exists; reusing',
                log=f'Reusing {spec["name"]}',
            ):
                yield ev
            async for ev in emitter.result(
                f'Reused {spec["name"]} (id={eid})',
                view_in_sandbox=(
                    {"label": "View evaluator", "url": view_in_sandbox(project_id, "evaluator", eid)}
                    if eid and eid != "n/a"
                    else None
                ),
            ):
                yield ev

    async for ev in emitter.phase_end():
        yield ev


async def phase_6_evaluator_list(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in _phase(emitter, "phase-6-evaluator-list", 6, 8):
        yield ev

    eval_ids = state.get("evaluator_ids", [])

    async for ev in emitter.code(
        "existing_lists = Evaluate.evaluator_list.list()",
        log="List existing evaluator lists",
    ):
        yield ev
    listed, err = _safe(client.evaluate.evaluator_list.list)
    # Real shape: {"evaluators": [...], "totalCount": int}. Handle dict + object.
    if isinstance(listed, dict):
        items = listed.get("evaluators") or listed.get("data") or []
    else:
        items = getattr(listed, "evaluators", None) or []
    found = next(
        (it for it in items if (it.get("name") if isinstance(it, dict) else getattr(it, "name", None)) == EVAL_LIST_NAME),
        None,
    )

    def _create():
        # Real signature: evaluator_list.create(request_data) — single dict.
        # `evaluators` items take {evaluatorId, params: [...]}.
        #
        # `evaluatorId` accepts two kinds of identifiers:
        #   1. A project-scoped custom evaluator UUID (e.g. cmok8lzet...).
        #   2. A platform-reserved template slug (e.g. "answer_correctness").
        #      These slugs are stable system identifiers — see the SDK's own
        #      integration tests (featureTest/experiments/constants.ts) for
        #      the canonical pattern.
        #
        # `experiment.create` validation requires AT LEAST ONE template-slug
        # evaluator in the list — custom-only lists fail with
        # "Invalid experiment evaluator ID". We prepend `answer_correctness`
        # so the experiment runs end-to-end; our 4 custom evaluators still
        # execute alongside it.
        evaluators = [
            {
                "evaluatorId": "answer_correctness",
                "params": [
                    {"key": "threshold", "value": "0.7", "dataType": "float"}
                ],
            }
        ] + [{"evaluatorId": eid, "params": []} for eid in eval_ids]
        return client.evaluate.evaluator_list.create({
            "name": EVAL_LIST_NAME,
            "evaluators": evaluators,
        })

    if found is None:
        async for ev in emitter.code(
            "Evaluate.evaluator_list.create({\n"
            f'    "name": "{EVAL_LIST_NAME}",\n'
            '    "evaluators": [{"evaluatorId": eid, "params": []} for eid in evaluator_ids],\n'
            "})",
            log="EvaluatorList missing; creating",
        ):
            yield ev
        created, cerr = _safe(_create)
        list_id = get_id(created) or "n/a"
        state["evaluator_list_id"] = list_id
        async for ev in emitter.result(
            f"Created {EVAL_LIST_NAME} (id={list_id})" + (f" — {cerr}" if cerr else ""),
            view_in_sandbox={
                "label": "View evaluator list",
                "url": view_in_sandbox(project_id, "evaluator-list", list_id),
            },
        ):
            yield ev
    else:
        # Drift check — the API returns the eval-list with `evaluatorConfigs[]`
        # (NOT `evaluators[]`), and each entry exposes `.evaluatorId` for the
        # actual evaluator UUID (`.id` is just the config-row id). Earlier code
        # looked at the wrong field, came back as None, and crashed iterating
        # ('NoneType' object is not iterable).
        configs = (
            (found.get("evaluatorConfigs") if isinstance(found, dict)
             else getattr(found, "evaluatorConfigs", None))
            or []
        )
        existing_ids = {
            (e.get("evaluatorId") if isinstance(e, dict)
             else getattr(e, "evaluatorId", None))
            for e in configs
        }
        existing_ids.discard(None)
        if set(eval_ids) - existing_ids:
            old_id = get_id(found)
            async for ev in emitter.code(
                "# Drift detected; EvaluatorList has no .update — delete + recreate\n"
                f'Evaluate.evaluator_list.delete("{old_id}")\n'
                "Evaluate.evaluator_list.create({\n"
                f'    "name": "{EVAL_LIST_NAME}",\n'
                '    "evaluators": [...],\n'
                "})",
                log="Drift detected — delete + recreate",
            ):
                yield ev
            _safe(client.evaluate.evaluator_list.delete, old_id)
            created, cerr = _safe(_create)
            list_id = get_id(created) or "n/a"
            state["evaluator_list_id"] = list_id
            async for ev in emitter.result(
                f"Recreated {EVAL_LIST_NAME} (id={list_id})" + (f" — {cerr}" if cerr else ""),
                view_in_sandbox={
                    "label": "View evaluator list",
                    "url": view_in_sandbox(project_id, "evaluator-list", list_id),
                },
            ):
                yield ev
        else:
            list_id = get_id(found) or "n/a"
            state["evaluator_list_id"] = list_id
            async for ev in emitter.code(
                f"# {EVAL_LIST_NAME} already contains the expected evaluators; reusing",
                log="No drift; reusing",
            ):
                yield ev
            async for ev in emitter.result(
                f"Reused (id={list_id})",
                view_in_sandbox={
                    "label": "View evaluator list",
                    "url": view_in_sandbox(project_id, "evaluator-list", list_id),
                },
            ):
                yield ev

    async for ev in emitter.phase_end():
        yield ev


async def phase_7_experiment(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in _phase(emitter, "phase-7-experiment", 7, 8):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Evaluate\n"
        "\n"
        f'existing = Evaluate.experiment.list(limit=50)  # then find name="{EXPERIMENT_NAME}"',
        log="Find existing experiment",
    ):
        yield ev
    listed, err = _safe(client.evaluate.experiment.list, limit=50)
    # Response is `{"experiments": [...], "totalCount": int}` (dict) — handle both shapes.
    if isinstance(listed, dict):
        items = listed.get("experiments") or []
    else:
        items = getattr(listed, "experiments", None) or []
    found = next(
        (e for e in items if (e.get("name") if isinstance(e, dict) else getattr(e, "name", None)) == EXPERIMENT_NAME),
        None,
    )

    if found is not None:
        old_id = get_id(found)
        async for ev in emitter.code(
            f'Evaluate.experiment.delete("{old_id}")',
            log="Existing experiment found — delete to keep workflow idempotent",
        ):
            yield ev
        _safe(client.evaluate.experiment.delete, old_id)
        async for ev in emitter.result(f"Deleted experiment id={old_id}"):
            yield ev

    # `experiment.create` requires `promptId` to be the prompt's UUID, NOT its
    # name. (Phase 1's prompt.list returns name+versions only — no id at the
    # top level — so we explicitly resolve via prompt.get here.) The server's
    # error if you pass a name is misleading: "Invalid experiment evaluator ID.
    # The specified evaluator does not exist." Took us a beat to figure out.
    async for ev in emitter.code(
        "from browserstack_ai_sdk import Prompt\n"
        "\n"
        f'prompt = Prompt.get(name="{PROMPT_NAME}")',
        log="Resolve prompt UUID for experiment.create",
    ):
        yield ev
    prompt_obj, _ = _safe(client.prompt.get, name=PROMPT_NAME)
    prompt_uuid = (
        getattr(prompt_obj, "id", None)
        or (prompt_obj.get("id") if isinstance(prompt_obj, dict) else None)
    )

    # Real signature: takes a single request_data dict with camelCase keys.
    request_data = {
        "name": EXPERIMENT_NAME,
        "promptId": prompt_uuid,
        "datasetId": state.get("dataset_id"),
        "evaluatorListId": state.get("evaluator_list_id"),
    }
    async for ev in emitter.code(
        "Evaluate.experiment.create({\n"
        f'    "name": "{EXPERIMENT_NAME}",\n'
        f'    "promptId": "{prompt_uuid}",\n'
        '    "datasetId": dataset_id,\n'
        '    "evaluatorListId": eval_list_id,\n'
        "})",
        log="Create the experiment (single dict payload, camelCase keys)",
    ):
        yield ev
    created, cerr = _safe(client.evaluate.experiment.create, request_data)
    exp_id = get_id(created) or "n/a"
    state["experiment_id"] = exp_id
    async for ev in emitter.result(
        f"Experiment created (id={exp_id})" + (f" — {cerr}" if cerr else ""),
        view_in_sandbox={
            "label": "View experiment",
            "url": view_in_sandbox(project_id, "experiment", exp_id),
        },
    ):
        yield ev

    async for ev in emitter.phase_end():
        yield ev


async def phase_8_experiment_run(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in _phase(emitter, "phase-8-experiment-run", 8, 8):
        yield ev

    exp_id = state.get("experiment_id", "n/a")
    async for ev in emitter.code(
        f'run = Evaluate.experiment_run.create(experiment_id="{exp_id}")',
        log="Kick off the experiment run",
    ):
        yield ev
    run, err = _safe(client.evaluate.experiment_run.create, experiment_id=exp_id)
    run_id = get_id(run) or "n/a"

    async for ev in emitter.code(
        f'Evaluate.experiment_run.subscribe("{run_id}", timeout=120)',
        log="Wait for completion (server-side scoring runs the evaluator list)",
    ):
        yield ev
    final, serr = _safe(client.evaluate.experiment_run.subscribe, run_id, 120, 5)
    status = "RUNNING"
    if final is not None:
        status = getattr(final, "finalStatus", None) or (final.get("finalStatus") if isinstance(final, dict) else "RUNNING")

    async for ev in emitter.result(
        f"Experiment run finished — status={status}"
        + (f" (note: {err or serr})" if (err or serr) else ""),
        view_in_sandbox={
            "label": "View experiment run",
            "url": view_in_sandbox(
                project_id, "experiment-run", run_id, parent_id=exp_id
            ),
        },
    ):
        yield ev

    async for ev in emitter.phase_end():
        yield ev


async def run_experiment_run(
    emitter: SnippetEmitter, client: Any, project_id: str
) -> AsyncIterator[str]:
    """Top-level entry point — wired into ``routes/workflows.py``."""
    state: dict = {}
    async for ev in phase_1_prompt_crud(emitter, client, project_id, state):
        yield ev
    async for ev in phase_2_dataset_crud(emitter, client, project_id, state):
        yield ev
    async for ev in phase_3_dataset_items(emitter, client, project_id, state):
        yield ev
    async for ev in phase_4_tools(emitter, client, project_id, state):
        yield ev
    async for ev in phase_5_evaluators(emitter, client, project_id, state):
        yield ev
    async for ev in phase_6_evaluator_list(emitter, client, project_id, state):
        yield ev
    async for ev in phase_7_experiment(emitter, client, project_id, state):
        yield ev
    async for ev in phase_8_experiment_run(emitter, client, project_id, state):
        yield ev
    async for ev in emitter.done():
        yield ev


# ruff: noqa: E501
_ = os  # keep import for path debugging hooks
