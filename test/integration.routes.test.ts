import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "neo4j-driver";
import { registerCrudRoutes } from "../src/routes/crud.ts";
import { closeDriver, getDriver, getSession, initSchema } from "../src/store/db.ts";
import { findById, upsertNode } from "../src/store/store.ts";

const ENABLED = !!process.env.NEO4J_INTEGRATION;
const TEST_SID = `routes-${Date.now()}`;

let driver: Driver;
let routeHandler: (req: any, res: any) => Promise<boolean>;

async function request(method: string, path: string, body?: Record<string, unknown>) {
  const chunks = body ? [Buffer.from(JSON.stringify(body), "utf-8")] : [];
  const req = Readable.from(chunks) as any;
  req.method = method;
  req.url = `/graph-memory-pro/api/${path}`;

  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; },
    end(raw?: string) { payload = raw ? JSON.parse(raw) : undefined; },
  };

  await routeHandler(req, res);
  return { status, payload };
}

describe.skipIf(!ENABLED)("CRUD route integration", () => {
  beforeAll(async () => {
    driver = getDriver({ uri: "bolt://localhost:7687", user: "neo4j", password: "graphmemory" });
    await initSchema(driver);

    const api = {
      registerHttpRoute(options: any) { routeHandler = options.handler; },
      logger: { info() {}, error() {} },
    };
    const recaller = { syncEmbed: async () => {} };
    registerCrudRoutes(api as any, driver, recaller as any);
  }, 60_000);

  afterAll(async () => {
    const session = getSession(driver);
    try {
      await session.run("MATCH (n) WHERE $sid IN n.sourceSessions DETACH DELETE n", { sid: TEST_SID });
    } finally {
      await session.close();
    }
    await closeDriver();
  });

  it("updates the node property and Neo4j label together", async () => {
    const { node } = await upsertNode(driver, {
      type: "TASK", name: "route-label-update", description: "d", content: "c",
    }, TEST_SID);

    const response = await request("PUT", `nodes?id=${node.id}`, { type: "EVENT" });
    expect(response.status).toBe(200);
    expect(response.payload.node.type).toBe("EVENT");

    const session = getSession(driver);
    try {
      const result = await session.run(
        "MATCH (n {id: $id}) RETURN labels(n) AS labels, n.type AS type",
        { id: node.id },
      );
      const labels = result.records[0].get("labels") as string[];
      expect(labels).toContain("MemoryNode");
      expect(labels).toContain("Event");
      expect(labels).not.toContain("Task");
      expect(result.records[0].get("type")).toBe("EVENT");
    } finally {
      await session.close();
    }
  });

  it("rejects cross-type merges without deprecating either node", async () => {
    const { node: event } = await upsertNode(driver, {
      type: "EVENT", name: "route-merge-event", description: "d", content: "c",
    }, TEST_SID);
    const { node: skill } = await upsertNode(driver, {
      type: "SKILL", name: "route-merge-skill", description: "d", content: "c",
    }, TEST_SID);

    const response = await request("POST", "nodes/merge", {
      keepId: event.id,
      mergeId: skill.id,
    });
    expect(response.status).toBe(400);
    expect((await findById(driver, event.id))?.status).toBe("active");
    expect((await findById(driver, skill.id))?.status).toBe("active");
  });

  it("rejects a whitelisted edge type when its endpoint direction is invalid", async () => {
    const { node: skill } = await upsertNode(driver, {
      type: "SKILL", name: "route-edge-skill", description: "d", content: "c",
    }, TEST_SID);
    const { node: task } = await upsertNode(driver, {
      type: "TASK", name: "route-edge-task", description: "d", content: "c",
    }, TEST_SID);

    const response = await request("POST", "edges", {
      fromId: skill.id,
      toId: task.id,
      type: "USED_SKILL",
      instruction: "invalid direction",
    });
    expect(response.status).toBe(400);
  });
});
