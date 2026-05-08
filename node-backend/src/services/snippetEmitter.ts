import type { Response } from "express";

/**
 * "View in Sandbox" link payload — see CONTRACTS.md SSE event shape.
 */
export interface ViewInSandbox {
  label: string;
  url: string;
}

/**
 * SSE event helper for streaming code-snippet walkthroughs.
 *
 * Phase A: not used by route handlers; the stub endpoints write SSE
 * inline. This class exists so Phase B handlers can swap straight
 * to it without rewriting plumbing.
 *
 * Each method writes exactly one SSE event of the shape defined in
 * CONTRACTS.md ("type", "stage", optional fields). Construction sets the
 * three SSE response headers; callers do not need to touch them.
 */
export class SnippetEmitter {
  private readonly res: Response;
  private readonly stage: string;

  constructor(res: Response, stage: string) {
    this.res = res;
    this.stage = stage;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  }

  /**
   * Emits a `phase-start` event. `idx` is 1-based for human-readable display.
   */
  phaseStart(phaseId: string, idx: number, total: number): void {
    this.write("phase-start", {
      type: "phase-start",
      stage: this.stage,
      phase_id: phaseId,
      phase_index: idx,
      phase_total: total,
      status: "running",
    });
  }

  /**
   * Emits a `code-snippet` event. The snippet is shown verbatim in the UI;
   * an optional log string explains what the line does.
   */
  code(snippet: string, opts?: { log?: string }): void {
    const payload: Record<string, unknown> = {
      type: "code-snippet",
      stage: this.stage,
      code: snippet,
      language: "typescript",
      status: "pending",
    };
    if (opts?.log !== undefined) payload.log = opts.log;
    this.write("code-snippet", payload);
  }

  /**
   * Emits a `result` event after the snippet ran. `viewInSandbox` is the
   * deep-link the frontend renders as a "View in Sandbox" button.
   */
  result(opts: { log: string; viewInSandbox?: ViewInSandbox }): void {
    const payload: Record<string, unknown> = {
      type: "result",
      stage: this.stage,
      status: "done",
      log: opts.log,
    };
    if (opts.viewInSandbox) payload.view_in_sandbox = opts.viewInSandbox;
    this.write("result", payload);
  }

  /**
   * Emits a `phase-end` event. Pairs with the most recent `phaseStart`.
   */
  phaseEnd(): void {
    this.write("phase-end", {
      type: "phase-end",
      stage: this.stage,
      status: "done",
    });
  }

  /**
   * Emits a terminal `done` event and closes the stream.
   */
  done(): void {
    this.write("done", { type: "done" });
    this.res.end();
  }

  /**
   * Emits a custom SSE event with a caller-supplied payload. Used by the
   * chat handlers (manual + auto) which need to add chat-specific fields
   * like `provider`, `model`, `usage` that the generic `result()` helper
   * doesn't carry.
   */
  emit(eventType: string, payload: Record<string, unknown>): void {
    this.write(eventType, payload);
  }

  /**
   * Emits a terminal `error` event and closes the stream.
   */
  error(msg: string): void {
    this.write("error", {
      type: "error",
      stage: this.stage,
      status: "error",
      error: msg,
    });
    this.res.end();
  }

  /**
   * Internal: write one SSE event line per the spec
   *   `event: <name>\ndata: <json>\n\n`.
   */
  private write(eventType: string, payload: unknown): void {
    this.res.write(
      `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`
    );
  }
}
