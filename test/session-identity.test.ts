import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCronSessionKey } from "../src/types.ts";

const mocks = vi.hoisted(() => ({
  getBySession: vi.fn(async () => []),
  saveMessage: vi.fn(async () => {}),
  getMaxTurnIndex: vi.fn(async () => 0),
  getUnextracted: vi.fn(async () => []),
  isTurnExtracted: vi.fn(async () => false),
  recall: vi.fn(async () => ({
    nodes: [{ id: "recalled-node" }],
    edges: [],
    tokenEstimate: 1,
  })),
  assembleContext: vi.fn(async () => ({ xml: "", systemPrompt: "", tokens: 0 })),
  runMaintenance: vi.fn(async () => ({
    durationMs: 0,
    dedup: { merged: 0 },
    community: { count: 0 },
    communitySummaries: 0,
    pagerank: { topK: [] },
  })),
}));

vi.mock("../src/store/db.ts", () => ({
  getDriver: () => ({}),
  initSchema: async () => {},
  getSession: () => ({ close: async () => {} }),
  closeDriver: async () => {},
}));

vi.mock("../src/store/store.ts", () => ({
  saveMessage: mocks.saveMessage,
  getUnextracted: mocks.getUnextracted,
  getMaxTurnIndex: mocks.getMaxTurnIndex,
  markExtracted: async () => {},
  isTurnExtracted: mocks.isTurnExtracted,
  upsertNode: async () => ({ node: {}, isNew: false }),
  upsertEdge: async () => {},
  findByName: async () => null,
  updateNode: async () => null,
  getBySession: mocks.getBySession,
  edgesFrom: async () => [],
  edgesTo: async () => [],
  deprecate: async () => {},
  getStats: async () => ({}),
}));

vi.mock("../src/engine/llm.ts", () => ({
  createCompleteFn: () => async () => "",
  resolveProvider: () => ({ provider: "openai", inferred: false }),
}));

vi.mock("../src/engine/embed.ts", () => ({
  createEmbedFn: async () => null,
}));

vi.mock("../src/recaller/recall.ts", () => ({
  Recaller: class {
    setEmbedFn(): void {}
    async recall() { return mocks.recall(); }
    async syncEmbed(): Promise<void> {}
  },
}));

vi.mock("../src/extractor/extract.ts", () => ({
  Extractor: class {
    async extract() { return { nodes: [], edges: [] }; }
    async finalize() { return { promotedSkills: [], newEdges: [], invalidations: [] }; }
  },
}));

vi.mock("../src/format/assemble.ts", () => ({
  assembleContext: mocks.assembleContext,
}));

vi.mock("../src/graph/maintenance.ts", () => ({
  runMaintenance: mocks.runMaintenance,
}));

vi.mock("../src/routes/crud.ts", () => ({
  registerCrudRoutes: () => {},
}));

import graphMemoryProPlugin from "../index.ts";

type HookHandler = (event: Record<string, unknown>, context: Record<string, unknown>) => Promise<void>;
type EngineHarness = {
  readonly bootstrap: (params: { readonly sessionId: string; readonly sessionKey?: string }) => Promise<unknown>;
  readonly ingest: (params: {
    readonly sessionId: string;
    readonly sessionKey?: string;
    readonly message: unknown;
    readonly isHeartbeat?: boolean;
  }) => Promise<{ readonly ingested: boolean }>;
  readonly assemble: (params: {
    readonly sessionId: string;
    readonly sessionKey?: string;
    readonly messages: readonly unknown[];
  }) => Promise<unknown>;
  readonly compact: (params: { readonly sessionId: string; readonly sessionKey?: string }) => Promise<{
    readonly ok: boolean;
    readonly compacted: boolean;
    readonly reason?: string;
  }>;
  readonly afterTurn: (params: {
    readonly sessionId: string;
    readonly sessionKey?: string;
    readonly messages: readonly unknown[];
    readonly prePromptMessageCount: number;
  }) => Promise<void>;
  readonly prepareSubagentSpawn: (params: {
    readonly parentSessionKey: string;
    readonly childSessionKey: string;
    readonly parentSessionId?: string;
  }) => Promise<{ readonly rollback: () => void }>;
};

function registerPlugin(pluginConfig: Record<string, unknown> = {}): { readonly hooks: Map<string, HookHandler>; readonly engine: EngineHarness } {
  const hooks = new Map<string, HookHandler>();
  let engine: EngineHarness | undefined;
  graphMemoryProPlugin.register({
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    config: {},
    pluginConfig,
    resolvePath: (path: string) => path,
    on: (event: string, handler: HookHandler) => { hooks.set(event, handler); },
    registerContextEngine: (_id: string, factory: () => EngineHarness) => { engine = factory(); },
    registerTool: () => {},
    registerHttpRoute: () => {},
  });
  if (!engine) throw new Error("context engine was not registered");
  return { hooks, engine };
}

