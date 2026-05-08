import { Router, type Request, type Response } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Observe } from "@browserstack/ai-sdk";
import { resolveKeys, pickProvider, type Provider } from "../services/llm.js";
import { makeClient, viewInSandbox } from "../services/sdkClient.js";
import { SnippetEmitter } from "../services/snippetEmitter.js";

/**
 * POST /api/chat/auto — Stage 4.
 *
 * Auto-instrumentation is bootstrapped lazily on first hit via Observe.init().
 * NOT done at server start so Stage 3 (manual tracing) doesn't get
 * double-instrumented. After init, any LLM call is captured transparently.
 */
export const chatAutoRouter: Router = Router();
let observeInitialized = false;

interface HistoryTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatAutoBody {
  message: string;
  history?: HistoryTurn[];
  provider: Provider;
  model: string;
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
  let providerLines: string;
  if (provider === "openai") {
    providerLines = [
      `import OpenAI from "openai";`,
      ``,
      `const oai = new OpenAI({ apiKey: "sk-***" });`,
      ``,
      `const completion = await oai.chat.completions.create({`,
      `  model: "${model}",`,
      `  messages,`,
      `});`,
    ].join("\n");
  } else if (provider === "anthropic") {
    providerLines = [
      `import Anthropic from "@anthropic-ai/sdk";`,
      ``,
      `const ant = new Anthropic({ apiKey: "sk-ant-***" });`,
      ``,
      `const response = await ant.messages.create({`,
      `  model: "${model}",`,
      `  max_tokens: 1024,`,
      `  messages,`,
      `});`,
    ].join("\n");
  } else if (provider === "langchain-openai") {
    providerLines = [
      `import { ChatOpenAI } from "@langchain/openai";`,
      ``,
      `const chat = new ChatOpenAI({`,
      `  apiKey: "sk-***",`,
      `  model: "${model}",`,
      `});`,
      `const response = await chat.invoke(messages);`,
    ].join("\n");
  } else if (provider === "langchain-anthropic") {
    providerLines = [
      `import { ChatAnthropic } from "@langchain/anthropic";`,
      ``,
      `const chat = new ChatAnthropic({`,
      `  apiKey: "sk-ant-***",`,
      `  model: "${model}",`,
      `});`,
      `const response = await chat.invoke(messages);`,
    ].join("\n");
  } else {
    providerLines = `// unknown provider ${provider}`;
  }

  return [
    `import { AISDK, Observe } from "@browserstack/ai-sdk";`,
    ``,
    `// Installs OTel hooks for openai / anthropic / langchain.`,
    `Observe.init({ environment: "walkthrough" });`,
    ``,
    `const client = new AISDK({`,
    `  publicKey: "${pkMasked}",`,
    `  secretKey: "${skMasked}",`,
    `});`,
    ``,
    providerLines,
  ].join("\n");
}

function toLangchain(history: HistoryTurn[], message: string): BaseMessage[] {
  const out: BaseMessage[] = history.map((h) => {
    if (h.role === "assistant") return new AIMessage(h.content);
    if (h.role === "system") return new SystemMessage(h.content);
    return new HumanMessage(h.content);
  });
  out.push(new HumanMessage(message));
  return out;
}

