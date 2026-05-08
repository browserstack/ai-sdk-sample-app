/**
 * Workflow 2 — Dataset Run (Confluence v0.1 Script 2).
 *
 * Four phases:
 *   1. Prompt CRUD            (support-bot-reranker text prompt)
 *   2. Prompt update          (label bump via client.prompt.update)
 *   3. Dataset prep           (list/create support-bot-reranker-eval)
 *   4. Dataset run execution  (per-item iteration is mocked for the walkthrough)
 */
import type { AISDK } from "@browserstack/ai-sdk";
import { SnippetEmitter } from "../services/snippetEmitter.js";
import { viewInSandbox } from "../services/sdkClient.js";

const PROMPT_NAME = "support-bot-reranker";
const DATASET_NAME = "support-bot-reranker-eval";

async function safe<T>(fn: () => Promise<T> | T): Promise<[T | null, string | null]> {
  try { return [await fn(), null]; }
  catch (err) { return [null, err instanceof Error ? err.message : String(err)]; }
}

function getId(x: unknown): string {
  if (x && typeof x === "object") {
    const r = x as Record<string, unknown>;
    if (typeof r.id === "string") return r.id;
  }
  return "n/a";
}
function getName(x: unknown): string | undefined {
  if (x && typeof x === "object") {
    const r = x as Record<string, unknown>;
    if (typeof r.name === "string") return r.name;
  }
  return undefined;
}