describe("session identity", () => {
  beforeEach(() => {
    mocks.getBySession.mockClear();
    mocks.recall.mockClear();
    mocks.assembleContext.mockClear();
    mocks.runMaintenance.mockClear();
  });

  it("finalizes the ended transcript sessionId instead of its routing sessionKey", async () => {
    const handler = registerPlugin().hooks.get("session_end");
    if (!handler) throw new Error("session_end hook was not registered");

    await handler(
      { sessionId: "ended-transcript", sessionKey: "agent:main" },
      { sessionId: "successor-transcript", sessionKey: "agent:main" },
    );

    expect(mocks.getBySession).toHaveBeenCalledWith({}, "ended-transcript");
  });

  it("transfers recalled context to a subagent by resolving its sessionKey to sessionId", async () => {
    const { hooks, engine } = registerPlugin();
    const beforeAgentStart = hooks.get("before_agent_start");
    if (!beforeAgentStart) throw new Error("before_agent_start hook was not registered");

    await beforeAgentStart(
      { prompt: "remember the parent context" },
      { sessionId: "parent-transcript", sessionKey: "agent:main" },
    );
    await engine.prepareSubagentSpawn({
      parentSessionId: "parent-transcript",
      parentSessionKey: "agent:main",
      childSessionKey: "agent:main:subagent:1",
    });
    await engine.bootstrap({
      sessionId: "child-transcript",
      sessionKey: "agent:main:subagent:1",
    });
    await engine.assemble({
      sessionId: "child-transcript",
      sessionKey: "agent:main:subagent:1",
      messages: [],
    });

    expect(mocks.assembleContext).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ recalledNodes: [{ id: "recalled-node" }] }),
    );
  });
});

