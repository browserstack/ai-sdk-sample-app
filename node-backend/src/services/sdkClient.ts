/**
 * TestOps SDK client factory + Sandbox URL helpers.
 *
 * URL shapes match the canonical routes verified against
 * https://evals.browserstack.com.
 */
import { AISDK } from "@browserstack/ai-sdk";

export const SANDBOX_BASE_URL =
  process.env.TESTOPS_HOST ?? "https://evals.browserstack.com";

/** Per-request client. `TESTOPS_HOST` env var drives the base URL. */
export function makeClient(publicKey: string, secretKey: string): AISDK {
  return new AISDK({ publicKey, secretKey });
}

/**
 * Poll `GET /api/public/traces/<id>` until the span batch lands. Returns
 * `true` once the trace is queryable; `false` after the retry budget runs out.
 * Used to gate the "View trace" button so the user never lands on a 404.
 */
export async function traceExists(
  publicKey: string,
  secretKey: string,
  traceId: string,
  { maxAttempts = 6, delayMs = 500 }: { maxAttempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  if (!traceId) return false;
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const url = `${SANDBOX_BASE_URL}/api/public/traces/${traceId}`;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(2000),
      });
      if (resp.status === 200) return true;
      if (resp.status !== 404) return false;
    } catch {
      return false;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/**
 * Build a deep-link URL for the "View in Sandbox" button.
 *
 *   trace           → /logs/traces?peek=<trace_id>&timestamp=<iso>
 *   prompt          → /prompts/<name>           (name preferred over ID)
 *   dataset         → /datasets/<dataset_id>
 *   dataset-run     → /datasets/<dataset_id>/runs/<run_id>
 *   tool            → /tools/<tool_id>
 *   evaluator       → /evals-crud/<evaluator_id>
 *   evaluator-list  → /evals-crud                (specific-id route 404s)
 *   experiment      → /experiments/<experiment_id>
 *   experiment-run  → /experiments/<experiment_id>/runs
 *
 * For runs, pass the parent's ID via `parentId` and the run's ID via `artifactId`.
 */
export function viewInSandbox(
  projectId: string,
  kind: string,
  artifactId?: string,
  parentId?: string
): string {
  const base = `${SANDBOX_BASE_URL}/project/${projectId}`;
  const aid = artifactId ?? "";
  const pid = parentId ?? "";

  switch (kind) {
    case "trace": {
      if (!aid) return `${base}/logs/traces`;
      const ts = encodeURIComponent(new Date().toISOString());
      return `${base}/logs/traces?peek=${aid}&timestamp=${ts}`;
    }
    case "prompt":
      return aid ? `${base}/prompts/${aid}` : `${base}/prompts`;
    case "dataset":
      return aid ? `${base}/datasets/${aid}` : `${base}/datasets`;
    case "dataset-run":
      if (pid && aid) return `${base}/datasets/${pid}/runs/${aid}`;
      if (pid) return `${base}/datasets/${pid}/runs`;
      return `${base}/datasets`;
    case "tool":
      return aid ? `${base}/tools/${aid}` : `${base}/tools`;
    case "evaluator":
      return aid ? `${base}/evals-crud/${aid}` : `${base}/evals-crud`;
    case "evaluator-list":
      return `${base}/evals-crud`;
    case "experiment":
      return aid ? `${base}/experiments/${aid}` : `${base}/experiments`;
    case "experiment-run":
      // Always link to the experiment's runs list, not the individual run —
      // the per-run page sometimes 404s on freshly-created runs and the
      // runs list is more useful regardless.
      if (pid) return `${base}/experiments/${pid}/runs`;
      return `${base}/experiments`;
    default:
      return base;
  }
}