export async function runDatasetRun(
  emitter: SnippetEmitter,
  client: AISDK,
  projectId: string,
): Promise<void> {
  const state: Record<string, string> = {};

  // ---- Phase 1: Prompt CRUD ----
  emitter.phaseStart("phase-1-prompt-crud", 1, 4);
  emitter.code(
    `import { Prompt } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `// 1. Look it up first (Node SDK uses get + try/catch, no list)\n` +
    `try {\n` +
    `  await Prompt.get("${PROMPT_NAME}", undefined, { label: "latest" });\n` +
    `} catch {\n` +
    `  // 2. Not found — create it.\n` +
    `  await Prompt.create({\n` +
    `    name: "${PROMPT_NAME}",\n` +
    `    type: "text",\n` +
    `    prompt: "Re-rank these candidate answers by helpfulness.",\n` +
    `    labels: ["v1"],\n` +
    `  });\n` +
    `}`,
    { log: "Prompt CRUD — get-or-create" },
  );
  const promptApi = client.prompt as unknown as {
    create: (body: Record<string, unknown>) => Promise<{ id?: string }>;
    get: (name: string, version?: number, opts?: Record<string, unknown>) => Promise<unknown>;
  };

  const [found] = await safe(() => promptApi.get(PROMPT_NAME, undefined, { label: "latest" }));

  if (!found) {
    const [created, err] = await safe(() => promptApi.create({
      name: PROMPT_NAME, type: "text",
      prompt: "Re-rank these candidate answers by helpfulness.",
      labels: ["v1"],
    }));
    state.promptId = getId(created);
    emitter.result({
      log: err ? `Create failed: ${err}` : `Created '${PROMPT_NAME}' (id=${state.promptId})`,
      viewInSandbox: { label: "View prompt", url: viewInSandbox(projectId, "prompt", PROMPT_NAME) },
    });
  } else {
    state.promptId = getId(found);
    emitter.result({
      log: `Prompt '${PROMPT_NAME}' already exists — reusing (id=${state.promptId})`,
      viewInSandbox: { label: "View prompt", url: viewInSandbox(projectId, "prompt", PROMPT_NAME) },
    });
  }
  emitter.phaseEnd();

  // ---- Phase 2: Prompt versions (read-only) ----
  // Node SDK has no prompt.list(); we surface the prompt-versions concept by
  // reading the current label/version off the fetched prompt and explaining
  // that re-calling Prompt.create with the same name auto-bumps versions.
  emitter.phaseStart("phase-2-prompt-versions", 2, 4);
  emitter.code(
    `import { Prompt } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `// Re-fetch and inspect version metadata on the PromptClient.\n` +
    `const prompt = await Prompt.get("${PROMPT_NAME}", undefined, { label: "latest" });\n` +
    `// To bump a version: re-call Prompt.create with the same name and updated\n` +
    `// content — the server treats it as a new version automatically.`,
    { log: "Inspect current version + explain implicit versioning" },
  );
  const [vfetched, verr] = await safe(() => promptApi.get(PROMPT_NAME, undefined, { label: "latest" }));
  const versionInfo = vfetched && typeof vfetched === "object"
    ? (vfetched as { promptResponse?: { version?: number; label?: string }; version?: number; label?: string })
    : null;
  const currentVersion = versionInfo?.promptResponse?.version ?? versionInfo?.version;
  const currentLabel = versionInfo?.promptResponse?.label ?? versionInfo?.label;
  emitter.result({
    log: currentVersion
      ? `Current version: ${currentVersion}${currentLabel ? ` (label="${currentLabel}")` : ""}`
      : `Version metadata unavailable${verr ? ` (${verr})` : ""}`,
    viewInSandbox: { label: "View prompt", url: viewInSandbox(projectId, "prompt", PROMPT_NAME) },
  });
  emitter.phaseEnd();

  // ---- Phase 3: Dataset prep ----
  emitter.phaseStart("phase-3-dataset-prep", 3, 4);
  emitter.code(
    `import { Evaluate } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `const existing = await Evaluate.dataset.list(1, 50, "${DATASET_NAME}");`,
    { log: "Pick or create reranker eval dataset" },
  );
  const dsApi = (client as unknown as { evaluate: { dataset: {
    list: (page?: number, limit?: number, name?: string) => Promise<{ data?: unknown[] }>;
    create: (name: string, description?: string) => Promise<{ id?: string }>;
  } } }).evaluate.dataset;
  const [dsList] = await safe(() => dsApi.list(1, 50, DATASET_NAME));
  const dsItems = (dsList?.data ?? []) as unknown[];
  let dataset = dsItems.find((d) => getName(d) === DATASET_NAME);
  if (!dataset) {
    emitter.code(
      `await Evaluate.dataset.create({\n` +
      `  name: "${DATASET_NAME}",\n` +
      `  description: "Reranker eval inputs",\n` +
      `});`,
      { log: "Dataset missing; creating" },
    );
    const [created, derr] = await safe(() => dsApi.create(DATASET_NAME, "Reranker eval inputs"));
    dataset = created ?? undefined;
    state.datasetId = getId(created);
    emitter.result({
      log: derr ? `Create failed: ${derr}` : `Created (id=${state.datasetId})`,
      viewInSandbox: { label: "View dataset", url: viewInSandbox(projectId, "dataset", state.datasetId) },
    });
  } else {
    state.datasetId = getId(dataset);
    emitter.result({
      log: `Reused (id=${state.datasetId})`,
      viewInSandbox: { label: "View dataset", url: viewInSandbox(projectId, "dataset", state.datasetId) },
    });
  }
  emitter.phaseEnd();

  // ---- Phase 4: Dataset run execution ----
  emitter.phaseStart("phase-4-dataset-run", 4, 4);
  emitter.code(
    `const run = await Evaluate.datasetRun.create(\n` +
    `  "${DATASET_NAME}",\n` +
    `  {\n` +
    `    name: "reranker-walkthrough",\n` +
    `    tag: "walkthrough",\n` +
    `  },\n` +
    `);`,
    { log: "Create the dataset run" },
  );
  const drApi = (client as unknown as { evaluate: { datasetRun: {
    create: (datasetName: string, opts?: { name?: string; tag?: string }) => Promise<{ id?: string }>;
    createItems: (datasetName: string, runId: string, items: unknown[]) => Promise<unknown>;
    listItems: (datasetName: string, runId: string, page?: number, limit?: number) => Promise<unknown>;
  } } }).evaluate.datasetRun;

  const [run, rerr] = await safe(() => drApi.create(DATASET_NAME, {
    name: "reranker-walkthrough",
    tag: "walkthrough",
  }));
  const runId = getId(run);
  if (runId === "n/a") {
    emitter.error(`dataset run create failed: ${rerr ?? "unknown"}`);
    emitter.phaseEnd();
    return;
  }

  const runItems = [
    { input: "Where is order #4831?", expectedOutput: "shipped Monday" },
    { input: "How do I return a damaged item?", expectedOutput: "Use the returns portal." },
    { input: "What's your refund policy?", expectedOutput: "Within 30 days, full refund." },
  ];
  emitter.code(
    `await Evaluate.datasetRun.createItems(\n` +
    `  "${DATASET_NAME}",\n` +
    `  "${runId}",\n` +
    `  [\n` +
    `    { input: "...", expectedOutput: "..." },\n` +
    `    ... 2 more items ...\n` +
    `  ],\n` +
    `);`,
    { log: `Add ${runItems.length} items to the run` },
  );
  const [, ierr] = await safe(() => drApi.createItems(DATASET_NAME, runId, runItems));

  // Verify by listing items back.
  const [listedRunItems] = await safe(() => drApi.listItems(DATASET_NAME, runId, 1, 10));
  let listedCount = 0;
  if (listedRunItems && typeof listedRunItems === "object") {
    const arr = (listedRunItems as { items?: unknown[]; data?: unknown[] }).items
      ?? (listedRunItems as { items?: unknown[]; data?: unknown[] }).data;
    if (Array.isArray(arr)) listedCount = arr.length;
  }

  if (ierr) {
    emitter.error(`Run created (id=${runId}); item creation failed: ${ierr}`);
  } else {
    emitter.result({
      log: `Run created (id=${runId}) with ${listedCount} items verified via listItems()`,
      viewInSandbox: {
        label: "View dataset run",
        url: viewInSandbox(projectId, "dataset-run", runId, state.datasetId),
      },
    });
  }
  emitter.phaseEnd();
}