describe("cron session gating (cron 配置)", () => {
  beforeEach(() => {
    mocks.getBySession.mockClear();
    mocks.saveMessage.mockClear();
    mocks.getMaxTurnIndex.mockClear();
    mocks.getUnextracted.mockClear();
    mocks.isTurnExtracted.mockClear();
    mocks.recall.mockClear();
    mocks.assembleContext.mockClear();
    mocks.runMaintenance.mockClear();
  });

  // host 契约：sessionId 是随机 transcript UUID，cron 标记在 sessionKey 上
  const CRON_KEY = "agent:agent-1:cron:daily-report";
  const CRON_SID = "0f1e2d3c-4b5a-6978-8976-543210fedcba";

  it("isCronSessionKey 按 sessionKey 段匹配 cron 标记", () => {
    expect(isCronSessionKey("cron:job-1")).toBe(true);
    expect(isCronSessionKey("agent:agent-1:cron:daily")).toBe(true);
    expect(isCronSessionKey("agent:agent-1:cron:daily:run:r1")).toBe(true);
    expect(isCronSessionKey("agent:main")).toBe(false);
    expect(isCronSessionKey("agent:cron-daily:main")).toBe(false);
    expect(isCronSessionKey("scheduled-cron:x")).toBe(false);
    expect(isCronSessionKey("")).toBe(false);
    expect(isCronSessionKey(undefined)).toBe(false);
    expect(isCronSessionKey(null)).toBe(false);
  });

  it("默认配置（全 true）下 cron session_end 仍执行 finalize 与图维护（向后兼容）", async () => {
    const handler = registerPlugin().hooks.get("session_end");
    if (!handler) throw new Error("session_end hook was not registered");

    await handler({ sessionId: CRON_SID, sessionKey: CRON_KEY }, {});

    expect(mocks.getBySession).toHaveBeenCalledWith({}, CRON_SID);
    expect(mocks.runMaintenance).toHaveBeenCalledTimes(1);
  });

  it("默认配置下 cron session 正常入库", async () => {
    const { engine } = registerPlugin();

    await expect(engine.ingest({ sessionId: CRON_SID, sessionKey: CRON_KEY, message: { role: "user", content: "hi" } }))
      .resolves.toEqual({ ingested: true });
    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);
  });

  it("finalizeAndMaintain=false 时 cron session 跳过 finalize 与图维护", async () => {
    const handler = registerPlugin({ cron: { enabled: true, finalizeAndMaintain: false } }).hooks.get("session_end");
    if (!handler) throw new Error("session_end hook was not registered");

    await handler({ sessionId: CRON_SID, sessionKey: CRON_KEY }, {});

    expect(mocks.getBySession).not.toHaveBeenCalled();
    expect(mocks.runMaintenance).not.toHaveBeenCalled();
  });

  it("finalizeAndMaintain=true 时 cron session 执行 finalize 与图维护", async () => {
    const handler = registerPlugin({ cron: { enabled: true, finalizeAndMaintain: true } }).hooks.get("session_end");
    if (!handler) throw new Error("session_end hook was not registered");

    await handler({ sessionId: CRON_SID, sessionKey: CRON_KEY }, {});

    expect(mocks.getBySession).toHaveBeenCalledWith({}, CRON_SID);
    expect(mocks.runMaintenance).toHaveBeenCalledTimes(1);
  });

  it("finalizeAndMaintain=true 不影响普通会话的既有行为", async () => {
    const handler = registerPlugin({ cron: { enabled: true, finalizeAndMaintain: false } }).hooks.get("session_end");
    if (!handler) throw new Error("session_end hook was not registered");

    await handler({ sessionId: "normal-session", sessionKey: "agent:main" }, {});

    expect(mocks.runMaintenance).toHaveBeenCalledTimes(1);
  });

  it("enabled=false 时 cron session 不召回、不入库、不注入图谱上下文", async () => {
    const { hooks, engine } = registerPlugin({ cron: { enabled: false } });

    const beforeAgentStart = hooks.get("before_agent_start");
    if (!beforeAgentStart) throw new Error("before_agent_start hook was not registered");
    await beforeAgentStart({ prompt: "daily digest" }, { sessionKey: CRON_KEY });
    expect(mocks.recall).not.toHaveBeenCalled();

    await expect(engine.ingest({ sessionId: CRON_SID, sessionKey: CRON_KEY, message: { role: "user", content: "hi" } }))
      .resolves.toEqual({ ingested: false });
    expect(mocks.saveMessage).not.toHaveBeenCalled();

    await engine.assemble({ sessionId: CRON_SID, sessionKey: CRON_KEY, messages: [] });
    expect(mocks.assembleContext).not.toHaveBeenCalled();
  });

  it("enabled=false 总开关：cron afterTurn 跳过入库回填，compact 跳过提取", async () => {
    const { engine } = registerPlugin({ cron: { enabled: false } });

    await engine.afterTurn({
      sessionId: CRON_SID,
      sessionKey: CRON_KEY,
      messages: [{ role: "user", content: "hi" }],
      prePromptMessageCount: 0,
    });
    expect(mocks.saveMessage).not.toHaveBeenCalled();
    expect(mocks.isTurnExtracted).not.toHaveBeenCalled();

    const res = await engine.compact({ sessionId: CRON_SID, sessionKey: CRON_KEY });
    expect(res).toEqual({ ok: true, compacted: false, reason: "cron session graph disabled" });
    expect(mocks.getUnextracted).not.toHaveBeenCalled();
  });

  it("enabled=true 时 cron session 正常入库", async () => {
    const { engine } = registerPlugin({ cron: { enabled: true } });

    await engine.ingest({ sessionId: CRON_SID, sessionKey: CRON_KEY, message: { role: "user", content: "hi" } });

    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);
  });

  it("extract=false 时 cron session 消息仍入库缓冲但不触发提取", async () => {
    const { engine } = registerPlugin({ cron: { enabled: true, extract: false } });

    await engine.afterTurn({
      sessionId: CRON_SID,
      sessionKey: CRON_KEY,
      messages: [{ role: "user", content: "hi" }],
      prePromptMessageCount: 0,
    });

    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);
    expect(mocks.isTurnExtracted).not.toHaveBeenCalled();
  });

  it("extract=true 时 cron session 触发提取", async () => {
    const { engine } = registerPlugin({ cron: { enabled: true, extract: true } });

    await engine.afterTurn({
      sessionId: CRON_SID,
      sessionKey: CRON_KEY,
      messages: [{ role: "user", content: "hi" }],
      prePromptMessageCount: 0,
    });
    // afterTurn 内的 extractTurnKnowledge 是 fire-and-forget，flush 微任务后再断言
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mocks.isTurnExtracted).toHaveBeenCalledTimes(1);
  });

  it("extract=false 时 cron session compact 直接跳过提取", async () => {
    const { engine } = registerPlugin({ cron: { enabled: true, extract: false } });

    const res = await engine.compact({ sessionId: CRON_SID, sessionKey: CRON_KEY });

    expect(res).toEqual({ ok: true, compacted: false, reason: "cron session extraction disabled" });
    expect(mocks.getUnextracted).not.toHaveBeenCalled();
  });

  it("cron 任务设置自定义 sessionKey（无 cron 段）时按普通会话处理", async () => {
    const { engine } = registerPlugin({ cron: { enabled: false } });

    await expect(engine.ingest({ sessionId: CRON_SID, sessionKey: "agent:my-custom-key", message: { role: "user", content: "hi" } }))
      .resolves.toEqual({ ingested: true });

    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);
  });
});
