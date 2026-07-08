/**
 * Workflow 4 — Prompt Compile + LLM call.
 *
 * Four phases:
 *   1. Prompt CRUD     — find or create a templated text prompt with {{vars}}
 *   2. Prompt fetch    — client.prompt.get({ name }) returns a PromptClient
 *   3. Prompt compile  — prompt.compile({ var: value }) renders the template
 *   4. LLM call        — feed compiled string to OpenAI and surface the output
 */
import OpenAI from "openai";
import type { AISDK } from "@browserstack/ai-sdk";
import { SnippetEmitter } from "../services/snippetEmitter.js";
import { viewInSandbox } from "../services/sdkClient.js";

const PROMPT_NAME = "support-reply-generator";
const PROMPT_TEMPLATE =
  "You are a senior customer support agent for an online retailer. " +
  "Write a concise, {{tone}} reply to a customer named {{customer_name}} " +
  "who reached out with the following issue:\n\n" +
  "\"{{issue}}\"\n\n" +
  "Address them by name, acknowledge the problem, propose one concrete " +
  "next step, and end on a warm note. Keep the reply under 90 words.";
const SAMPLE_VARS = {
  tone: "empathetic and professional",
  customer_name: "Priya",
  issue: "My order #4831 was supposed to arrive yesterday but the tracking still says 'in transit'. I need it before my flight on Friday.",
};

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

