"""Workflow 3 — Eval Execution (Confluence v0.1 Script 3).

Four phases:

    1. Source data ingestion (CSV/JSON)
    2. List evaluator lists; pick or create 'support-quality'
    3. Get evaluator list by id; show contained evaluators
    4. Execute evaluation per row via client.evals.evaluate(...)
"""
from __future__ import annotations

import csv
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from services.sdk_client import view_in_sandbox
from services.snippet_emitter import SnippetEmitter

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
EVAL_LIST_NAME = "support-quality"

EVALUATOR_SPECS = [
    {"name": "action-advancement", "type": "llm_custom",
     "prompt": "Did the assistant advance the user toward their goal? 1 if yes, 0 if no."},
    {"name": "tool-selection-quality", "type": "llm_custom",
     "prompt": "Did the assistant pick the right tool? 1 if yes, 0 if no."},
    {"name": "helpfulness", "type": "llm_custom",
     "prompt": "Rate helpfulness from 1 (unhelpful) to 5 (very helpful)."},
    {"name": "latency-under-2s", "type": "code",
     "code": "def evaluate(trace):\n    return 1 if trace.get('latency_ms', 9999) < 2000 else 0\n",
     "language": "python"},
]


def _safe(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs), None
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)


def _id(x):
    if isinstance(x, dict):
        return x.get("id") or "n/a"
    return getattr(x, "id", "n/a")


async def _phase_1(emitter: SnippetEmitter, client: Any, project_id: str, state: dict) -> AsyncIterator[str]:
    async for ev in emitter.phase_start("phase-1-source-data", 1, 4):
        yield ev

    async for ev in emitter.code(
        'with open("data/dataset.csv") as f:\n'
        '    rows = list(csv.DictReader(f))\n'
        'print(rows[:3])',
        log="Load eval input rows from CSV",
    ):
        yield ev

    rows: list[dict] = []
    csv_path = DATA_DIR / "dataset.csv"
    if csv_path.exists():
        with csv_path.open() as f:
            rows = list(csv.DictReader(f))
    else:
        json_path = DATA_DIR / "dataset.json"
        if json_path.exists():
            with json_path.open() as f:
                data = json.load(f)
            rows = [
                {"input": r.get("query", ""), "expected_tool": r.get("expected_tool"), "scope": "in"}
                for r in data.get("in_scope", [])
            ]

    state["rows"] = rows
    preview = json.dumps(rows[:3], ensure_ascii=False)
    async for ev in emitter.result(
        f"Loaded {len(rows)} rows; first 3: {preview}"
    ):
        yield ev

    async for ev in emitter.phase_end():
        yield ev


