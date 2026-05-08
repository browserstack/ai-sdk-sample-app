/**
 * Workflow 3 — Eval Execution (Confluence v0.1 Script 3).
 *
 * Four phases: source data ingest -> evaluator-list lookup/bootstrap ->
 * evaluator-list inspect -> per-row evaluation execution.
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

const EVAL_LIST_NAME = "support-quality";

const EVALUATOR_SPECS: Array<Record<string, unknown>> = [
  { name: "action-advancement", type: "llm_custom",
    prompt: "Did the assistant advance the user toward their goal? 1 if yes, 0 if no." },
  { name: "tool-selection-quality", type: "llm_custom",
    prompt: "Did the assistant pick the right tool? 1 if yes, 0 if no." },
  { name: "helpfulness", type: "llm_custom",
    prompt: "Rate helpfulness from 1 (unhelpful) to 5 (very helpful)." },
  { name: "latency-under-2s", type: "code", language: "javascript",
    code: "function evaluate(trace) { return (trace.latency_ms ?? 9999) < 2000 ? 1 : 0; }" },
];

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

interface Row { input: string; expected_tool?: string | null; output?: string; scope?: string }

export async function runEvalExecution(
  emitter: SnippetEmitter,
  client: AISDK,
  projectId: string,
): Promise<void> {
  interface EvaluatorEntry {
    metricName?: string;
    displayName?: string;
    family?: string;
    runtimeProvider?: string;
    evaluatorId: string;
    params: Record<string, unknown>;
    codeText?: string;
    codeLanguage?: string;
  }
  const state: {
    rows: Row[];
    evaluatorListId: string;
    evaluatorsForExecution: EvaluatorEntry[];
    evaluatorDetails: Array<{ id: string; name?: string }>;
  } = {
    rows: [],
    evaluatorListId: "n/a",
    evaluatorsForExecution: [],
    evaluatorDetails: [],
  };

  // ---- Phase 1: Source data ingest ----
  emitter.phaseStart("phase-1-source-data", 1, 4);
  emitter.code(
    `const text = fs.readFileSync("data/dataset.csv", "utf8");\n` +
    `const rows = parse(text, { columns: true });\n` +
    `console.log(rows.slice(0, 3));`,
    { log: "Load eval input rows from CSV" },
  );
  const csvPath = path.join(DATA_DIR, "dataset.csv");
  if (fs.existsSync(csvPath)) {
    const text = fs.readFileSync(csvPath, "utf8");
    const rows = parseCsv(text, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
    state.rows = rows.map((r) => ({
      input: r.input ?? "",
      expected_tool: r.expected_tool ?? "",
      scope: r.scope ?? "in",
    }));
  } else {
    const jsonPath = path.join(DATA_DIR, "dataset.json");
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { in_scope?: Array<{ query: string; expected_tool: string | null }> };
      state.rows = (data.in_scope ?? []).map((r) => ({
        input: r.query, expected_tool: r.expected_tool ?? "", scope: "in",
      }));
    }
  }
  emitter.result({
    log: `Loaded ${state.rows.length} rows; first 3: ${JSON.stringify(state.rows.slice(0, 3))}`,
  });
  emitter.phaseEnd();

  // ---- Phase 2: Evaluator list lookup or bootstrap ----
  emitter.phaseStart("phase-2-evaluator-list", 2, 4);
  emitter.code(
    `import { Evaluate } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `const existingLists = await Evaluate.evaluatorList.list();`,
    { log: "Look up 'support-quality'" },
  );
  const elApi = (client as unknown as { evaluate: { evaluatorList: {
    list: () => Promise<{ evaluators?: unknown[] }>;
    create: (body: Record<string, unknown>) => Promise<{ id?: string }>;
    get: (id: string) => Promise<unknown>;
  } } }).evaluate.evaluatorList;
  const evApi = (client as unknown as { evaluate: { evaluator: {
    list: (opts?: Record<string, unknown>) => Promise<{ evaluators?: unknown[]; data?: unknown[] }>;
    create: (body: Record<string, unknown>) => Promise<{ id?: string }>;
  } } }).evaluate.evaluator;

  const [listed] = await safe(() => elApi.list());
  // Real shape: { evaluators: [...], totalCount: number } — handle dict and
  // array forms. Reading only `.evaluators` on a non-conforming response left
  // us with [] every time, so the bootstrap path kept running and 409'ing.
  const lists: unknown[] = Array.isArray(listed)
    ? (listed as unknown[])
    : (listed?.evaluators ?? (listed as { data?: unknown[] })?.data ?? []);
  let found = lists.find((l) => getName(l) === EVAL_LIST_NAME);

  if (!found) {
    emitter.code(
      `import { Evaluate } from "@browserstack/ai-sdk";\n` +
      `\n` +
      `// 'support-quality' missing — bootstrap inline so this workflow stays\n` +
      `// self-contained when Workflow 1 hasn't been run. Reuse evaluators if\n` +
      `// they already exist (server rejects duplicate names with 409).\n` +
      `const existing = await Evaluate.evaluator.list({ limit: 100 });\n` +
      `const byName = new Map((existing.evaluators ?? []).map(e => [e.name, e.id]));\n` +
      `const evaluatorIds = [];\n` +
      `for (const spec of EVALUATOR_SPECS) {\n` +
      `  if (byName.has(spec.name)) { evaluatorIds.push(byName.get(spec.name)); continue; }\n` +
      `  const e = await Evaluate.evaluator.create(spec);\n` +
      `  evaluatorIds.push(e.id);\n` +
      `}\n` +
      `await Evaluate.evaluatorList.create({\n` +
      `  name: "${EVAL_LIST_NAME}",\n` +
      `  evaluators: evaluatorIds.map(id => ({ evaluatorId: id, params: [] })),\n` +
      `});`,
      { log: "Bootstrap evaluators + list (reuse-if-exists)" },
    );

    // Reuse-if-exists: list current evaluators by name first, then only
    // create the ones that are missing. Server rejects duplicate names with
    // 409 "already exists", which would leave us with an empty list and a
    // broken eval-list create below.
    const [existingListed] = await safe(() => evApi.list({ limit: 100 }));
    const existingEvals: unknown[] = Array.isArray(existingListed)
      ? (existingListed as unknown[])
      : (existingListed?.evaluators ?? existingListed?.data ?? []);
    const existingByName = new Map<string, string>();
    for (const e of existingEvals) {
      const n = getName(e);
      const id = getId(e);
      if (n && id !== "n/a") existingByName.set(n, id);
    }

    const evalIds: string[] = [];
    for (const spec of EVALUATOR_SPECS) {
      const specName = spec.name as string;
      if (existingByName.has(specName)) {
        evalIds.push(existingByName.get(specName) as string);
        continue;
      }
      const [res, cerr] = await safe(() => evApi.create(spec));
      const id = getId(res);
      if (id !== "n/a") {
        evalIds.push(id);
      } else {
        emitter.code(
          `// evaluator.create(${specName}) failed: ${cerr}`,
          { log: `evaluator.create(${specName}) failed: ${cerr}` },
        );
      }
    }
    const [created, cerr] = await safe(() => elApi.create({
      name: EVAL_LIST_NAME, evaluators: evalIds.map((id) => ({ evaluatorId: id, params: [] })),
    }));
    state.evaluatorListId = getId(created);
    emitter.result({
      log: cerr ? `Create failed: ${cerr}` : `Created (id=${state.evaluatorListId})`,
      viewInSandbox: { label: "View evaluator list", url: viewInSandbox(projectId, "evaluator-list", state.evaluatorListId) },
    });
  } else {
    state.evaluatorListId = getId(found);
    emitter.code(`// Found existing list (id=${state.evaluatorListId}); reusing`, { log: "Reusing list" });
    emitter.result({
      log: `Reused (id=${state.evaluatorListId})`,
      viewInSandbox: { label: "View evaluator list", url: viewInSandbox(projectId, "evaluator-list", state.evaluatorListId) },
    });
  }
  emitter.phaseEnd();

  // ---- Phase 3: Evaluator list inspect ----
  emitter.phaseStart("phase-3-evaluator-list-get", 3, 4);
  emitter.code(
    `import { Evaluate } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `const fetched = await Evaluate.evaluatorList.get("${state.evaluatorListId}");\n` +
    `// Walk evaluatorConfigs[] to get each evaluatorId, then fetch full evaluator\n` +
    `// rows so we can build the rich payload for Phase 4.\n` +
    `const configs = fetched?.evaluatorConfigs ?? [];\n` +
    `const evaluatorIds = configs.map(c => c?.evaluatorId).filter(Boolean);\n` +
    `const evaluatorsForExecution = [];\n` +
    `for (const eid of evaluatorIds) {\n` +
    `  const ev = await Evaluate.evaluator.get(eid);\n` +
    `  const entry = {\n` +
    `    metricName: ev?.name,\n` +
    `    displayName: ev?.name,\n` +
    `    family: ev?.family,\n` +
    `    runtimeProvider: ev?.runtimeProvider,\n` +
    `    evaluatorId: eid,\n` +
    `    params: {},\n` +
    `  };\n` +
    `  if (ev?.code) entry.codeText = ev.code;\n` +
    `  if (ev?.language) entry.codeLanguage = ev.language;\n` +
    `  evaluatorsForExecution.push(entry);\n` +
    `}`,
    { log: "Walk evaluatorConfigs, fetch each evaluator, build payload for evaluationExecution" },
  );

  const evGetApi = (client as unknown as { evaluate: { evaluator: {
    get: (id: string) => Promise<unknown>;
  } } }).evaluate.evaluator;

  const [fetched, ferr] = await safe(() => elApi.get(state.evaluatorListId));
  const configs: unknown[] =
    fetched && typeof fetched === "object"
      ? ((fetched as { evaluatorConfigs?: unknown[] }).evaluatorConfigs ?? [])
      : [];
  const evaluatorIds: string[] = configs
    .map((c) =>
      c && typeof c === "object"
        ? (c as { evaluatorId?: string }).evaluatorId
        : undefined,
    )
    .filter((x): x is string => typeof x === "string");

  for (const eid of evaluatorIds) {
    const [evObj] = await safe(() => evGetApi.get(eid));
    if (!evObj || typeof evObj !== "object") continue;
    const r = evObj as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name : undefined;
    const family = typeof r.family === "string" ? r.family : undefined;
    const runtime = typeof r.runtimeProvider === "string" ? r.runtimeProvider : undefined;
    const codeText = typeof r.code === "string" ? r.code : undefined;
    const codeLang = typeof r.language === "string" ? r.language : undefined;
    state.evaluatorDetails.push({ id: eid, name });
    const entry: EvaluatorEntry = {
      metricName: name,
      displayName: name,
      family,
      runtimeProvider: runtime,
      evaluatorId: eid,
      params: {},
    };
    if (codeText) entry.codeText = codeText;
    if (codeLang) entry.codeLanguage = codeLang;
    state.evaluatorsForExecution.push(entry);
  }

  const names = state.evaluatorDetails
    .map((d) => d.name)
    .filter((n): n is string => typeof n === "string");
  emitter.result({
    log: `List contains ${state.evaluatorDetails.length} evaluators: ${names.join(", ") || "(empty)"}${ferr ? ` — ${ferr}` : ""}`,
  });
  emitter.phaseEnd();

  // ---- Phase 4: Per-row evaluation ----
  emitter.phaseStart("phase-4-eval-execute", 4, 4);
  emitter.code(
    `import { Evaluate } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `for (const row of rows) {\n` +
    `  await Evaluate.evaluationExecution.evaluate({\n` +
    `    evaluators: evaluatorsForExecution,\n` +
    `    data: {\n` +
    `      input: row.input,\n` +
    `      output: row.output ?? "",\n` +
    `      expectedOutput: row.expected_tool ?? "",\n` +
    `    },\n` +
    `    concurrency: 1,\n` +
    `  });\n` +
    `}`,
    { log: "Run the evaluator list against each row via evaluationExecution.evaluate" },
  );

  const evExecApi = (client as unknown as { evaluate: { evaluationExecution: {
    evaluate: (req: Record<string, unknown>) => Promise<{ results?: Array<{ metricName?: string; evaluator?: string; score?: number }> }>;
  } } }).evaluate.evaluationExecution;

  const totals: Record<string, number[]> = {};
  let errors = 0;
  for (const row of state.rows) {
    if (state.evaluatorsForExecution.length === 0) break;
    const [res, perr] = await safe(() => evExecApi.evaluate({
      evaluators: state.evaluatorsForExecution,
      data: {
        input: row.input,
        output: row.output ?? "",
        expectedOutput: row.expected_tool ?? "",
      },
      concurrency: 1,
    }));
    if (perr) { errors += 1; continue; }
    const results = res?.results ?? [];
    for (const r of results) {
      const metric = r.metricName ?? r.evaluator;
      if (metric && typeof r.score === "number") {
        (totals[metric] ??= []).push(r.score);
      }
    }
  }
  const summaryLines = Object.entries(totals)
    .filter(([, v]) => v.length)
    .map(([k, v]) => `${k}: avg=${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)} (${v.length} runs)`);
  const summary = summaryLines.length ? summaryLines.join("; ") : "no scores returned";
  emitter.result({ log: `Evaluated ${state.rows.length} rows; errors=${errors}; ${summary}` });
  emitter.phaseEnd();
}
