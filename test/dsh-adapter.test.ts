import { describe, expect, it } from "vitest";

import { apply, eventMessage } from "../dsh.ts";

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