function lcText(msg: BaseMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p) {
          return String((p as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

function lcUsage(msg: BaseMessage): { inputTokens: number; outputTokens: number } {
  const meta = (msg as unknown as {
    usage_metadata?: { input_tokens?: number; output_tokens?: number };
  }).usage_metadata;
  if (meta) {
    return {
      inputTokens: meta.input_tokens ?? 0,
      outputTokens: meta.output_tokens ?? 0,
    };
  }
  const respMeta = (msg as unknown as {
    response_metadata?: { tokenUsage?: { promptTokens?: number; completionTokens?: number } };
  }).response_metadata;
  const tu = respMeta?.tokenUsage;
  return {
    inputTokens: tu?.promptTokens ?? 0,
    outputTokens: tu?.completionTokens ?? 0,
  };
}

chatAutoRouter.post("/auto", async (req: Request, res: Response) => {
  const body = req.body as ChatAutoBody | undefined;
  if (!body || typeof body.message !== "string" || body.message.length === 0) {
    res.status(400).json({ error: "Body must include a non-empty 'message'." });
    return;
  }
  if (!body.provider || !body.model) {
    res.status(400).json({ error: "Body must include 'provider' and 'model'." });
    return;
  }

  const keys = resolveKeys(req);
  const emit = new SnippetEmitter(res, "chat-auto");
  emit.phaseStart("auto-trace", 1, 1);

  // Lazy-init so Stage 3 (manual tracing) stays clean — only install hooks
  // the first time an auto-chat request lands.
  if (!observeInitialized) {
    try {
      Observe.init({
        publicKey: keys.sandboxPublic ?? "",
        secretKey: keys.sandboxSecret ?? "",
        environment: "walkthrough",
      } as Parameters<typeof Observe.init>[0]);
      observeInitialized = true;
    } catch (err) {
      emit.error(`Observe.init failed: ${(err as Error).message}`);
      return;
    }
  }

  let picked;
  try {
    picked = pickProvider(keys, { provider: body.provider, model: body.model });
  } catch (err) {
    emit.error((err as Error).message);
    return;
  }
  const { provider, model } = picked;

  emit.code(
    fullScript(provider, model, mask(keys.sandboxPublic), mask(keys.sandboxSecret)),
  );

  // Construct (but do not yet need to use) the SDK client so any per-request
  // initialization (header-derived auth, etc.) runs alongside auto-tracing.
  try {
    makeClient(keys.sandboxPublic ?? "", keys.sandboxSecret ?? "");
  } catch (err) {
    emit.error(`Failed to build SDK client: ${(err as Error).message}`);
    return;
  }

  const history = body.history ?? [];
  let reply = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    if (provider === "openai") {
      const oai = new OpenAI({ apiKey: keys.openai ?? "" });
      const messages = [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user" as const, content: body.message },
      ];
      const completion = await oai.chat.completions.create({ model, messages });
      reply = completion.choices[0]?.message?.content ?? "";
      usage = {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      };
    } else if (provider === "anthropic") {
      const ant = new Anthropic({ apiKey: keys.anthropic ?? "" });
      const filtered = history
        .filter((h) => h.role === "user" || h.role === "assistant")
        .map((h) => ({ role: h.role as "user" | "assistant", content: h.content }));
      const resp = await ant.messages.create({
        model,
        max_tokens: 1024,
        messages: [...filtered, { role: "user", content: body.message }],
      });
      const first = resp.content[0];
      reply = first && first.type === "text" ? first.text : "";
      usage = {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
      };
    } else if (provider === "langchain-openai") {
      const chat = new ChatOpenAI({ apiKey: keys.openai ?? "", model });
      const result = await chat.invoke(toLangchain(history, body.message));
      reply = lcText(result);
      usage = lcUsage(result);
    } else if (provider === "langchain-anthropic") {
      const chat = new ChatAnthropic({ apiKey: keys.anthropic ?? "", model });
      const result = await chat.invoke(toLangchain(history, body.message));
      reply = lcText(result);
      usage = lcUsage(result);
    } else {
      throw new Error(`Unknown provider '${provider}'.`);
    }
  } catch (err) {
    emit.error(`LLM call failed: ${(err as Error).message}`);
    return;
  }

  const url = body.projectId ? viewInSandbox(body.projectId, "trace") : "";

  res.write(
    `event: result\ndata: ${JSON.stringify({
      type: "result",
      stage: "chat-auto",
      status: "done",
      phase_id: "auto-trace",
      phase_index: 1,
      phase_total: 1,
      log: reply,
      provider,
      model,
      usage,
      ...(url ? { view_in_sandbox: { label: "View traces in Sandbox", url } } : {}),
    })}\n\n`
  );

  emit.phaseEnd();
  emit.done();
});
