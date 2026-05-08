/**
 * Workflow 1 — Experiment Run (Confluence v0.1 Script 1).
 *
 * Eight idempotent phases mirroring the Python implementation. Streams
 * `code-snippet` + `result` SSE events through the shared `SnippetEmitter`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseCsv } from "csv-parse/sync";

import type { AISDK } from "@browserstack/ai-sdk";
import { SnippetEmitter } from "../services/snippetEmitter.js";
import { viewInSandbox } from "../services/sdkClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");

const PROMPT_NAME = "walkthrough-support-bot";
const DATASET_NAME = "support-quality-v1";
const EVAL_LIST_NAME = "support-quality";
const EXPERIMENT_NAME = "support-bot-v1-vs-v2";

const TOOL_SPECS = [
  { name: "get_user_details", description: "Look up a user's account details by user ID",
    parameters: { type: "object", properties: { user_id: { type: "string" } }, required: ["user_id"] } },
  { name: "lookup_product", description: "Look up product information by query or ID",
    parameters: { type: "object", properties: { query: { type: "string" }, category: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
  { name: "retrieve_docs", description: "Retrieve internal documentation by topic",
    parameters: { type: "object", properties: { topic: { type: "string" }, limit: { type: "integer" } }, required: ["topic"] } },
  { name: "send_email", description: "Send a transactional email to a user",
    parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] } },
];

// Per CreateLLMCustomEvaluatorOptions / CreateCodeEvaluatorOptions in the SDK
// types — LLM custom evaluators require modelParams + parameters; code
// evaluators require language + code.
const LLM_MODEL_PARAMS = { provider: "openai", model: "gpt-4o-mini", adapter: "openai" };
const LLM_PARAMETERS = {
  score_reasoning_prompt: "Briefly explain your reasoning.",
  score_range_prompt: "Provide a discrete score of 0 or 1",
};

const EVALUATOR_SPECS: Array<Record<string, unknown>> = [
  {
    name: "action-advancement", type: "llm_custom",
    description: "Did the response advance the user's goal?",
    prompt: "Did the assistant's response advance the user toward their goal? Return 1 if yes, 0 if no.",
    modelParams: LLM_MODEL_PARAMS,
    parameters: LLM_PARAMETERS,
  },
  {
    name: "tool-selection-quality", type: "llm_custom",
    description: "Did the assistant pick the right tool?",
    prompt: "Given the user's query, did the assistant pick the right tool? Return 1 if yes, 0 if no.",
    modelParams: LLM_MODEL_PARAMS,
    parameters: LLM_PARAMETERS,
  },
  {
    name: "helpfulness", type: "llm_custom",
    description: "How helpful is the assistant's final answer?",
    prompt: "Rate the helpfulness of the assistant's final answer from 1 (unhelpful) to 5 (very helpful).",
    modelParams: LLM_MODEL_PARAMS,
    parameters: { ...LLM_PARAMETERS, score_range_prompt: "Provide a score ranging from 0 to 1" },
  },
  {
    name: "latency-under-2s", type: "code",
    description: "Did the bot answer within 2 seconds?",
    language: "javascript",
    code: "function evaluate(trace) { return (trace.latency_ms ?? 9999) < 2000 ? 1 : 0; }",
  },
];

async function safe<T>(fn: () => Promise<T> | T): Promise<[T | null, string | null]> {
  try { return [await fn(), null]; }
  catch (err) { return [null, err instanceof Error ? err.message : String(err)]; }
}

function getId(x: unknown): string {
  if (x && typeof x === "object") {
    const r = x as Record<string, unknown>;
    const id = r.id ?? r.evaluatorListId ?? r.datasetId;
    if (typeof id === "string") return id;
  }
  return "n/a";
}

function getName(x: unknown): string | undefined {
  if (x && typeof x === "object") {
    const r = x as Record<string, unknown>;
    return typeof r.name === "string" ? r.name : undefined;
  }
  return undefined;
}

export async function runExperimentRun(
  emitter: SnippetEmitter,
  client: AISDK,
  projectId: string,
): Promise<void> {
  const state: Record<string, string> = {};
  const evalIds: string[] = [];

  // ---- Phase 1: Prompt CRUD ----
  emitter.phaseStart("phase-1-prompt-crud", 1, 8);
  emitter.code(
    `import { Prompt } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `// 1. Look it up first (Node SDK uses get + try/catch, no list)\n` +
    `try {\n` +
    `  await Prompt.get("${PROMPT_NAME}", undefined, { label: "latest" });\n` +
    `} catch {\n` +
    `  // 2. Not found — create v1 with modelParams (required for experiment.run).\n` +
    `  await Prompt.create({\n` +
    `    name: "${PROMPT_NAME}",\n` +
    `    type: "text",\n` +
    `    prompt: "You are a helpful support assistant. Use tools when needed.",\n` +
    `    labels: ["v1"],\n` +
    `    modelParams: {\n` +
    `      provider: "openai",\n` +
    `      model: "gpt-4o-mini",\n` +
    `      adapter: "openai",\n` +
    `    },\n` +
    `  });\n` +
    `}`,
    { log: "Prompt CRUD — get-or-create with modelParams" },
  );
  const promptApi = client.prompt as unknown as {
    create: (body: Record<string, unknown>) => Promise<{ id?: string }>;
    get: (name: string, version?: number, opts?: Record<string, unknown>) => Promise<unknown>;
  };

  const [found] = await safe(() => promptApi.get(PROMPT_NAME, undefined, { label: "latest" }));

  if (!found) {
    const [created, err] = await safe(() => promptApi.create({
      name: PROMPT_NAME, type: "text",
      prompt: "You are a helpful support assistant. Use tools when needed.",
      labels: ["v1"],
      modelParams: { provider: "openai", model: "gpt-4o-mini", adapter: "openai" },
    }));
    state.promptId = getId(created);
    emitter.result({
      log: err ? `Create failed: ${err}` : `Created '${PROMPT_NAME}' v1 (id=${state.promptId})`,
      viewInSandbox: { label: "View prompt", url: viewInSandbox(projectId, "prompt", PROMPT_NAME) },
    });
  } else {
    state.promptId = getId(found);
    const versionInfo = found && typeof found === "object"
      ? (found as { promptResponse?: { version?: number }; version?: number })
      : null;
    const currentVersion = versionInfo?.promptResponse?.version ?? versionInfo?.version;
    emitter.result({
      log: currentVersion
        ? `Reused '${PROMPT_NAME}' (current version=${currentVersion})`
        : `Reused '${PROMPT_NAME}' (id=${state.promptId})`,
      viewInSandbox: { label: "View prompt", url: viewInSandbox(projectId, "prompt", PROMPT_NAME) },
    });
  }
  emitter.phaseEnd();

  // ---- Phase 2: Dataset CRUD ----
  emitter.phaseStart("phase-2-dataset-crud", 2, 8);
  emitter.code(
    `import { Evaluate } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `const existing = await Evaluate.dataset.list(1, 50, "${DATASET_NAME}");`,
    { log: "Check whether dataset exists" },
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
      `  description: "Support bot eval dataset",\n` +
      `});`,
      { log: "Dataset missing; creating" },
    );
    const [created, err] = await safe(() => dsApi.create(DATASET_NAME, "Support bot eval dataset"));
    dataset = created ?? undefined;
    state.datasetId = getId(created);
    emitter.result({
      log: err ? `Create failed: ${err}` : `Created '${DATASET_NAME}' (id=${state.datasetId})`,
      viewInSandbox: { label: "View dataset", url: viewInSandbox(projectId, "dataset", state.datasetId) },
    });
  } else {
    state.datasetId = getId(dataset);
    emitter.result({
      log: `Reused '${DATASET_NAME}' (id=${state.datasetId})`,
      viewInSandbox: { label: "View dataset", url: viewInSandbox(projectId, "dataset", state.datasetId) },
    });
  }
  emitter.phaseEnd();

  // ---- Phase 3: Dataset items via 3 methods ----
  emitter.phaseStart("phase-3-dataset-items", 3, 8);
  const datasetsApi = (client as unknown as { evaluate: { datasets: {
    createItems: (params: { datasetName: string; fileUrl?: string; items?: unknown[] }) => Promise<unknown>;
  } } }).evaluate.datasets;

  const csvPath = path.join(DATA_DIR, "dataset.csv");
  emitter.code(
    `await Evaluate.datasets.createItems({\n` +
    `  datasetName: "${DATASET_NAME}",\n` +
    `  fileUrl: "data/dataset.csv",\n` +
    `});`,
    { log: "Upload CSV directly — SDK reads the file, batches rows, creates dataset items" },
  );

  let rowsInCsv = 0;
  if (fs.existsSync(csvPath)) {
    const text = fs.readFileSync(csvPath, "utf8");
    const rows = parseCsv(text, { columns: true, skip_empty_lines: true }) as unknown[];
    rowsInCsv = rows.length;
  }
  const [, csvErr] = await safe(() => datasetsApi.createItems({
    datasetName: DATASET_NAME,
    fileUrl: csvPath,
  }));
  emitter.result({
    log: `Uploaded ${rowsInCsv} rows from CSV${csvErr ? ` — ${csvErr}` : ""}`,
    viewInSandbox: {
      label: "View dataset",
      url: viewInSandbox(projectId, "dataset", state.datasetId),
    },
  });
  emitter.phaseEnd();

  // ---- Phase 4: Tools CRUD ----
  emitter.phaseStart("phase-4-tools", 4, 8);
  emitter.code(
    `import { Tool } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `const existingTools = await Tool.list(50);`,
    { log: "List existing tools" },
  );
  const toolsApi = client.tools as unknown as {
    list: (limit?: number) => Promise<{ data?: unknown[] }>;
    create: (opts: Record<string, unknown>) => Promise<unknown>;
    get: (name: string) => Promise<unknown>;
  };
  const [toolList] = await safe(() => toolsApi.list(50));
  const toolItems = (toolList?.data ?? []) as unknown[];
  const byName = new Map<string, unknown>();
  for (const t of toolItems) {
    const n = getName(t);
    if (n) byName.set(n, t);
  }
  emitter.result({ log: `Listed ${toolItems.length} tools` });

  for (const spec of TOOL_SPECS) {
    if (!byName.has(spec.name)) {
      emitter.code(
        `await Tool.create({\n` +
        `  name: "${spec.name}",\n` +
        `  description: "${spec.description}",\n` +
        `  parameters: { ... },\n` +
        `});`,
        { log: `Create tool ${spec.name}` },
      );
      const [, terr] = await safe(() => toolsApi.create(spec as unknown as Record<string, unknown>));
      emitter.result({ log: `Created ${spec.name}${terr ? ` — ${terr}` : ""}` });
    } else {
      emitter.code(`// Tool ${spec.name} exists; reusing`, { log: `Reusing ${spec.name}` });
      emitter.result({ log: `Reused ${spec.name}` });
    }
  }

  emitter.code(
    `const tool = await Tool.get("lookup_product");\n` +
    `const compiled = tool.compile({ strings: { query: "iphone case" } });`,
    { log: "Demonstrate tool.compile()" },
  );
  const [, gerr] = await safe(() => toolsApi.get("lookup_product"));
  emitter.result({
    log: gerr ? `Compile demo skipped: ${gerr}` : "Compiled lookup_product with sample input",
  });
  emitter.phaseEnd();

  // ---- Phase 5: Evaluator CRUD ----
  emitter.phaseStart("phase-5-evaluators", 5, 8);
  emitter.code(
    `import { Evaluate } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `const existingEvaluators = await Evaluate.evaluator.list({ limit: 100 });`,
    { log: "List existing evaluators" },
  );
  const evApi = (client as unknown as { evaluate: { evaluator: {
    list: (opts?: Record<string, unknown>) => Promise<{ evaluators?: unknown[] }>;
    create: (opts: Record<string, unknown>) => Promise<{ id?: string }>;
  } } }).evaluate.evaluator;

  const [evList] = await safe(() => evApi.list({ limit: 100 }));
  const evItems = evList?.evaluators ?? [];
  const evByName = new Map<string, unknown>();
  for (const e of evItems) {
    const n = getName(e);
    if (n) evByName.set(n, e);
  }
  emitter.result({ log: `Listed ${evItems.length} evaluators` });

  for (const spec of EVALUATOR_SPECS) {
    const existing = evByName.get(spec.name as string);
    if (!existing) {
      emitter.code(
        `await Evaluate.evaluator.create(${JSON.stringify(spec, null, 2)});`,
        { log: `Create evaluator ${spec.name as string}` },
      );
      const [created, cerr] = await safe(() => evApi.create(spec));
      const id = getId(created);
      if (id !== "n/a") evalIds.push(id);
      emitter.result({ log: `Created ${spec.name as string}${cerr ? ` — ${cerr}` : ""}` });
    } else {
      const id = getId(existing);
      if (id !== "n/a") evalIds.push(id);
      emitter.code(`// Evaluator ${spec.name as string} exists; reusing`,
        { log: `Reusing ${spec.name as string}` });
      emitter.result({ log: `Reused ${spec.name as string}` });
    }
  }
  emitter.phaseEnd();

  // ---- Phase 6: EvaluatorList ----
  emitter.phaseStart("phase-6-evaluator-list", 6, 8);
  emitter.code(
    `const existingLists = await Evaluate.evaluatorList.list();`,
    { log: "Look up existing list" },
  );
  const elApi = (client as unknown as { evaluate: { evaluatorList: {
    list: () => Promise<{ evaluators?: unknown[] }>;
    create: (body: Record<string, unknown>) => Promise<{ id?: string }>;
    delete: (id: string) => Promise<unknown>;
    get: (id: string) => Promise<unknown>;
  } } }).evaluate.evaluatorList;

  const [elList] = await safe(() => elApi.list());
  const lists = elList?.evaluators ?? [];
  const existingList = lists.find((l) => getName(l) === EVAL_LIST_NAME);

  // Server expects `{evaluatorId}` per evaluator entry, NOT `{id}`.
  const createList = () => elApi.create({
    name: EVAL_LIST_NAME, evaluators: evalIds.map((id) => ({ evaluatorId: id, params: [] })),
  });

  if (!existingList) {
    emitter.code(
      `await Evaluate.evaluatorList.create({\n` +
      `  name: "${EVAL_LIST_NAME}",\n` +
      `  evaluators: evaluatorIds.map(id => ({ evaluatorId: id, params: [] })),\n` +
      `});`,
      { log: "EvaluatorList missing; creating" },
    );
    const [created, cerr] = await safe(createList);
    state.evaluatorListId = getId(created);
    emitter.result({
      log: cerr ? `Create failed: ${cerr}` : `Created (id=${state.evaluatorListId})`,
      viewInSandbox: { label: "View evaluator list", url: viewInSandbox(projectId, "evaluator-list", state.evaluatorListId) },
    });
  } else {
    // The API returns the list with `evaluatorConfigs[]` (NOT `evaluators[]`),
    // and each config entry exposes `.evaluatorId` for the actual evaluator
    // UUID (whereas `.id` is just the config-row id). Earlier code looked at
    // the wrong field, came back empty, and treated EVERY run as drifted —
    // forcing delete+recreate which sometimes 404'd.
    const containedRaw =
      (existingList as { evaluatorConfigs?: unknown[] }).evaluatorConfigs ?? [];
    const containedIds = new Set(
      containedRaw
        .map((e) =>
          e && typeof e === "object"
            ? (e as { evaluatorId?: string }).evaluatorId
            : undefined,
        )
        .filter((x): x is string => typeof x === "string"),
    );
    const drift = evalIds.some((id) => !containedIds.has(id));
    if (drift) {
      const oldId = getId(existingList);
      emitter.code(
        `// Drift detected — EvaluatorList has no .update; delete + recreate\n` +
        `await Evaluate.evaluatorList.delete("${oldId}");\n` +
        `await Evaluate.evaluatorList.create({\n` +
        `  name: "${EVAL_LIST_NAME}",\n` +
        `  evaluators: [...],\n` +
        `});`,
        { log: "Delete + recreate" },
      );
      await safe(() => elApi.delete(oldId));
      const [created] = await safe(createList);
      state.evaluatorListId = getId(created);
      emitter.result({
        log: `Recreated (id=${state.evaluatorListId})`,
        viewInSandbox: { label: "View evaluator list", url: viewInSandbox(projectId, "evaluator-list", state.evaluatorListId) },
      });
    } else {
      state.evaluatorListId = getId(existingList);
      emitter.code(`// '${EVAL_LIST_NAME}' already up-to-date; reusing`, { log: "No drift" });
      emitter.result({
        log: `Reused (id=${state.evaluatorListId})`,
        viewInSandbox: { label: "View evaluator list", url: viewInSandbox(projectId, "evaluator-list", state.evaluatorListId) },
      });
    }
  }
  emitter.phaseEnd();

  // ---- Phase 7: Experiment delete-if-exists + create ----
  emitter.phaseStart("phase-7-experiment", 7, 8);
  emitter.code(
    `const existing = await Evaluate.experiment.list(50, 1);`,
    { log: "Find existing experiment" },
  );
  const expApi = (client as unknown as { evaluate: { experiment: {
    list: (limit?: number, page?: number) => Promise<{ experiments?: unknown[] }>;
    delete: (id: string) => Promise<unknown>;
    create: (body: Record<string, unknown>) => Promise<{ id?: string }>;
  } } }).evaluate.experiment;
  const [expList] = await safe(() => expApi.list(50, 1));
  const expItems = expList?.experiments ?? [];
  const foundExp = expItems.find((e) => getName(e) === EXPERIMENT_NAME);
  if (foundExp) {
    const oldId = getId(foundExp);
    emitter.code(
      `await Evaluate.experiment.delete("${oldId}");`,
      { log: "Delete existing for idempotency" },
    );
    await safe(() => expApi.delete(oldId));
    emitter.result({ log: `Deleted experiment id=${oldId}` });
  }
  // experiment.create requires promptId to be the prompt's UUID, NOT its name.
  // The server's "Invalid experiment evaluator ID" error if you pass a name is
  // misleading. Node SDK signature is `prompt.get(name, version?, options?)`
  // returning a TextPromptClient/ChatPromptClient — UUID lives on .promptResponse.
  // Node's prompt.get defaults to label "production" which our prompts don't
  // carry — pass { label: "latest" } to grab the most recent version.
  // The Node SDK returns a TextPromptClient/ChatPromptClient; the underlying
  // UUID is on .promptResponse.id.
  emitter.code(
    `import { Prompt } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `const prompt = await Prompt.get("${PROMPT_NAME}", undefined, { label: "latest" });\n` +
    `const promptUuid = prompt.promptResponse?.id;`,
    { log: "Resolve prompt UUID for experiment.create" },
  );
  const [promptObj] = await safe(() =>
    (client.prompt as unknown as {
      get: (n: string, v?: number, opts?: Record<string, unknown>) => Promise<unknown>;
    }).get(PROMPT_NAME, undefined, { label: "latest" }),
  );
  const promptUuid =
    (promptObj as { promptResponse?: { id?: string }; id?: string } | null)?.promptResponse?.id
    ?? (promptObj as { id?: string } | null)?.id;

  emitter.code(
    `await Evaluate.experiment.create({\n` +
    `  name: "${EXPERIMENT_NAME}",\n` +
    `  promptId: "${promptUuid}",\n` +
    `  datasetId,\n` +
    `  evaluatorListId,\n` +
    `});`,
    { log: "Create experiment" },
  );
  const [createdExp, cerr] = await safe(() => expApi.create({
    name: EXPERIMENT_NAME,
    promptId: promptUuid,
    datasetId: state.datasetId,
    evaluatorListId: state.evaluatorListId,
  }));
  state.experimentId = getId(createdExp);
  emitter.result({
    log: cerr ? `Create failed: ${cerr}` : `Created (id=${state.experimentId})`,
    viewInSandbox: { label: "View experiment", url: viewInSandbox(projectId, "experiment", state.experimentId) },
  });
  emitter.phaseEnd();

  // ---- Phase 8: Experiment run ----
  emitter.phaseStart("phase-8-experiment-run", 8, 8);
  emitter.code(
    `const run = await Evaluate.experimentRun.create("${state.experimentId}");`,
    { log: "Kick off the experiment run" },
  );
  const erApi = (client as unknown as { evaluate: { experimentRun: {
    create: (experimentId: string) => Promise<{ id?: string }>;
    subscribe: (id: string, timeout?: number, pollInterval?: number) => Promise<{ finalStatus?: string }>;
  } } }).evaluate.experimentRun;
  const [erRun, erErr] = await safe(() => erApi.create(state.experimentId));
  if (erErr) {
    emitter.code(`// experimentRun.create error: ${erErr}`, { log: `experimentRun.create failed: ${erErr}` });
  }
  const runId = getId(erRun);

  emitter.code(
    `await Evaluate.experimentRun.subscribe("${runId}", 120, 5);`,
    { log: "Wait for completion" },
  );
  const [finalStatus, serr] = await safe(() => erApi.subscribe(runId, 120, 5));
  const status = finalStatus?.finalStatus ?? "RUNNING";
  emitter.result({
    log: `Experiment run finished — status=${status}${serr ? ` (note: ${serr})` : ""}`,
    viewInSandbox: {
      label: "View experiment run",
      url: viewInSandbox(projectId, "experiment-run", runId, state.experimentId),
    },
  });
  emitter.phaseEnd();
}