export async function runPromptCompile(
  emitter: SnippetEmitter,
  client: AISDK,
  projectId: string,
  openaiKey: string,
  userVars?: Record<string, string> | null,
): Promise<void> {
  const state: { promptId?: string; promptObj?: unknown; compiled?: string } = {};
  const varsForCompile: Record<string, string> =
    userVars && Object.keys(userVars).length > 0 ? userVars : SAMPLE_VARS;

  // ---- Phase 1: Prompt CRUD ----
  emitter.phaseStart("phase-1-prompt-crud", 1, 4);
  emitter.code(
    `import { Prompt } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `// 1. Look it up first\n` +
    `const existing = await Prompt.list({ name: "${PROMPT_NAME}", limit: 10 });\n` +
    `\n` +
    `// 2. Create only if missing — re-creating with new content\n` +
    `//    auto-bumps the version on the server.\n` +
    `await Prompt.create({\n` +
    `  name: "${PROMPT_NAME}",\n` +
    `  type: "text",\n` +
    `  prompt: \`${PROMPT_TEMPLATE.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\`,\n` +
    `  labels: ["production"],\n` +
    `  modelParams: {\n` +
    `    provider: "openai",\n` +
    `    model: "gpt-4o-mini",\n` +
    `    adapter: "openai",\n` +
    `  },\n` +
    `});`,
    { log: "Prompt CRUD — list then create-if-missing" },
  );
  const promptApi = (client as unknown as { prompt: {
    create: (opts: Record<string, unknown>) => Promise<unknown>;
    get: (nameOrOpts: string | { name?: string }, version?: number, opts?: Record<string, unknown>) => Promise<unknown>;
  } }).prompt;

  // Node SDK has no `prompt.list()` — existence-check via `prompt.get` and
  // catch the not-found error. The reference scripts use the same pattern.
  const [existing] = await safe(() =>
    promptApi.get(PROMPT_NAME, undefined, { label: "latest" }),
  );

  if (!existing) {
    const [created, cerr] = await safe(() => promptApi.create({
      name: PROMPT_NAME,
      type: "text",
      prompt: PROMPT_TEMPLATE,
      labels: ["production"],
      modelParams: { provider: "openai", model: "gpt-4o-mini", adapter: "openai" },
    }));
    state.promptId = getId(created);
    emitter.result({
      log: cerr ? `Create errored: ${cerr}` : `Created prompt '${PROMPT_NAME}' (id=${state.promptId})`,
      viewInSandbox: { label: "View prompt", url: viewInSandbox(projectId, "prompt", PROMPT_NAME) },
    });
  } else {
    state.promptId = getId(existing);
    emitter.result({
      log: `Prompt '${PROMPT_NAME}' already exists — reusing (id=${state.promptId})`,
      viewInSandbox: { label: "View prompt", url: viewInSandbox(projectId, "prompt", PROMPT_NAME) },
    });
  }
  emitter.phaseEnd();

  // ---- Phase 2: Prompt fetch ----
  emitter.phaseStart("phase-2-prompt-fetch", 2, 4);
  emitter.code(
    `import { Prompt } from "@browserstack/ai-sdk";\n` +
    `\n` +
    `const prompt = await Prompt.get(\n` +
    `  "${PROMPT_NAME}",\n` +
    `  undefined,\n` +
    `  { label: "production" },\n` +
    `);\n` +
    `// returns a PromptClient exposing the template + a .compile() method`,
    { log: "Fetch the prompt object" },
  );
  const [promptObj, perr] = await safe(() =>
    promptApi.get(PROMPT_NAME, undefined, { label: "production" }),
  );
  if (!promptObj) {
    emitter.error(`prompt.get failed: ${perr ?? "none returned"}`);
    emitter.phaseEnd();
    return;
  }
  state.promptObj = promptObj;

  const promptResp = (promptObj as { promptResponse?: { prompt?: string }; prompt?: string });
  const template = promptResp.promptResponse?.prompt ?? promptResp.prompt ?? PROMPT_TEMPLATE;
  const preview = template.length > 120 ? template.slice(0, 120) + "…" : template;
  emitter.result({
    log: `Fetched prompt; template = ${JSON.stringify(preview)}`,
    viewInSandbox: { label: "View prompt", url: viewInSandbox(projectId, "prompt", PROMPT_NAME) },
  });
  emitter.phaseEnd();

  // ---- Phase 3: Prompt compile ----
  emitter.phaseStart("phase-3-prompt-compile", 3, 4);
  const argsBody = Object.entries(varsForCompile)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join(",\n");
  const varNames = Object.keys(varsForCompile)
    .map((k) => `{{${k}}}`)
    .join(", ");
  emitter.code(
    `const compiled = prompt.compile({\n` +
    `${argsBody},\n` +
    `});\n` +
    `// substitutes ${varNames} into the template string`,
    { log: "Compile the template with the supplied variables" },
  );
  let compiled: string | undefined;
  try {
    const callable = (state.promptObj as { compile?: (vars: Record<string, string>) => string });
    if (typeof callable.compile === "function") {
      compiled = callable.compile(varsForCompile);
    }
  } catch (err) {
    emitter.error(`compile failed: ${err instanceof Error ? err.message : String(err)}`);
    emitter.phaseEnd();
    return;
  }
  if (!compiled) {
    emitter.error("compile returned nothing");
    emitter.phaseEnd();
    return;
  }
  state.compiled = compiled;
  const compiledPreview = compiled.length > 160 ? compiled.slice(0, 160) + "…" : compiled;
  emitter.result({ log: `Compiled output: ${JSON.stringify(compiledPreview)}` });
  emitter.phaseEnd();

  // ---- Phase 4: LLM call ----
  emitter.phaseStart("phase-4-llm-call", 4, 4);
  emitter.code(
    `import OpenAI from "openai";\n` +
    `const llm = new OpenAI({ apiKey: "sk-***" });\n` +
    `const completion = await llm.chat.completions.create({\n` +
    `  model: "gpt-4o-mini",\n` +
    `  messages: [{ role: "user", content: compiled }],\n` +
    `});\n` +
    `const reply = completion.choices[0]?.message?.content;`,
    { log: "Send the compiled prompt to OpenAI" },
  );
  if (!openaiKey) {
    emitter.error("Missing OpenAI key on this request.");
    emitter.phaseEnd();
    return;
  }
  try {
    const llm = new OpenAI({ apiKey: openaiKey });
    const completion = await llm.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: compiled }],
    });
    const reply = completion.choices[0]?.message?.content ?? "";
    const replyPreview = reply.length > 400 ? reply.slice(0, 400) + "…" : reply;
    emitter.result({ log: `LLM reply: ${replyPreview}` });
  } catch (err) {
    emitter.error(`OpenAI call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  emitter.phaseEnd();
}
