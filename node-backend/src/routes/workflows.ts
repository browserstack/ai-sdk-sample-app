import { Router, type Request, type Response } from "express";

import { makeClient } from "../services/sdkClient.js";
import { SnippetEmitter } from "../services/snippetEmitter.js";
import { runDatasetRun } from "../workflows/datasetRun.js";
import { runEvalExecution } from "../workflows/evalExecution.js";
import { runExperimentRun } from "../workflows/experimentRun.js";
import { runPromptCompile } from "../workflows/promptCompile.js";

type StandardRunner = (emitter: SnippetEmitter, client: ReturnType<typeof makeClient>, projectId: string) => Promise<void>;
type PromptCompileRunner = (emitter: SnippetEmitter, client: ReturnType<typeof makeClient>, projectId: string, openaiKey: string, userVars?: Record<string, string> | null) => Promise<void>;

const VALID_WORKFLOWS: Record<string, StandardRunner | PromptCompileRunner> = {
  "experiment-run": runExperimentRun,
  "dataset-run": runDatasetRun,
  "eval-execution": runEvalExecution,
  "prompt-compile": runPromptCompile,
};

/**
 * POST /api/workflows/:name — streams the named workflow's phases as SSE.
 *
 * Body: { projectId: string }   (passed in by the frontend after Stage 2)
 * Headers: X-Sandbox-Public-Key, X-Sandbox-Secret-Key
 */
export const workflowsRouter: Router = Router();

workflowsRouter.post("/:name", async (req: Request, res: Response) => {
  const { name } = req.params;
  const runner = VALID_WORKFLOWS[name];
  if (!runner) {
    res.status(404).json({ error: `Unknown workflow '${name}'.` });
    return;
  }

  const publicKey = String(req.header("x-sandbox-public-key") ?? "");
  const secretKey = String(req.header("x-sandbox-secret-key") ?? "");
  const openaiKey = String(req.header("x-openai-key") ?? "");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const emitter = new SnippetEmitter(res, "workflow");

  if (!publicKey || !secretKey) {
    emitter.error("Missing Sandbox keys (X-Sandbox-Public-Key / X-Sandbox-Secret-Key).");
    return;
  }

  const projectId =
    (req.body && typeof req.body.projectId === "string" && req.body.projectId) ||
    "unknown-project";

  let client;
  try {
    client = makeClient(publicKey, secretKey);
  } catch (err) {
    emitter.error(`Failed to build SDK client: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    if (name === "prompt-compile") {
      const userVars = (req.body && typeof req.body.vars === "object" ? req.body.vars : null) as Record<string, string> | null;
      await (runner as PromptCompileRunner)(emitter, client, projectId, openaiKey, userVars);
    } else {
      await (runner as StandardRunner)(emitter, client, projectId);
    }
    emitter.done();
  } catch (err) {
    emitter.error(`Workflow ${name} crashed: ${err instanceof Error ? err.message : String(err)}`);
  }
});
