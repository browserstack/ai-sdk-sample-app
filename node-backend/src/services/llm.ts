import type { Request } from "express";

/**
 * Bag of credentials extracted from request headers.
 * Each value is null when the header is absent or blank.
 */
export interface ResolvedKeys {
  sandboxPublic: string | null;
  sandboxSecret: string | null;
  openai: string | null;
  anthropic: string | null;
}

/**
 * Stage-4 provider identifiers. Stage-3 (manual) only uses the first two.
 */
export type Provider =
  | "openai"
  | "anthropic"
  | "langchain-openai"
  | "langchain-anthropic";

/**
 * Resolved provider + model pair returned by `pickProvider`.
 * `provider` is widened to string so callers can pass the raw label through
 * to the response payload without re-narrowing.
 */
export interface ResolvedProvider {
  provider: string;
  model: string;
}

/**
 * Default models — must match CONTRACTS.md "Model dropdown options".
 */
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

/**
 * Reads a single header and returns its trimmed value, or null if absent.
 */
function header(req: Request, name: string): string | null {
  const raw = req.header(name);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pulls the four credential headers off the request.
 * Header names mirror CONTRACTS.md exactly.
 */
export function resolveKeys(req: Request): ResolvedKeys {
  return {
    sandboxPublic: header(req, "X-Sandbox-Public-Key"),
    sandboxSecret: header(req, "X-Sandbox-Secret-Key"),
    openai: header(req, "X-OpenAI-Key"),
    anthropic: header(req, "X-Anthropic-Key"),
  };
}

/**
 * Auto-pick (no override): OpenAI key wins, else Anthropic, else throw.
 *
 * With override (Stage 4): the caller picked a provider/model from the
 * dropdown. We validate the *underlying* key is present (langchain-openai
 * needs the OpenAI key, etc.) and return the override verbatim.
 *
 * Throws an Error whose message is suitable for a 400 response body.
 */
export function pickProvider(
  keys: ResolvedKeys,
  override?: { provider: Provider; model: string }
): ResolvedProvider {
  if (override) {
    const needsOpenAI =
      override.provider === "openai" || override.provider === "langchain-openai";
    const needsAnthropic =
      override.provider === "anthropic" ||
      override.provider === "langchain-anthropic";

    if (needsOpenAI && !keys.openai) {
      throw new Error(
        `Provider '${override.provider}' requires X-OpenAI-Key header.`
      );
    }
    if (needsAnthropic && !keys.anthropic) {
      throw new Error(
        `Provider '${override.provider}' requires X-Anthropic-Key header.`
      );
    }
    if (!needsOpenAI && !needsAnthropic) {
      throw new Error(`Unknown provider '${override.provider}'.`);
    }
    return { provider: override.provider, model: override.model };
  }

  if (keys.openai) {
    return { provider: "openai", model: DEFAULT_OPENAI_MODEL };
  }
  if (keys.anthropic) {
    return { provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL };
  }
  throw new Error("No LLM provider key supplied");
}
