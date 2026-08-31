import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, eventMessage, inject } from "../dsh.ts";
import { DatabaseSync } from "../src/store/sqlite.ts";
import { normalizeExtractionContent } from "../src/extractor/extract.ts";

function user(seq: number) {
  return {
    type: "user/message",
    seq,
    data: { id: `u${seq}`, role: "user", source: { kind: "user" }, content: [] },
  };
}

describe("native DSH context takeover", () => {
  it("fails closed on an ambiguous destructive retention policy", () => {
    expect(() => apply({} as any, {
      dbPath: ":memory:",
      messageRetention: { keep: "recent" },
    })).toThrow(/requires recentTurns or retentionDays/);
  });

  it("validates extraction bounds before opening the configured database", () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-config-"));
    const dbPath = join(dir, "must-not-open.db");
    expect(() => apply({} as any, {
      dbPath,
      extractionDrain: { maxBatchChars: 1 },
    })).toThrow(/extractionDrain.maxBatchChars/);
    expect(existsSync(dbPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes the effective retention policy and bounded maintenance receipt", async () => {
    const tools = new Map<string, any>();
    const cleanups: Array<() => void | Promise<void>> = [];
    const context: any = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { async *stream() {} },
      tools: {
        register(definition: any) {
          tools.set(definition.name, definition);
          return () => {};
        },
      },
      credentials: { async resolve() { return undefined; } },
      agentPresets: { serviceFor() { return undefined; } },
      on() { return () => {}; },
      effect(register: () => () => void | Promise<void>) {
        cleanups.push(register());
        return () => {};
      },
    };
    apply(context, {
      dbPath: ":memory:",
      extractionEnabled: false,
      recallEnabled: false,
      messageRetention: {
        keep: "referenced",
        recentTurns: 5,
        batchSize: 25,
        dryRun: true,
      },
    });

    const status = await tools.get("gm_status").execute();
    expect(status).toContain("Message retention: keep=referenced");
    expect(status).toContain("recentTurns=5");
    expect(status).toContain("dryRun=true");

    const receipt = JSON.parse(await tools.get("gm_maintain").execute());
    expect(receipt.retention).toMatchObject({
      policy: "referenced",
      dryRun: true,
      selectedRows: 0,
      deletedRows: 0,
    });
    const stats = await tools.get("gm_stats").execute();
    expect(stats).toContain('"dryRuns":1');
    expect(stats).toContain("Last retention receipt:");
    await Promise.all(cleanups.map(cleanup => cleanup()));
  });

  it("keeps immutable source events but does not duplicate derived replacements", () => {
    expect(eventMessage({
      type: "assistant/message",
      surfaceOp: "append",
      data: { message: { content: [{ type: "text", text: "original" }] } },
    })).toEqual({
      role: "assistant",
      message: { content: [{ type: "text", text: "original" }] },
    });
    expect(eventMessage({
      type: "assistant/message",
      surfaceOp: { op: "replace", start: 1, end: 3 },
      sourceEventSeqs: [1, 2, 3],
      data: { message: { content: [{ type: "text", text: "derived" }] } },
    })).toBeUndefined();
  });

  it("uses the agent-scoped public compaction service and retains configurable turns", async () => {
    const listeners = new Map<string, Array<(...args: any[]) => any>>();
    const cleanups: Array<() => void | Promise<void>> = [];
    let compactionService: any;
    const context: any = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { async *stream() {} },
      tools: { register() { return () => {}; } },
      credentials: { async resolve() { return undefined; } },
      agentPresets: {
        serviceFor(_agent: any, key: string) {
          expect(key).toBe("compaction");
          return compactionService;
        },
      },
      on(name: string, listener: (...args: any[]) => any, options?: Record<string, unknown>) {
        const current = listeners.get(name) ?? [];
        if (options?.prepend) current.unshift(listener);
        else current.push(listener);
        listeners.set(name, current);
        return () => {};
      },
      effect(register: () => () => void | Promise<void>) {
        cleanups.push(register());
        return () => {};
      },
    };
    apply(context, {
      dbPath: ":memory:",
      extractionEnabled: false,
      recallEnabled: false,
      freshTurnCount: 2,
    });

    const events: any[] = [];
    const surface: number[] = [];
    const agentListeners = new Map<string, Array<(...args: any[]) => any>>();
    for (let turn = 1; turn <= 3; turn += 1) {
      const userSeq = events.length;
      events.push(user(userSeq));
      surface.push(userSeq);
      const assistantSeq = events.length;
      events.push({ type: "assistant/message", seq: assistantSeq, data: {} });
      surface.push(assistantSeq);
    }
    const calls: any[][] = [];
    const agent = {
      session: { events, surface: { nodes: surface } },
      ctx: {
        on(name: string, listener: (...args: any[]) => any, options?: Record<string, unknown>) {
          const current = agentListeners.get(name) ?? [];
          if (options?.prepend) current.unshift(listener);
          else current.push(listener);
          agentListeners.set(name, current);
          return () => {};
        },
      },
    };
    compactionService = {
      async compactRegion(...args: any[]) {
        calls.push(args);
        return { shadowedSeqs: [0, 1] };
      },
    };
    listeners.get("agent/created")![0]({ agent });
    const next = async () => "continued";
    const result = await agentListeners.get("agent/pre-step")![0]({
      agent,
      signal: new AbortController().signal,
    }, next);

    expect(result).toBe("continued");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(0);
    expect(calls[0][1]).toBe(1);
    expect(calls[0][2]).toBe(agent);
    await Promise.all(cleanups.map(cleanup => cleanup()));
  });

  it("keeps a 30-turn model surface bounded instead of growing linearly", async () => {
    const listeners = new Map<string, Array<(...args: any[]) => any>>();
    const cleanups: Array<() => void | Promise<void>> = [];
    let compactionService: any;
    const context: any = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { async *stream() {} },
      tools: { register() { return () => {}; } },
      credentials: { async resolve() { return undefined; } },
      agentPresets: {
        serviceFor(_agent: any, key: string) {
          expect(key).toBe("compaction");
          return compactionService;
        },
      },
      on(name: string, listener: (...args: any[]) => any, options?: Record<string, unknown>) {
        const current = listeners.get(name) ?? [];
        if (options?.prepend) current.unshift(listener);
        else current.push(listener);
        listeners.set(name, current);
        return () => {};
      },
      effect(register: () => () => void | Promise<void>) {
        cleanups.push(register());
        return () => {};
      },
    };
    apply(context, {
      dbPath: ":memory:",
      extractionEnabled: false,
      recallEnabled: false,
      freshTurnCount: 5,
    });

    const events: any[] = [];
    const surface = { nodes: [] as number[] };
    const agentListeners = new Map<string, Array<(...args: any[]) => any>>();
    let compactions = 0;
    const agent: any = {
      id: "long-dialog",
      session: { events, surface },
      ctx: {
        on(name: string, listener: (...args: any[]) => any, options?: Record<string, unknown>) {
          const current = agentListeners.get(name) ?? [];
          if (options?.prepend) current.unshift(listener);
          else current.push(listener);
          agentListeners.set(name, current);
          return () => {};
        },
      },
    };
    compactionService = {
      async compactRegion(start: number, end: number) {
        const startPosition = surface.nodes.indexOf(start);
        const endPosition = surface.nodes.indexOf(end);
        const shadowedSeqs = surface.nodes.slice(startPosition, endPosition + 1);
        const replacementSeq = events.length;
        events.push({
          type: "user/message",
          seq: replacementSeq,
          surfaceOp: { op: "replace", start, end },
          sourceEventSeqs: shadowedSeqs,
          data: {
            source: { kind: "plugin", plugin: "compaction-basic" },
            content: [{ type: "text", text: `checkpoint-${compactions}`.padEnd(600, ".") }],
          },
        });
        surface.nodes.splice(startPosition, shadowedSeqs.length, replacementSeq);
        compactions += 1;
        return { shadowedSeqs };
      },
    };
    listeners.get("agent/created")![0]({ agent });

    const payload = "x".repeat(1_000);
    for (let turn = 0; turn < 30; turn += 1) {
      const claimed = {
        source: { kind: "user" },
        content: [{ type: "text", text: `user-${turn}-${payload}` }],
      };
      // Real DSH order: pre-step sees claimed inbox messages before those
      // messages are appended to the durable/model surface.
      await agentListeners.get("agent/pre-step")![0]({
        agent,
        messages: [claimed],
        signal: new AbortController().signal,
      }, async () => undefined);
      const userSeq = events.length;
      events.push({
        type: "user/message",
        seq: userSeq,
        surfaceOp: "append",
        data: claimed,
      });
      surface.nodes.push(userSeq);
      const assistantSeq = events.length;
      events.push({
        type: "assistant/message",
        seq: assistantSeq,
        surfaceOp: "append",
        data: {
          message: { content: [{ type: "text", text: `assistant-${turn}-${payload}` }] },
        },
      });
      surface.nodes.push(assistantSeq);
    }

    const realUsers = surface.nodes.filter(seq => (
      events[seq]?.type === "user/message" && events[seq]?.data?.source?.kind === "user"
    ));
    const surfaceChars = surface.nodes.reduce((total, seq) => {
      const event = events[seq];
      const content = event?.type === "assistant/message"
        ? event.data?.message?.content
        : event?.data?.content;
      return total + (content?.[0]?.text?.length ?? 0);
    }, 0);
    const uncompressedChars = 30 * 2 * (payload.length + 20);

    expect(compactions).toBe(25);
    expect(realUsers).toHaveLength(5);
    expect(surface.nodes).toHaveLength(11);
    expect(surfaceChars).toBeLessThan(uncompressedChars * 0.2);
    await Promise.all(cleanups.map(cleanup => cleanup()));
  });
});