async def _phase_2(emitter: SnippetEmitter, client: Any, project_id: str, state: dict) -> AsyncIterator[str]:
    async for ev in emitter.phase_start("phase-2-evaluator-list", 2, 4):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Evaluate\n"
        "\n"
        "existing_lists = Evaluate.evaluator_list.list()",
        log="Find existing 'support-quality' list",
    ):
        yield ev
    listed, err = _safe(client.evaluate.evaluator_list.list)
    # Real shape: dict {"evaluators": [...], "totalCount": int}. Handle dict
    # AND object forms — earlier code only checked the object form, so the
    # bootstrap branch ran every time even when the list already existed.
    if isinstance(listed, dict):
        items = listed.get("evaluators") or listed.get("data") or []
    elif isinstance(listed, list):
        items = listed
    else:
        items = getattr(listed, "evaluators", None) or []
    found = next(
        (it for it in items if (it.get("name") if isinstance(it, dict) else getattr(it, "name", None)) == EVAL_LIST_NAME),
        None,
    )

    if found is None:
        async for ev in emitter.code(
            "from browserstack_ai_sdk import Evaluate\n"
            "\n"
            "# 'support-quality' missing — bootstrap inline so this workflow is\n"
            "# self-contained when Workflow 1 hasn't been run yet. Reuse evaluators\n"
            "# if they already exist in this project (server rejects duplicate names).\n"
            "existing = Evaluate.evaluator.list({\"limit\": 100})\n"
            "by_name = {e[\"name\"]: e[\"id\"] for e in (existing.get(\"evaluators\") or [])}\n"
            "evaluator_ids = []\n"
            "for spec in EVALUATOR_SPECS:\n"
            "    if spec[\"name\"] in by_name:\n"
            "        evaluator_ids.append(by_name[spec[\"name\"]])\n"
            "        continue\n"
            "    e = Evaluate.evaluator.create(spec)\n"
            "    evaluator_ids.append(e.id)\n"
            "Evaluate.evaluator_list.create({\n"
            f'    "name": "{EVAL_LIST_NAME}",\n'
            '    "evaluators": [{"evaluatorId": eid, "params": []} for eid in evaluator_ids],\n'
            "})",
            log="Bootstrap evaluators + list (reuse-if-exists)",
        ):
            yield ev
        # Reuse-if-exists: list current evaluators by name first, then only
        # create the ones that are missing. The server rejects create() with a
        # 409 if the name is already taken in this project, which would leave
        # us with an empty evaluator list and a broken eval-list create below.
        existing_listed, _ = _safe(client.evaluate.evaluator.list, {"limit": 100})
        if isinstance(existing_listed, dict):
            existing_evals = existing_listed.get("evaluators") or existing_listed.get("data") or []
        elif isinstance(existing_listed, list):
            existing_evals = existing_listed
        else:
            existing_evals = getattr(existing_listed, "evaluators", None) or []
        existing_by_name = {
            (e.get("name") if isinstance(e, dict) else getattr(e, "name", None)):
                (e.get("id") if isinstance(e, dict) else getattr(e, "id", None))
            for e in existing_evals
        }

        eval_ids: list[str] = []
        for spec in EVALUATOR_SPECS:
            if spec["name"] in existing_by_name and existing_by_name[spec["name"]]:
                eval_ids.append(existing_by_name[spec["name"]])
                continue
            if spec["type"] == "llm_custom":
                request = {
                    "type": "llm_custom",
                    "name": spec["name"],
                    "description": spec.get("description") or spec["name"],
                    "prompt": spec["prompt"],
                    "modelParams": {"provider": "openai", "model": "gpt-4o-mini", "adapter": "openai"},
                    "parameters": {
                        "score_reasoning_prompt": "Briefly explain your reasoning.",
                        "score_range_prompt": "Provide a discrete score of 0 or 1",
                    },
                }
            else:
                request = {
                    "type": "code",
                    "name": spec["name"],
                    "description": spec.get("description") or spec["name"],
                    "language": spec.get("language", "javascript"),
                    "code": spec["code"],
                }
            res, ee = _safe(client.evaluate.evaluator.create, request)
            eid = _id(res)
            if eid != "n/a":
                eval_ids.append(eid)
            else:
                async for ev in emitter.code(
                    f'# evaluator.create({spec["name"]}) failed: {ee}',
                    log=f"evaluator.create({spec['name']}) failed: {ee}",
                ):
                    yield ev
        # Real signature: evaluator_list.create(request_data) single dict;
        # each evaluator entry needs {evaluatorId, params: []}.
        created, cerr = _safe(
            client.evaluate.evaluator_list.create,
            {
                "name": EVAL_LIST_NAME,
                "evaluators": [{"evaluatorId": eid, "params": []} for eid in eval_ids],
            },
        )
        list_id = _id(created)
        state["evaluator_list_id"] = list_id
        async for ev in emitter.result(
            f"Created '{EVAL_LIST_NAME}' (id={list_id})" + (f" — {cerr}" if cerr else ""),
            view_in_sandbox={"label": "View evaluator list", "url": view_in_sandbox(project_id, "evaluator-list", list_id)},
        ):
            yield ev
    else:
        list_id = _id(found)
        state["evaluator_list_id"] = list_id
        async for ev in emitter.code(
            f'# Found existing list (id={list_id}); reusing',
            log="Reusing existing list",
        ):
            yield ev
        async for ev in emitter.result(
            f"Reused '{EVAL_LIST_NAME}' (id={list_id})",
            view_in_sandbox={"label": "View evaluator list", "url": view_in_sandbox(project_id, "evaluator-list", list_id)},
        ):
            yield ev

    async for ev in emitter.phase_end():
        yield ev


