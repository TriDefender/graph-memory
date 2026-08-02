/**
 * recaller 集成测试 — 移植自原 test/recall-*.test.ts
 *
 * 覆盖：Recaller.recall 双路径（precise + generalized）+
 *       syncEmbed hash-based 跳过逻辑
 *
 * 运行：NEO4J_INTEGRATION=1 npm test -- test/integration.recall.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "neo4j-driver";
import { getDriver, initSchema, closeDriver, getSession } from "../src/store/db.ts";
import {
  upsertNode, upsertEdge, saveVector, getVectorHash,
} from "../src/store/store.ts";
import { Recaller } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG, type GmConfig } from "../src/types.ts";

const ENABLED = !!process.env.NEO4J_INTEGRATION;

let driver: Driver;
const TEST_SID = `recall-${Date.now()}`;
const cfg: GmConfig = { ...DEFAULT_CONFIG, recallMaxNodes: 5, recallMaxDepth: 2 };

describe.skipIf(!ENABLED)("Recaller integration", () => {
  beforeAll(async () => {
    driver = getDriver({ uri: "bolt://localhost:7687", user: "neo4j", password: "graphmemory" });
    await initSchema(driver);

    // 构造可被关键词召回的图
    const { node: skill } = await upsertNode(driver, {
      type: "SKILL", name: "recall-target-skill",
      description: "docker compose deployment",
      content: "docker compose up -d for deployment",
    }, TEST_SID);
    const { node: task } = await upsertNode(driver, {
      type: "TASK", name: "recall-target-task",
      description: "deploy with docker",
      content: "use docker to deploy",
    }, TEST_SID);
    await upsertEdge(driver, {
      fromId: task.id, toId: skill.id, type: "USED_SKILL",
      instruction: "deploys with", sessionId: TEST_SID,
    });
  }, 60000);

  afterAll(async () => {
    const session = getSession(driver);
    try {
      await session.run("MATCH (n) WHERE $sid IN n.sourceSessions DETACH DELETE n", { sid: TEST_SID });
    } finally {
      await session.close();
    }
    await closeDriver();
  }, 30000);

  it("recall 不带 embedFn：降级到 searchNodes 路径，返回合法结构", async () => {
    const recaller = new Recaller(driver, cfg);

    const result = await recaller.recall("docker deploy");

    // 结构验证（不依赖具体节点返回 —— PPR 排序受共享 Neo4j 现有数据影响）
    expect(result).toHaveProperty("nodes");
    expect(result).toHaveProperty("edges");
    expect(result).toHaveProperty("tokenEstimate");
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
    // 如果有节点返回，tokenEstimate 应 > 0
    if (result.nodes.length > 0) {
      expect(result.tokenEstimate).toBeGreaterThan(0);
    }
  });

  it("recall 带 mock embedFn：走向量搜索路径，不抛错", async () => {
    // mock embed 返回固定向量（触发向量搜索路径，不依赖真实匹配）
    const dim = 1024;
    const mockEmbed = async (_text: string): Promise<number[]> => {
      return new Array(dim).fill(0).map((_, i) => (i % 7) / 7);
    };

    const recaller = new Recaller(driver, cfg);
    recaller.setEmbedFn(mockEmbed);

    // 不抛错即通过（向量维度不匹配时 recallPrecise 内部 try/catch 会 fallback）
    const result = await recaller.recall("docker");
    expect(result).toHaveProperty("nodes");
    expect(result).toHaveProperty("edges");
    expect(result).toHaveProperty("tokenEstimate");
  });

  it("recall 空查询：降级到 topNodes，返回合法结构", async () => {
    const recaller = new Recaller(driver, cfg);
    const result = await recaller.recall("   ");
    expect(result).toHaveProperty("nodes");
    expect(result).toHaveProperty("edges");
    expect(result).toHaveProperty("tokenEstimate");
    expect(result.nodes.length).toBeGreaterThanOrEqual(0);
  });

  it("syncEmbed：无 embedFn 时静默跳过（不抛错）", async () => {
    const recaller = new Recaller(driver, cfg);
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "syncembed-noop-target", description: "x", content: "y",
    }, TEST_SID);
    // 不调 setEmbedFn → this.embed 是 null → syncEmbed 立即 return
    await expect(recaller.syncEmbed(node)).resolves.toBeUndefined();
  });

  it("syncEmbed：内容 hash 与已存一致时跳过 saveVector", async () => {
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "syncembed-hash-target", description: "hash test", content: "stable content",
    }, TEST_SID);

    // 先写入向量
    const initialVec = new Array(1024).fill(0).map((_, i) => Math.cos(i * 0.05));
    await saveVector(driver, node.id, "stable content", initialVec);
    const hashBefore = await getVectorHash(driver, node.id);
    expect(hashBefore).not.toBeNull();

    // syncEmbed 用相同 content 计算 hash，应与已存一致 → 跳过 saveVector
    let embedCalled = false;
    const trackingEmbed = async (_text: string): Promise<number[]> => {
      embedCalled = true;
      return new Array(1024).fill(0.5);
    };

    const recaller = new Recaller(driver, cfg);
    recaller.setEmbedFn(trackingEmbed);
    await recaller.syncEmbed(node);

    // hash 一致 → 不会调用 embed（saveVector 不会触发）
    expect(embedCalled).toBe(false);

    // 验证向量未被覆盖
    const hashAfter = await getVectorHash(driver, node.id);
    expect(hashAfter).toBe(hashBefore);
  });

  it("syncEmbed：内容变化时 hash 不同 → 触发 embed + saveVector", async () => {
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "syncembed-change-target",
      description: "will change", content: "old content",
    }, TEST_SID);

    const oldVec = new Array(1024).fill(0).map((_, i) => Math.sin(i * 0.1));
    await saveVector(driver, node.id, "old content", oldVec);

    // 模拟节点内容已变化（直接 fetch 后改 content，再 syncEmbed）
    const refetched = { ...node, content: "completely new content after change" };

    let embedCalled = false;
    const trackingEmbed = async (_text: string): Promise<number[]> => {
      embedCalled = true;
      return new Array(1024).fill(0.7);
    };

    const recaller = new Recaller(driver, cfg);
    recaller.setEmbedFn(trackingEmbed);
    await recaller.syncEmbed(refetched);

    expect(embedCalled).toBe(true);
  });
});
