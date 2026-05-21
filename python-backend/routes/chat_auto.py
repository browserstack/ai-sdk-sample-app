"""Stage 4 — Auto tracing chat.

Streams the LLM call as SSE while relying on TestOps SDK auto-instrumentation
(activated implicitly when the client is constructed). After the call we ask
the SDK for the current trace ID and surface a deep-link.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator
from typing import Any

import anthropic
import openai
from browserstack_ai_sdk import Observe
from fastapi import APIRouter, Request
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field
from fastapi.responses import StreamingResponse

from services.llm import pick_provider, resolve_keys
from services.sdk_client import make_client, trace_exists, view_in_sandbox
from services.snippet_emitter import SnippetEmitter

_observe_initialized = False

router = APIRouter()


class ChatMessage(BaseModel):
  role: str
  content: str


class AutoChatBody(BaseModel):
  message: str
  history: list[ChatMessage] = Field(default_factory=list)
  provider: str
  model: str | None = None
  projectId: str | None = None


def _frame(event_type: str, payload: dict) -> str:
  return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


def _mask(key: str | None) -> str:
  if not key:
    return "***"
  return key[:8] + "***"


def _flatten(message: str, history: list[ChatMessage]) -> list[dict[str, str]]:
  msgs = [{"role": m.role, "content": m.content} for m in history]
  msgs.append({"role": "user", "content": message})
  return msgs


def _to_langchain(messages: list[dict[str, str]]) -> list[Any]:
  out: list[Any] = []
  for m in messages:
    role = m["role"]
    content = m["content"]
    if role == "system":
      out.append(SystemMessage(content=content))
    elif role == "assistant":
      out.append(AIMessage(content=content))
    else:
      out.append(HumanMessage(content=content))
  return out


def _call(provider: str, model: str, api_key: str, messages: list[dict[str, str]]) -> tuple[str, dict[str, int]]:
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
  if provider == "langchain-openai":
    chat = ChatOpenAI(api_key=api_key, model=model)  # type: ignore[arg-type]
    response = chat.invoke(_to_langchain(messages))
    reply = response.content if isinstance(response.content, str) else str(response.content)
    metadata = getattr(response, "usage_metadata", None) or {}
    return reply, {
      "input_tokens": metadata.get("input_tokens", 0),
      "output_tokens": metadata.get("output_tokens", 0),
    }
  if provider == "langchain-anthropic":
    chat = ChatAnthropic(api_key=api_key, model=model, max_tokens=1024)  # type: ignore[arg-type,call-arg]
    response = chat.invoke(_to_langchain(messages))
    reply = response.content if isinstance(response.content, str) else str(response.content)
    metadata = getattr(response, "usage_metadata", None) or {}
    return reply, {
      "input_tokens": metadata.get("input_tokens", 0),
      "output_tokens": metadata.get("output_tokens", 0),
    }
  raise ValueError(f"Unsupported provider '{provider}'.")


def _full_script(provider: str, model: str, pk_masked: str, sk_masked: str) -> str:
  if provider == "openai":
    provider_block = "\n".join([
      "import openai",
      "",
      'llm = openai.OpenAI(api_key="sk-***")',
      "",
      "completion = llm.chat.completions.create(",
      f'    model="{model}",',
      "    messages=messages,",
      ")",
    ])
  elif provider == "anthropic":
    provider_block = "\n".join([
      "import anthropic",
      "",
      'llm = anthropic.Anthropic(api_key="sk-ant-***")',
      "",
      "response = llm.messages.create(",
      f'    model="{model}",',
      "    max_tokens=1024,",
      "    messages=messages,",
      ")",
    ])
  elif provider == "langchain-openai":
    provider_block = "\n".join([
      "from langchain_openai import ChatOpenAI",
      "",
      "chat = ChatOpenAI(",
      '    api_key="sk-***",',
      f'    model="{model}",',
      ")",
      "response = chat.invoke(messages)",
    ])
  elif provider == "langchain-anthropic":
    provider_block = "\n".join([
      "from langchain_anthropic import ChatAnthropic",
      "",
      "chat = ChatAnthropic(",
      '    api_key="sk-ant-***",',
      f'    model="{model}",',
      "    max_tokens=1024,",
      ")",
      "response = chat.invoke(messages)",
    ])
  else:
    provider_block = f"# unknown provider {provider}"

  return "\n".join([
    "from browserstack_ai_sdk import AISDK, Observe",
    "",
    "# Installs OTel hooks for openai / anthropic / langchain.",
    "Observe.init()",
    "",
    "client = AISDK(",
    f'    public_key="{pk_masked}",',
    f'    secret_key="{sk_masked}",',
    ")",
    "",
    provider_block,
  ])


async def _auto_stream(
  body: AutoChatBody,
  keys: dict[str, str | None],
) -> AsyncIterator[str]:
  global _observe_initialized
  emitter = SnippetEmitter(stage="chat-auto", language="python")
  async for ev in emitter.phase_start("auto-trace", 1, 1):
    yield ev

  public_key = keys.get("sandbox_public") or ""
  secret_key = keys.get("sandbox_secret") or ""

  # Observe.init() is what installs OTel auto-instrumentation hooks for
  # OpenAI / Anthropic / LangChain. Lazy-init so Stage 3 manual tracing stays
  # clean — only fires on first auto-chat call.
  if not _observe_initialized:
    try:
      Observe.init(public_key=public_key, secret_key=secret_key)
      _observe_initialized = True
    except Exception as exc:  # noqa: BLE001
      async for ev in emitter.error(f"Observe.init failed: {exc}"):
        yield ev
      yield _frame("done", {"type": "done"})
      return

  try:
    provider, model = pick_provider(
      keys,
      override_provider=body.provider,
      override_model=body.model,
    )
  except Exception as exc:  # noqa: BLE001
    async for ev in emitter.error(str(exc)):
      yield ev
    yield _frame("done", {"type": "done"})
    return

  api_key_name = "openai" if provider in ("openai", "langchain-openai") else "anthropic"
  api_key = keys.get(api_key_name) or ""

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

  if provider in ("langchain-openai", "langchain-anthropic"):
    payload: dict[str, Any] = {
      "type": "log",
      "stage": "chat-auto",
      "status": "running",
      "phase_id": "auto-trace",
      "phase_index": 1,
      "phase_total": 1,
      "log": (
        "Note: Python SDK does not dedup LangChain + direct OpenAI overlap; "
        "using only the LangChain client here."
      ),
    }
    yield _frame("log", payload)

  messages = _flatten(body.message, body.history)

  try:
    reply, usage = _call(provider, model, api_key, messages)
  except Exception as exc:  # noqa: BLE001
    async for ev in emitter.error(f"LLM call failed: {exc}"):
      yield ev
    yield _frame("done", {"type": "done"})
    return

  # Flush so the auto-instrumented spans land before we poll the public API.
  with contextlib.suppress(Exception):
    client.flush()

  trace_url: str | None = None
  try:
    trace_id = Observe.get_trace_id()
  except Exception:  # noqa: BLE001
    trace_id = None
  if (
    trace_id
    and body.projectId
    and await trace_exists(public_key, secret_key, trace_id)
  ):
    trace_url = view_in_sandbox(body.projectId, "trace", trace_id)

  result_payload: dict[str, Any] = {
    "type": "result",
    "stage": "chat-auto",
    "status": "done",
    "phase_id": "auto-trace",
    "phase_index": 1,
    "phase_total": 1,
    "log": reply,
    "provider": provider,
    "model": model,
    "usage": usage,
  }
  if trace_url:
    result_payload["view_in_sandbox"] = {
      "label": "View auto-trace in Sandbox",
      "url": trace_url,
    }
  yield _frame("result", result_payload)

  async for ev in emitter.phase_end():
    yield ev
  yield _frame("done", {"type": "done"})


@router.post("/api/chat/auto")
async def chat_auto(body: AutoChatBody, request: Request) -> StreamingResponse:
  """Stream an auto-traced chat turn as SSE."""
  keys = resolve_keys(request)
  return StreamingResponse(_auto_stream(body, keys), media_type="text/event-stream")