function userMsg(seq: number, text: string) {
  return {
    type: "user/message",
    seq,
    data: { id: `u${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] },
  };
}

const EMPTY_EXTRACTION = '{"nodes":[],"edges":[]}';

function adapterContext(llmStream: (options?: any) => AsyncGenerator<any>) {
  const listeners = new Map<string, Array<(...args: any[]) => any>>();
  const cleanups: Array<() => void | Promise<void>> = [];
  const tools = new Map<string, any>();
  const logs: string[] = [];
  const log = (level: string) => (...args: any[]) => logs.push(`${level}:${args.join(" ")}`);
  const context: any = {
    logger: { info: log("info"), warn: log("warn"), error: log("error") },
    llm: { stream: llmStream },
    tools: { register(definition: any) { tools.set(definition.name, definition); return () => {}; } },
    credentials: { async resolve() { return undefined; } },
    agentPresets: { serviceFor() { return undefined; } },
    on(name: string, listener: (...args: any[]) => any, options?: Record<string, unknown>) {
      const current = listeners.get(name) ?? [];
      if (options?.prepend) current.unshift(listener);
      else current.push(listener);
      listeners.set(name, current);
      return () => {};
    },
    effect(register: () => () => void | Promise<void>) {
      cleanups.push(register());
      return () => {};
    },
  };
  return { context, listeners, cleanups, logs, tools };
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function countPending(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM gm_messages WHERE extraction_state = 'pending'").get() as any;
    return Number(row.c);
  } finally {
    db.close();
  }
}

function countState(dbPath: string, state: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM gm_messages WHERE extraction_state = ?").get(state) as any;
    return Number(row.c);
  } finally {
    db.close();
  }
}

async function startAndEndTurn(
  listeners: Map<string, Array<(...args: any[]) => any>>,
  agent: any,
): Promise<void> {
  listeners.get("agent/session-start")![0]({ agent });
  await listeners.get("agent/turn-stopping")![0]({
    agent,
    signal: new AbortController().signal,
  });
  await listeners.get("session/event")![0]({ id: agent.id }, { type: "turn/end", seq: 99_999 });
}

describe("extraction drain resilience", () => {
  it("does not require the UI-only agentPresets service", () => {
    expect(inject).not.toContain("agentPresets");
  });

  it("retries a transient LLM failure and then drains the backlog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-resilience-"));
    const dbPath = join(dir, "graph-memory.db");
    let calls = 0;
    const { context, listeners, cleanups, logs } = adapterContext(async function* () {
      calls += 1;
      if (calls === 1) throw new Error("transient provider hiccup");
      yield { type: "text-delta", text: EMPTY_EXTRACTION };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
      extractionRetryDelaysMs: [0, 0],
    });
    const agent = { id: "transient-test", session: { events: [userMsg(0, "alpha"), userMsg(1, "beta")] } };
    await startAndEndTurn(listeners, agent);

    await waitFor(() => logs.some(l => l.includes("DSH extracted")));
    expect(logs.some(l => l.includes("retry 1/2 in 0s"))).toBe(true);
    expect(logs.some(l => l.includes("SKIP"))).toBe(false);
    expect(countPending(dbPath)).toBe(0);
    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("quarantines permanently failing messages without pretending they were extracted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-resilience-"));
    const dbPath = join(dir, "graph-memory.db");
    const { context, listeners, cleanups, logs } = adapterContext(async function* () {
      throw new Error("always failing provider");
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
      extractionRetryDelaysMs: [0, 0],
    });
    const agent = {
      id: "poison-test",
      session: { events: [userMsg(0, "alpha"), userMsg(1, "beta"), userMsg(2, "gamma")] },
    };
    await startAndEndTurn(listeners, agent);

    await waitFor(() => logs.filter(l => l.includes("DSH extraction quarantined")).length >= 3);
    expect(logs.filter(l => l.includes("DSH extraction quarantined"))).toHaveLength(3);
    expect(logs.some(l => l.includes("split 3 -> 2+1"))).toBe(true);
    expect(countPending(dbPath)).toBe(0);
    expect(countState(dbPath, "quarantined")).toBe(3);
    expect(countState(dbPath, "succeeded")).toBe(0);
    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("caps each extraction batch by accumulated normalized length", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-resilience-"));
    const dbPath = join(dir, "graph-memory.db");
    const users: string[] = [];
    const { context, listeners, cleanups, logs } = adapterContext(async function* (opts: any) {
      users.push(opts.messages[0].content[0].text);
      yield { type: "text-delta", text: EMPTY_EXTRACTION };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
      extractionRetryDelaysMs: [0, 0],
    });
    // One 10K-char message (always fits alone) plus two short messages:
    // the long one must not drag the short ones into an oversized request.
    const long = "x".repeat(10_000);
    const agent = {
      id: "length-test",
      session: { events: [userMsg(0, long), userMsg(1, "short-a"), userMsg(2, "short-b")] },
    };
    await startAndEndTurn(listeners, agent);

    await waitFor(() => logs.filter(l => l.includes("DSH extracted")).length >= 2);
    expect(users.length).toBeGreaterThanOrEqual(2);
    for (const user of users) {
      // template (34) + names hint (<=3000) + msgs (<=8000) + JSON wrappers
      expect(user.length).toBeLessThan(12_000);
    }
    expect(countPending(dbPath)).toBe(0);
    const db = new DatabaseSync(dbPath);
    const stored = db.prepare("SELECT content FROM gm_messages WHERE turn_index=0").get() as any;
    expect(normalizeExtractionContent(stored.content)).toBe(long);
    db.close();
    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes an AbortSignal to DSH and aborts a stalled provider on timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-resilience-"));
    const dbPath = join(dir, "graph-memory.db");
    let observedSignal: AbortSignal | undefined;
    const { context, listeners, cleanups } = adapterContext(async function* (opts: any) {
      observedSignal = opts.signal;
      await new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
      });
      if (false) yield undefined;
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
      extractionDrain: { streamTimeoutMs: 20, maxRetries: 0, retryDelaysMs: [] },
    });
    await startAndEndTurn(listeners, {
      id: "timeout-test", session: { events: [userMsg(0, "stall")] },
    });

    await waitFor(() => countState(dbPath, "quarantined") === 1);
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("requeues quarantined messages explicitly and learns them on a later healthy call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-resilience-"));
    const dbPath = join(dir, "graph-memory.db");
    let healthy = false;
    const { context, listeners, cleanups, tools } = adapterContext(async function* () {
      if (!healthy) throw new Error("provider unavailable");
      yield { type: "text-delta", text: EMPTY_EXTRACTION };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
      extractionDrain: { maxRetries: 0, retryDelaysMs: [] },
    });
    await startAndEndTurn(listeners, {
      id: "retry-tool-test", session: { events: [userMsg(0, "remember me")] },
    });
    await waitFor(() => countState(dbPath, "quarantined") === 1);

    healthy = true;
    const result = await tools.get("gm_retry_extraction").execute({ sessionId: "retry-tool-test" });
    expect(result).toContain("Requeued 1");
    await waitFor(() => countState(dbPath, "succeeded") === 1);
    expect(countState(dbPath, "quarantined")).toBe(0);
    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("gracefully drains work scheduled immediately before host shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-resilience-"));
    const dbPath = join(dir, "graph-memory.db");
    const { context, listeners, cleanups } = adapterContext(async function* () {
      await new Promise(resolve => setTimeout(resolve, 20));
      yield { type: "text-delta", text: EMPTY_EXTRACTION };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
      extractionDrain: { shutdownGraceMs: 1_000 },
    });
    const agent = { id: "shutdown-test", session: { events: [userMsg(0, "last message")] } };
    listeners.get("agent/session-start")![0]({ agent });
    const ending = listeners.get("agent/turn-stopping")![0]({
      agent,
      signal: new AbortController().signal,
    });

    await Promise.all(cleanups.map(cleanup => cleanup()));
    await ending;
    expect(countState(dbPath, "succeeded")).toBe(1);
    expect(countPending(dbPath)).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
