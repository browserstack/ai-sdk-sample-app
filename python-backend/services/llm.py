"""LLM provider/key resolution helpers.

These helpers parse the per-request headers documented in CONTRACTS.md and pick
the (provider, model) the chat endpoints should call.

Phase A constraint: nothing in this module imports the TestOps SDK. Endpoints
call OpenAI / Anthropic / LangChain directly using the user-supplied keys.
"""

from __future__ import annotations

from typing import Literal

from fastapi import HTTPException, Request

# Provider literal mirrors the values the frontend can send for /api/chat/auto.
Provider = Literal["openai", "anthropic", "langchain-openai", "langchain-anthropic"]

# Default model per provider — matches MODEL_OPTIONS in CONTRACTS.md.
DEFAULT_MODEL: dict[str, str] = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-haiku-4-5",
    "langchain-openai": "gpt-4o-mini",
    "langchain-anthropic": "claude-haiku-4-5",
}


def resolve_keys(request: Request) -> dict[str, str | None]:
    """Extract the four sandbox/LLM keys from request headers.

    Returns a dict with keys ``sandbox_public``, ``sandbox_secret``, ``openai``,
    ``anthropic``. Any header not present is returned as ``None``.
    """
    headers = request.headers
    return {
        "sandbox_public": headers.get("X-Sandbox-Public-Key"),
        "sandbox_secret": headers.get("X-Sandbox-Secret-Key"),
        "openai": headers.get("X-OpenAI-Key"),
        "anthropic": headers.get("X-Anthropic-Key"),
    }


def pick_provider(
    keys: dict[str, str | None],
    override_provider: str | None = None,
    override_model: str | None = None,
) -> tuple[str, str]:
    """Decide which (provider, model) pair to use for a chat call.

    Auto-pick rule (no override):
        - X-OpenAI-Key set     -> ("openai", "gpt-4o-mini")
        - else X-Anthropic-Key -> ("anthropic", "claude-haiku-4-5")
        - else                 -> 400

    Override (Stage 4): caller passes ``override_provider`` (one of the four
    values in :data:`Provider`) and optionally ``override_model``. The
    corresponding key must exist or this raises 400.
    """
    if override_provider is not None:
        if override_provider not in DEFAULT_MODEL:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown provider '{override_provider}'.",
            )

        needs_openai_key = override_provider in ("openai", "langchain-openai")
        needs_anthropic_key = override_provider in ("anthropic", "langchain-anthropic")
        if needs_openai_key and not keys.get("openai"):
            raise HTTPException(
                status_code=400,
                detail=f"Provider '{override_provider}' requires X-OpenAI-Key header.",
            )
        if needs_anthropic_key and not keys.get("anthropic"):
            raise HTTPException(
                status_code=400,
                detail=f"Provider '{override_provider}' requires X-Anthropic-Key header.",
            )

        model = override_model or DEFAULT_MODEL[override_provider]
        return override_provider, model

    if keys.get("openai"):
        return "openai", DEFAULT_MODEL["openai"]
    if keys.get("anthropic"):
        return "anthropic", DEFAULT_MODEL["anthropic"]

    raise HTTPException(status_code=400, detail="No LLM provider key supplied.")
