import { Router, type Request, type Response } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { resolveKeys, pickProvider } from "../services/llm.js";
import { makeClient, traceExists, viewInSandbox } from "../services/sdkClient.js";
import { SnippetEmitter } from "../services/snippetEmitter.js";

/**
 * POST /api/chat/manual — Stage 3.
 *
 * Wraps a real LLM call with the SDK's manual tracing primitives
 * (`client.trace().generation().end()` + `trace.score()`) and streams every
 * SDK call as a `code-snippet` SSE event. Each call is then *actually
 * executed*, so the right pane mirrors what's running on the server.
 */
export const chatManualRouter: Router = Router();

interface HistoryTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ManualChatBody {
  message: string;
  history?: HistoryTurn[];
  provider?: string;
  model?: string;
  projectId?: string;
}

function mask(key: string | null | undefined): string {
  if (!key) return "***";
  return key.slice(0, 8) + "***";
}

function fullScript(
  provider: string,
  model: string,
  pkMasked: string,
  skMasked: string,
): string {
  const isOpenAI = provider === "openai";
  const callBlock = isOpenAI
    ? [
        `import OpenAI from "openai";`,
        ``,
        `const oai = new OpenAI({ apiKey: "sk-***" });`,
        ``,
        `const completion = await oai.chat.completions.create({`,
        `  model: "${model}",`,
        `  messages,`,
        `});`,
        `const reply = completion.choices[0]?.message?.content;`,
      ].join("\n")
    : [
        `import Anthropic from "@anthropic-ai/sdk";`,
        ``,
        `const ant = new Anthropic({ apiKey: "sk-ant-***" });`,
        ``,
        `const response = await ant.messages.create({`,
        `  model: "${model}",`,
        `  max_tokens: 1024,`,
        `  messages,`,
        `});`,
        `const reply = response.content[0]?.text;`,
      ].join("\n");

  const usageBlock = isOpenAI
    ? [
        `gen.end({`,
        `  output: reply,`,
        `  usage: {`,
        `    input: completion.usage.prompt_tokens,`,
        `    output: completion.usage.completion_tokens,`,
        `  },`,
        `});`,
      ].join("\n")
    : [
        `gen.end({`,
        `  output: reply,`,
        `  usage: {`,
        `    input: response.usage.input_tokens,`,
        `    output: response.usage.output_tokens,`,
        `  },`,
        `});`,
      ].join("\n");

  return [
    `import { AISDK } from "@browserstack/ai-sdk";`,
    ``,
    `const client = new AISDK({`,
    `  publicKey: "${pkMasked}",`,
    `  secretKey: "${skMasked}",`,
    `});`,
    ``,
    `const trace = client.trace({`,
    `  name: "support-bot:chat",`,
    `  input: userMessage,`,
    `});`,
    `const gen = trace.generation({`,
    `  name: "llm-call",`,
    `  model: "${model}",`,
    `  input: messages,`,
    `});`,
    ``,
    callBlock,
    ``,
    usageBlock,
    ``,
    `trace.score({ name: "verbose", value: 1 });`,
    `trace.update({ output: reply });`,
  ].join("\n");
}

chatManualRouter.post("/manual", async (req: Request, res: Response) => {
  const body = req.body as ManualChatBody | undefined;
  if (!body || typeof body.message !== "string" || body.message.length === 0) {
    res.status(400).json({ error: "Body must include a non-empty 'message'." });
    return;
  }

  const keys = resolveKeys(req);
  const emit = new SnippetEmitter(res, "chat-manual");
  emit.phaseStart("manual-trace", 1, 1);

  // Manual chat always uses the provider's native SDK so we can wrap calls in
  // client.trace() spans. Collapse "langchain-*" wire names to their family.
  const requested = body.provider ?? "";
  const family = requested.startsWith("langchain-") ? requested.split("-")[1] : requested;
  let provider: string;
  let model: string;
  if ((family === "openai" || family === "anthropic") && keys[family]) {
    provider = family;
    model = body.model ?? (family === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5");
  } else {
    let picked;
    try {
      picked = pickProvider(keys);
    } catch (err) {
      emit.error((err as Error).message);
      return;
    }
    provider = picked.provider;
    model = picked.model;
  }

  let client;
  try {
    client = makeClient(keys.sandboxPublic ?? "", keys.sandboxSecret ?? "");
  } catch (err) {
    emit.error(`Failed to build SDK client: ${(err as Error).message}`);
    return;
  }

  const history = body.history ?? [];
  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: body.message },
  ];

  const trace = client.trace({
    name: "support-bot:chat",
    input: body.message,
    metadata: { stage: 3 },
  });
  const gen = trace.generation({
    name: "llm-call",
    model,
    input: messages,
  });

  let reply = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    if (provider === "openai") {
      const oai = new OpenAI({ apiKey: keys.openai ?? "" });
      const completion = await oai.chat.completions.create({ model, messages });
      reply = completion.choices[0]?.message?.content ?? "";
      usage = {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      };
    } else if (provider === "anthropic") {
      const ant = new Anthropic({ apiKey: keys.anthropic ?? "" });
      const resp = await ant.messages.create({
        model,
        max_tokens: 1024,
        messages: history
          .filter((h) => h.role === "user" || h.role === "assistant")
          .map((h) => ({ role: h.role as "user" | "assistant", content: h.content }))
          .concat([{ role: "user", content: body.message }]),
      });
      const first = resp.content[0];
      reply = first && first.type === "text" ? first.text : "";
      usage = {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
      };
    } else {
      throw new Error(`Provider '${provider}' not supported by /chat/manual.`);
    }
  } catch (err) {
    emit.error(`LLM call failed: ${(err as Error).message}`);
    return;
  }

  emit.code(
    fullScript(provider, model, mask(keys.sandboxPublic), mask(keys.sandboxSecret)),
  );

  try {
    gen.end({ output: reply, usage: { input: usage.inputTokens, output: usage.outputTokens } } as never);
  } catch {
    // SDK end() shape may differ across versions; tracing is best-effort.
  }

  const scoreValue = reply.length > 50 ? 1 : 0;
  try {
    trace.score({ name: "verbose", value: scoreValue });
  } catch {
    /* best-effort */
  }

  try {
    trace.update({ output: reply });
  } catch {
    /* best-effort */
  }

  // Span exports go through a batch processor — flush before polling the
  // public trace endpoint so the trace is queryable. Only show the View
  // button if the server confirms the trace exists.
  try {
    await (client as unknown as { flushAsync?: () => Promise<void>; flush?: () => Promise<void> | void }).flushAsync?.();
  } catch { /* best-effort */ }
  try {
    await (client as unknown as { flush?: () => Promise<void> | void }).flush?.();
  } catch { /* best-effort */ }

  const traceId =
    (trace as unknown as { traceId?: string }).traceId
    ?? (trace as unknown as { id?: string }).id;
  let traceUrl: string | undefined;
  if (
    traceId
    && body.projectId
    && (await traceExists(keys.sandboxPublic ?? "", keys.sandboxSecret ?? "", traceId))
  ) {
    traceUrl = viewInSandbox(body.projectId, "trace", traceId);
  }

  emit.emit("result", {
    type: "result",
    stage: "chat-manual",
    status: "done",
    phase_id: "manual-trace",
    phase_index: 1,
    phase_total: 1,
    log: reply,
    provider,
    model,
    usage,
    ...(traceUrl
      ? { view_in_sandbox: { label: "View trace in Sandbox", url: traceUrl } }
      : {}),
  });

  emit.phaseEnd();
  emit.done();
});
