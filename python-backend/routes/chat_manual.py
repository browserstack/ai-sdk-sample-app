"""Stage 3 — Manual tracing chat.

Streams the SDK ``client.trace()`` lifecycle as SSE events around a real LLM
call. The same OpenAI / Anthropic logic from Phase A is preserved; we just wrap
it with manual trace + generation + score calls and emit a ``code-snippet`` per
SDK call so the frontend can teach.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator
from typing import Any

import anthropic
import openai
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from fastapi.responses import StreamingResponse

from services.llm import pick_provider, resolve_keys
from services.sdk_client import make_client, trace_exists, view_in_sandbox
from services.snippet_emitter import SnippetEmitter


def _full_script(provider: str, model: str, pk_masked: str, sk_masked: str) -> str:
  if provider == "openai":
    call_block = "\n".join([
      "import openai",
      "",
      'llm = openai.OpenAI(api_key="sk-***")',
      "",
      "completion = llm.chat.completions.create(",
      f'    model="{model}",',
      "    messages=messages,",
      ")",
      "reply = completion.choices[0].message.content",
    ])
    usage_block = "\n".join([
      "gen.update(",
      "    output=reply,",
      "    usage_details={",
      '        "input_tokens": completion.usage.prompt_tokens,',
      '        "output_tokens": completion.usage.completion_tokens,',
      "    },",
      ")",
    ])
  else:  # anthropic
    call_block = "\n".join([
      "import anthropic",
      "",
      'llm = anthropic.Anthropic(api_key="sk-ant-***")',
      "",
      "response = llm.messages.create(",
      f'    model="{model}",',
      "    max_tokens=1024,",
      "    messages=messages,",
      ")",
      "reply = response.content[0].text",
    ])
    usage_block = "\n".join([
      "gen.update(",
      "    output=reply,",
      "    usage_details={",
      '        "input_tokens": response.usage.input_tokens,',
      '        "output_tokens": response.usage.output_tokens,',
      "    },",
      ")",
    ])

  return "\n".join([
    "from browserstack_ai_sdk import AISDK",
    "",
    "client = AISDK(",
    f'    public_key="{pk_masked}",',
    f'    secret_key="{sk_masked}",',
    ")",
    "",
    "trace = client.trace(",
    '    name="support-bot:chat",',
    "    input=user_message,",
    ")",
    "gen = trace.start_generation(",
    '    name="llm-call",',
    f'    model="{model}",',
    "    prompt=messages,",
    ")",
    "",
    call_block,
    "",
    usage_block,
    "gen.end()",
    "",
    'trace.score(name="verbose", value=1)',
    "trace.update(output=reply)",
  ])

router = APIRouter()


class ChatMessage(BaseModel):
  role: str
  content: str


class ManualChatBody(BaseModel):
  message: str
  history: list[ChatMessage] = Field(default_factory=list)
  provider: str | None = None
  model: str | None = None
  projectId: str | None = None


def _frame(event_type: str, payload: dict) -> str:
  return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


def _mask(key: str | None) -> str:
  if not key:
    return "***"
  return key[:8] + "***"


def _build_messages(message: str, history: list[ChatMessage]) -> list[dict[str, str]]:
  msgs = [{"role": m.role, "content": m.content} for m in history]
  msgs.append({"role": "user", "content": message})
  return msgs


def _call_llm(provider: str, model: str, api_key: str, messages: list[dict[str, str]]) -> tuple[str, dict[str, int]]:
  if provider == "openai":
    client = openai.OpenAI(api_key=api_key)
    completion = client.chat.completions.create(model=model, messages=messages)  # type: ignore[arg-type]
    reply = completion.choices[0].message.content or ""
    usage = completion.usage
    return reply, {
      "input_tokens": getattr(usage, "prompt_tokens", 0),
      "output_tokens": getattr(usage, "completion_tokens", 0),
    }
  if provider == "anthropic":
    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(model=model, max_tokens=1024, messages=messages)  # type: ignore[arg-type]
    reply = ""
    for block in response.content:
      if getattr(block, "type", None) == "text":
        reply = getattr(block, "text", "")
        break
    return reply, {
      "input_tokens": getattr(response.usage, "input_tokens", 0),
      "output_tokens": getattr(response.usage, "output_tokens", 0),
    }
  raise ValueError(f"Unsupported provider '{provider}' for manual chat.")


async def _manual_stream(
  body: ManualChatBody,
  keys: dict[str, str | None],
) -> AsyncIterator[str]:
  emitter = SnippetEmitter(stage="chat-manual", language="python")
  async for ev in emitter.phase_start("manual-trace", 1, 1):
    yield ev

  public_key = keys.get("sandbox_public") or ""
  secret_key = keys.get("sandbox_secret") or ""

  # Manual chat wraps the LLM call in client.trace() spans, so we always call
  # the provider's native SDK directly (LangChain wire names collapse to their
  # underlying family).
  requested = body.provider or ""
  family = requested
  if requested.startswith("langchain-"):
    family = requested.split("-", 1)[1]

  if family in ("openai", "anthropic") and keys.get(family):
    provider = family
    default_model = "gpt-4o-mini" if family == "openai" else "claude-haiku-4-5"
    model = body.model or default_model
  else:
    try:
      provider, model = pick_provider(keys)
    except Exception as exc:  # noqa: BLE001
      async for ev in emitter.error(str(exc)):
        yield ev
      yield _frame("done", {"type": "done"})
      return

  api_key = keys.get(provider) or ""
  messages = _build_messages(body.message, body.history)

  try:
    client = make_client(public_key, secret_key)
  except Exception as exc:  # noqa: BLE001
    async for ev in emitter.error(f"Failed to build SDK client: {exc}"):
      yield ev
    yield _frame("done", {"type": "done"})
    return

  async for ev in emitter.code(
    _full_script(provider, model, _mask(public_key), _mask(secret_key)),
  ):
    yield ev

  trace = client.trace(
    name="support-bot:chat",
    input=body.message,
    metadata={"stage": 3},
  )
  gen = trace.start_generation(name="llm-call", model=model, prompt=messages)

  try:
    reply, usage = _call_llm(provider, model, api_key, messages)
  except Exception as exc:  # noqa: BLE001
    async for ev in emitter.error(f"LLM call failed: {exc}"):
      yield ev
    yield _frame("done", {"type": "done"})
    return

  with contextlib.suppress(Exception):
    gen.update(output=reply, usage_details=usage)
    gen.end()

  score_value = 1 if len(reply) > 50 else 0
  with contextlib.suppress(Exception):
    trace.score(name="verbose", value=score_value)
  with contextlib.suppress(Exception):
    trace.update(output=reply)

  # Span exports go through a batch processor, so flush before polling the
  # public trace endpoint. Only show the View button if the server confirms
  # the trace exists — gates against 404s.
  with contextlib.suppress(Exception):
    client.flush()

  trace_url: str | None = None
  trace_id = getattr(trace, "trace_id", None) or getattr(trace, "id", None)
  if trace_id and body.projectId and await trace_exists(public_key, secret_key, trace_id):
    trace_url = view_in_sandbox(body.projectId, "trace", trace_id)

  payload: dict[str, Any] = {
    "type": "result",
    "stage": "chat-manual",
    "status": "done",
    "phase_id": "manual-trace",
    "phase_index": 1,
    "phase_total": 1,
    "log": reply,
    "provider": provider,
    "model": model,
    "usage": usage,
  }
  if trace_url:
    payload["view_in_sandbox"] = {"label": "View trace in Sandbox", "url": trace_url}
  yield _frame("result", payload)

  async for ev in emitter.phase_end():
    yield ev
  yield _frame("done", {"type": "done"})


@router.post("/api/chat/manual")
async def chat_manual(body: ManualChatBody, request: Request) -> StreamingResponse:
  """Stream a manually-traced chat turn as SSE."""
  keys = resolve_keys(request)
  return StreamingResponse(_manual_stream(body, keys), media_type="text/event-stream")
