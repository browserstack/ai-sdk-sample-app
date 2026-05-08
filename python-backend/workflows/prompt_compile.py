"""Workflow 4 — Prompt Compile + LLM call.

Four phases:

    1. Prompt CRUD     — find or create a templated text prompt with {{vars}}
    2. Prompt fetch    — client.prompt.get(name=...) returns a PromptClient
    3. Prompt compile  — prompt.compile(var=value) renders the template
    4. LLM call        — feed the compiled string to the LLM and surface output
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from services.sdk_client import view_in_sandbox
from services.snippet_emitter import SnippetEmitter

PROMPT_NAME = "support-reply-generator"
PROMPT_TEMPLATE = (
    "You are a senior customer support agent for an online retailer. "
    "Write a concise, {{tone}} reply to a customer named {{customer_name}} "
    "who reached out with the following issue:\n\n"
    "\"{{issue}}\"\n\n"
    "Address them by name, acknowledge the problem, propose one concrete "
    "next step, and end on a warm note. Keep the reply under 90 words."
)
SAMPLE_VARS = {
    "tone": "empathetic and professional",
    "customer_name": "Priya",
    "issue": "My order #4831 was supposed to arrive yesterday but the tracking still says 'in transit'. I need it before my flight on Friday.",
}


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

    # Always show the full create snippet — even if the prompt already exists,
    # the user wants to see HOW it would be created. We just add a log line
    # explaining whether we actually created or reused.
    snippet = "\n".join([
        "from browserstack_ai_sdk import Prompt",
        "",
        "# 1. Look it up first",
        f'existing = Prompt.list(name="{PROMPT_NAME}", limit=10)',
        "",
        "# 2. Create only if missing — re-creating with new content",
        "#    auto-bumps the version on the server.",
        "Prompt.create(",
        f'    name="{PROMPT_NAME}",',
        '    type="text",',
        '    prompt="""' + PROMPT_TEMPLATE + '""",',
        '    labels=["production"],',
        "    model_params={",
        '        "provider": "openai",',
        '        "model": "gpt-4o-mini",',
        '        "adapter": "openai",',
        "    },",
        ")",
    ])
    async for ev in emitter.code(snippet, log="Prompt CRUD — list then create-if-missing"):
        yield ev

    listed, err = _safe(client.prompt.list, name=PROMPT_NAME, limit=10)
    items = listed if isinstance(listed, list) else (getattr(listed, "data", None) or [])
    found = next(
        (
            p for p in items
            if (p.get("name") if isinstance(p, dict) else getattr(p, "name", None)) == PROMPT_NAME
        ),
        None,
    )

    if found is None:
        created, cerr = _safe(
            client.prompt.create,
            name=PROMPT_NAME,
            type="text",
            prompt=PROMPT_TEMPLATE,
            labels=["production"],
            model_params={"provider": "openai", "model": "gpt-4o-mini", "adapter": "openai"},
        )
        prompt_id = _id(created)
        log_msg = f"Created prompt '{PROMPT_NAME}' (id={prompt_id})" + (f" — {cerr}" if cerr else "")
    else:
        prompt_id = _id(found)
        log_msg = (
            f"Prompt '{PROMPT_NAME}' already exists — using the fetched version "
            f"from the list instead of creating a new one (id={prompt_id})"
            + (f" — {err}" if err else "")
        )

    state["prompt_id"] = prompt_id
    async for ev in emitter.result(
        log_msg,
        view_in_sandbox={"label": "View prompt", "url": view_in_sandbox(project_id, "prompt", PROMPT_NAME)},
    ):
        yield ev
    async for ev in emitter.phase_end():
        yield ev


async def _phase_2(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in emitter.phase_start("phase-2-prompt-fetch", 2, 4):
        yield ev

    async for ev in emitter.code(
        "from browserstack_ai_sdk import Prompt\n"
        "\n"
        f'prompt = Prompt.get(name="{PROMPT_NAME}")\n'
        "# returns a PromptClient exposing the template + a .compile() method",
        log="Fetch the prompt object",
    ):
        yield ev
    prompt_obj, err = _safe(client.prompt.get, name=PROMPT_NAME)
    if err or prompt_obj is None:
        async for ev in emitter.error(f"prompt.get failed: {err or 'none returned'}"):
            yield ev
        async for ev in emitter.phase_end():
            yield ev
        return

    template = (
        prompt_obj.get("prompt") if isinstance(prompt_obj, dict)
        else getattr(prompt_obj, "prompt", None)
    ) or PROMPT_TEMPLATE
    state["prompt_obj"] = prompt_obj
    state["prompt_template"] = template

    preview = template[:120] + ("…" if len(template) > 120 else "")
    async for ev in emitter.result(
        f"Fetched prompt; template = {preview!r}",
        view_in_sandbox={"label": "View prompt", "url": view_in_sandbox(project_id, "prompt", PROMPT_NAME)},
    ):
        yield ev
    async for ev in emitter.phase_end():
        yield ev


async def _phase_3(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict
) -> AsyncIterator[str]:
    async for ev in emitter.phase_start("phase-3-prompt-compile", 3, 4):
        yield ev

    vars_for_compile = state.get("user_vars") or SAMPLE_VARS
    var_lines = ",\n".join(f'    {k}="{v}"' for k, v in vars_for_compile.items())
    var_names = ", ".join("{{" + k + "}}" for k in vars_for_compile.keys())
    async for ev in emitter.code(
        "compiled = prompt.compile(\n"
        f"{var_lines},\n"
        ")\n"
        f"# substitutes {var_names} into the template string",
        log="Compile the template with the supplied variables",
    ):
        yield ev

    prompt_obj = state.get("prompt_obj")
    compiled, err = _safe(prompt_obj.compile, **vars_for_compile) if prompt_obj else (None, "no prompt object")
    if err or compiled is None:
        async for ev in emitter.error(f"compile failed: {err or 'none returned'}"):
            yield ev
        async for ev in emitter.phase_end():
            yield ev
        return

    state["compiled_prompt"] = compiled
    preview = compiled[:160] + ("…" if len(compiled) > 160 else "")
    async for ev in emitter.result(f"Compiled output: {preview!r}"):
        yield ev
    async for ev in emitter.phase_end():
        yield ev


async def _phase_4(
    emitter: SnippetEmitter, client: Any, project_id: str, state: dict, openai_key: str
) -> AsyncIterator[str]:
    async for ev in emitter.phase_start("phase-4-llm-call", 4, 4):
        yield ev

    compiled = state.get("compiled_prompt")
    if not compiled:
        async for ev in emitter.error("No compiled prompt to send to LLM."):
            yield ev
        async for ev in emitter.phase_end():
            yield ev
        return

    async for ev in emitter.code(
        "import openai\n"
        'llm = openai.OpenAI(api_key="sk-***")\n'
        "completion = llm.chat.completions.create(\n"
        '    model="gpt-4o-mini",\n'
        '    messages=[{"role": "user", "content": compiled}],\n'
        ")\n"
        "reply = completion.choices[0].message.content",
        log="Send the compiled prompt to OpenAI",
    ):
        yield ev

    if not openai_key:
        async for ev in emitter.error("Missing OpenAI key on this request."):
            yield ev
        async for ev in emitter.phase_end():
            yield ev
        return

    try:
        import openai
        llm = openai.OpenAI(api_key=openai_key)
        completion = llm.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": compiled}],
        )
        reply = completion.choices[0].message.content or ""
    except Exception as exc:  # noqa: BLE001
        async for ev in emitter.error(f"OpenAI call failed: {exc}"):
            yield ev
        async for ev in emitter.phase_end():
            yield ev
        return

    preview = reply[:400] + ("…" if len(reply) > 400 else "")
    async for ev in emitter.result(f"LLM reply: {preview}"):
        yield ev
    async for ev in emitter.phase_end():
        yield ev


async def run_prompt_compile(
    emitter: SnippetEmitter,
    client: Any,
    project_id: str,
    openai_key: str,
    user_vars: dict | None = None,
) -> AsyncIterator[str]:
    state: dict = {"user_vars": user_vars if isinstance(user_vars, dict) and user_vars else None}
    async for ev in _phase_1(emitter, client, project_id, state):
        yield ev
    async for ev in _phase_2(emitter, client, project_id, state):
        yield ev
    async for ev in _phase_3(emitter, client, project_id, state):
        yield ev
    async for ev in _phase_4(emitter, client, project_id, state, openai_key):
        yield ev
    async for ev in emitter.done():
        yield ev