async def _phase_3(emitter: SnippetEmitter, client: Any, project_id: str, state: dict) -> AsyncIterator[str]:
    async for ev in emitter.phase_start("phase-3-evaluator-list-get", 3, 4):
        yield ev

    list_id = state.get("evaluator_list_id", "n/a")
    async for ev in emitter.code(
        "from browserstack_ai_sdk import Evaluate\n"
        "\n"
        f'fetched = Evaluate.evaluator_list.get("{list_id}")\n'
        "# Walk evaluatorConfigs[] to get each evaluatorId, then fetch full\n"
        "# evaluator rows so we can build the rich payload for Phase 4.\n"
        'configs = fetched.get("evaluatorConfigs") or []\n'
        'evaluator_ids = [c.get("evaluatorId") for c in configs if c.get("evaluatorId")]\n'
        "evaluators_for_execution = []\n"
        "for eid in evaluator_ids:\n"
        "    ev = Evaluate.evaluator.get(eid)\n"
        "    entry = {\n"
        '        "metricName": ev["name"],\n'
        '        "displayName": ev["name"],\n'
        '        "family": ev.get("family"),\n'
        '        "runtimeProvider": ev.get("runtimeProvider"),\n'
        '        "evaluatorId": eid,\n'
        '        "params": {},\n'
        "    }\n"
        '    if ev.get("code"): entry["codeText"] = ev["code"]\n'
        '    if ev.get("language"): entry["codeLanguage"] = ev["language"]\n'
        "    evaluators_for_execution.append(entry)",
        log="Walk evaluatorConfigs, fetch each evaluator, build payload for evaluation_execution",
    ):
        yield ev
    fetched, err = _safe(client.evaluate.evaluator_list.get, list_id)
    configs: list = []
    if fetched is not None:
        if isinstance(fetched, dict):
            configs = fetched.get("evaluatorConfigs") or []
        else:
            configs = getattr(fetched, "evaluatorConfigs", None) or []

    evaluator_ids: list[str] = []
    for c in configs:
        eid = c.get("evaluatorId") if isinstance(c, dict) else getattr(c, "evaluatorId", None)
        if eid:
            evaluator_ids.append(eid)

    evaluators_for_execution: list[dict] = []
    evaluator_details: list[dict] = []
    for eid in evaluator_ids:
        ev_obj, _ = _safe(client.evaluate.evaluator.get, eid)
        if ev_obj is None:
            continue
        name = ev_obj.get("name") if isinstance(ev_obj, dict) else getattr(ev_obj, "name", None)
        family = ev_obj.get("family") if isinstance(ev_obj, dict) else getattr(ev_obj, "family", None)
        runtime = ev_obj.get("runtimeProvider") if isinstance(ev_obj, dict) else getattr(ev_obj, "runtimeProvider", None)
        code_text = ev_obj.get("code") if isinstance(ev_obj, dict) else getattr(ev_obj, "code", None)
        code_lang = ev_obj.get("language") if isinstance(ev_obj, dict) else getattr(ev_obj, "language", None)
        evaluator_details.append({"id": eid, "name": name})
        entry: dict = {
            "metricName": name,
            "displayName": name,
            "family": family,
            "runtimeProvider": runtime,
            "evaluatorId": eid,
            "params": {},
        }
        if code_text:
            entry["codeText"] = code_text
        if code_lang:
            entry["codeLanguage"] = code_lang
        evaluators_for_execution.append(entry)

    state["evaluators_for_execution"] = evaluators_for_execution
    state["evaluator_details"] = evaluator_details

    names = [d["name"] for d in evaluator_details if d.get("name")]
    async for ev in emitter.result(
        f"List contains {len(evaluator_details)} evaluators: {', '.join(names) if names else '(empty)'}"
        + (f" — {err}" if err else "")
    ):
        yield ev

    async for ev in emitter.phase_end():
        yield ev


async def _phase_4(emitter: SnippetEmitter, client: Any, project_id: str, state: dict) -> AsyncIterator[str]:
    async for ev in emitter.phase_start("phase-4-eval-execute", 4, 4):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Evaluate\n"
        "\n"
        "for row in rows:\n"
        "    Evaluate.evaluation_execution.evaluate({\n"
        '        "evaluators": evaluators_for_execution,\n'
        '        "data": {\n'
        '            "input": row["input"],\n'
        '            "output": row.get("output", ""),\n'
        '            "expectedOutput": row.get("expected_tool", ""),\n'
        "        },\n"
        '        "concurrency": 1,\n'
        "    })",
        log="Run the evaluator list against each row via evaluation_execution.evaluate",
    ):
        yield ev

    rows = state.get("rows", [])
    evaluators_for_execution = state.get("evaluators_for_execution", [])

    score_total: dict[str, list[float]] = {}
    errors = 0
    for row in rows:
        if not evaluators_for_execution:
            break
        request = {
            "evaluators": evaluators_for_execution,
            "data": {
                "input": row.get("input", ""),
                "output": row.get("output", ""),
                "expectedOutput": row.get("expected_tool", "") or "",
            },
            "concurrency": 1,
        }
        res, perr = _safe(client.evaluate.evaluation_execution.evaluate, request)
        if perr is not None:
            errors += 1
            continue
        results = (res.get("results") or []) if isinstance(res, dict) else (getattr(res, "results", []) or [])
        for r in results:
            metric = (
                (r.get("metricName") or r.get("evaluator")) if isinstance(r, dict)
                else (getattr(r, "metricName", None) or getattr(r, "evaluator", None))
            )
            score = r.get("score") if isinstance(r, dict) else getattr(r, "score", None)
            if metric is not None and isinstance(score, int | float):
                score_total.setdefault(metric, []).append(float(score))

    summary_lines = []
    for metric, vals in score_total.items():
        if vals:
            summary_lines.append(f"{metric}: avg={sum(vals)/len(vals):.2f} ({len(vals)} runs)")
    summary = "; ".join(summary_lines) if summary_lines else "no scores returned"

    async for ev in emitter.result(
        f"Evaluated {len(rows)} rows; errors={errors}; {summary}"
    ):
        yield ev

    async for ev in emitter.phase_end():
        yield ev


async def run_eval_execution(
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
