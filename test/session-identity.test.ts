import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBySession: vi.fn(async () => []),
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
  saveMessage: async () => {},
  getUnextracted: async () => [],
  markExtracted: async () => {},
  isTurnExtracted: async () => false,
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
  readonly assemble: (params: {
    readonly sessionId: string;
    readonly sessionKey?: string;
    readonly messages: readonly unknown[];
  }) => Promise<unknown>;
  readonly prepareSubagentSpawn: (params: {
    readonly parentSessionKey: string;
    readonly childSessionKey: string;
    readonly parentSessionId?: string;
  }) => Promise<{ readonly rollback: () => void }>;
};

function registerPlugin(): { readonly hooks: Map<string, HookHandler>; readonly engine: EngineHarness } {
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
    pluginConfig: {},
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
