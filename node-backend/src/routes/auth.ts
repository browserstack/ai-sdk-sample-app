import { Router, type Request, type Response } from "express";
import { makeClient, SANDBOX_BASE_URL } from "../services/sdkClient.js";
import { SnippetEmitter } from "../services/snippetEmitter.js";

/**
 * POST /api/auth/validate — Stage 2.
 *
 * Constructs the SDK client and probes Sandbox via
 * `client.experiments.list({ limit: 1 })`. The first experiment's `projectId`
 * is surfaced so the frontend can thread it into Stages 4 + 6.
 */
export const authRouter: Router = Router();

function mask(key: string | undefined): string {
  if (!key) return "***";
  return key.slice(0, 8) + "***";
}

authRouter.post("/validate", async (req: Request, res: Response) => {
  const publicKey = (req.header("X-Sandbox-Public-Key") ?? "").trim();
  const secretKey = (req.header("X-Sandbox-Secret-Key") ?? "").trim();
  const emit = new SnippetEmitter(res, "auth");

  emit.phaseStart("auth-probe", 1, 1);
  emit.code(`const client = new AISDK({ publicKey: "${mask(publicKey)}", secretKey: "${mask(secretKey)}" });`);
  emit.code(`const result = await client.experiments.list(1);`);

  if (!publicKey || !secretKey) {
    emit.error("Missing Sandbox keys.");
    return;
  }

  let result: unknown;
  try {
    const client = makeClient(publicKey, secretKey);
    // Node SDK signature: list(limit?, page?) → ListExperimentsResponse.
    result = await client.experiments.list(1);
  } catch (err) {
    emit.error((err as Error).message ?? String(err));
    return;
  }

  const experiments =
    (result as { experiments?: Array<Record<string, unknown>> } | null)?.experiments ?? [];
  const projectId = (experiments[0]?.projectId as string | undefined) ?? "";

  let log: string;
  let label: string;
  let url: string;
  if (projectId) {
    log = `Authenticated. Project ID: ${projectId}`;
    label = "Open project";
    url = `${SANDBOX_BASE_URL}/project/${projectId}`;
  } else {
    log = "Authenticated, but no experiments found yet. Create at least one artifact in Sandbox to surface a project ID.";
    label = "Open Sandbox";
    url = `${SANDBOX_BASE_URL}/projects`;
  }

  res.write(
    `event: result\ndata: ${JSON.stringify({
      type: "result",
      stage: "auth",
      status: "done",
      phase_id: "auth-probe",
      phase_index: 1,
      phase_total: 1,
      log,
      projectId,
      view_in_sandbox: { label, url },
    })}\n\n`
  );

  emit.phaseEnd();
  emit.done();
});
