import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "neo4j-driver";
import { getDriver, initSchema, closeDriver, getSession } from "../src/store/db.ts";
import {
  upsertNode, findByName, findById, updateNode,
  upsertEdge, edgesFrom, edgesTo, graphWalk,
  saveMessage, getUnextracted, markExtracted, isTurnExtracted,
  deprecate, getStats, mergeNodes, searchNodes, topNodes,
  getBySession, saveVector, vectorSearchWithScore, getVectorHash,
  updateCommunities, updatePageranks,
} from "../src/store/store.ts";

// 仅在 NEO4J_INTEGRATION=1 时运行，避免污染默认 npm test（需要 Docker Neo4j）
const ENABLED = !!process.env.NEO4J_INTEGRATION;

let driver: Driver;
const TEST_SID = `integration-${Date.now()}`;

describe.skipIf(!ENABLED)("Neo4j integration (Docker)", () => {
  beforeAll(async () => {
    driver = getDriver({ uri: "bolt://localhost:7687", user: "neo4j", password: "graphmemory" });
    await initSchema(driver);
  }, 60000);

  afterAll(async () => {
    const session = getSession(driver);
    try {
      await session.run("MATCH (n) WHERE $sid IN n.sourceSessions DETACH DELETE n", { sid: TEST_SID });
      await session.run("MATCH (m:GmMessage {sessionId: $sid}) DELETE m", { sid: TEST_SID });
    } finally {
      await session.close();
    }
    await closeDriver();
  }, 30000);

  it("upsertNode 创建节点 + findByName 取回（名称标准化）", async () => {
    const { node, isNew } = await upsertNode(driver, {
      type: "SKILL", name: "Docker Build",
      description: "build images", content: "docker build -t name .",
    }, TEST_SID);
    expect(isNew).toBe(true);
    expect(node.name).toBe("docker-build");
    expect(node.type).toBe("SKILL");

    const found = await findByName(driver, "Docker Build");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(node.id);
  });

  it("upsertNode 同名更新（isNew=false，validatedCount 递增）", async () => {
    const { node, isNew } = await upsertNode(driver, {
      type: "SKILL", name: "Docker Build",
      description: "better desc", content: "longer content here",
    }, TEST_SID);
    expect(isNew).toBe(false);
    expect(node.validatedCount).toBeGreaterThanOrEqual(2);
  });

  it("updateNode (#57 移植) 按 name 更新 description/content 并持久化", async () => {
    const updated = await updateNode(driver, "docker-build", {
      description: "refined desc",
      content: "refined content",
    });
    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("refined desc");
    expect(updated!.content).toBe("refined content");
    const refetch = await findByName(driver, "docker-build");
    expect(refetch!.description).toBe("refined desc");
    expect(refetch!.content).toBe("refined content");
  });

  it("updateNode 未知 name 返回 null", async () => {
    expect(await updateNode(driver, "ghost-node-xyz", { description: "x" })).toBeNull();
  });

  it("upsertEdge (APOC) 建边 + edgesFrom 取回", async () => {
    const { node: task } = await upsertNode(driver, {
      type: "TASK", name: "Deploy App", description: "d", content: "c",
    }, TEST_SID);
    const { node: skill } = await upsertNode(driver, {
      type: "SKILL", name: "CI/CD Pipeline", description: "d", content: "c",
    }, TEST_SID);
    await upsertEdge(driver, {
      fromId: task.id, toId: skill.id, type: "USED_SKILL",
      instruction: "uses", sessionId: TEST_SID,
    });
    const edges = await edgesFrom(driver, task.id);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges.some(e => e.type === "USED_SKILL" && e.toId === skill.id)).toBe(true);
  });

  it("upsertEdge 幂等：同 from+to+type 不重复创建", async () => {
    const task = await findByName(driver, "deploy-app");
    const skill = await findByName(driver, "cicd-pipeline");
    const before = await edgesFrom(driver, task!.id);
    await upsertEdge(driver, {
      fromId: task!.id, toId: skill!.id, type: "USED_SKILL",
      instruction: "uses v2", sessionId: TEST_SID,
    });
    const after = await edgesFrom(driver, task!.id);
    expect(after.length).toBe(before.length);
    // instruction 应被更新
    expect(after.find(e => e.toId === skill!.id)!.instruction).toBe("uses v2");
  });

  it("edgesTo 反向查询（目标节点收到入边）", async () => {
    const skill = await findByName(driver, "cicd-pipeline");
    const incoming = await edgesTo(driver, skill!.id);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
    expect(incoming.some(e => e.type === "USED_SKILL")).toBe(true);
  });

  it("upsertEdge 在存储层拒绝非法方向和白名单外类型", async () => {
    const task = await findByName(driver, "deploy-app");
    const skill = await findByName(driver, "cicd-pipeline");

    expect(await upsertEdge(driver, {
      fromId: skill!.id, toId: task!.id, type: "USED_SKILL",
      instruction: "wrong direction", sessionId: TEST_SID,
    })).toBe(false);
    expect(await upsertEdge(driver, {
      fromId: skill!.id, toId: skill!.id, type: "ARBITRARY_REL" as any,
      instruction: "unknown type", sessionId: TEST_SID,
    })).toBe(false);
  });

  it("graphWalk 从 seed 遍历到关联节点", async () => {
    const seed = await findByName(driver, "deploy-app");
    expect(seed).not.toBeNull();
    const { nodes, edges } = await graphWalk(driver, [seed!.id], 2);
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.some(n => n.name === "cicd-pipeline")).toBe(true);
    expect(edges.some(e => e.type === "USED_SKILL")).toBe(true);
  });

  it("graphWalk 空种子返回空结果", async () => {
    const { nodes, edges } = await graphWalk(driver, [], 2);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("saveMessage + getUnextracted + markExtracted + isTurnExtracted (#1/#2 修复路径)", async () => {
    await saveMessage(driver, TEST_SID, 100, "user", { text: "hello" });
    await saveMessage(driver, TEST_SID, 101, "turn", [{ role: "user", content: "x" }]);

    const before = await getUnextracted(driver, TEST_SID, 10);
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(await isTurnExtracted(driver, TEST_SID, 100)).toBe(false);

    await markExtracted(driver, TEST_SID, 101);

    expect(await isTurnExtracted(driver, TEST_SID, 100)).toBe(true);
    expect(await isTurnExtracted(driver, TEST_SID, 101)).toBe(true);

    const after = await getUnextracted(driver, TEST_SID, 10);
    expect(after.length).toBe(0);
  });

  it("getStats (#9 去除冗余查询后) 返回完整结构", async () => {
    const stats = await getStats(driver);
    expect(stats).toHaveProperty("totalNodes");
    expect(stats).toHaveProperty("byType");
    expect(stats).toHaveProperty("totalEdges");
    expect(stats).toHaveProperty("byEdgeType");
    expect(stats).toHaveProperty("communities");
    expect(typeof stats.totalNodes).toBe("number");
    expect(stats.totalNodes).toBeGreaterThanOrEqual(1);
    expect(stats.byType.SKILL).toBeGreaterThanOrEqual(1);
  });

  it("deprecate 软删除（status=deprecated，节点仍存在）", async () => {
    const { node } = await upsertNode(driver, {
      type: "EVENT", name: "Temp Event", description: "d", content: "c",
    }, TEST_SID);
    await deprecate(driver, node.id);
    const refetch = await findById(driver, node.id);
    expect(refetch).not.toBeNull();
    expect(refetch!.status).toBe("deprecated");
  });

  // ─── SQLite 时代 store 测试意图移植 ─────────────────────────────
  // 以下用例对应原 test/store.test.ts 中被删除的 SQLite 测试场景：
  // 节点合并、向量搜索、社区更新、按 session 查询、关键词搜索

  it("mergeNodes 合并：keep 保留 + merge 标记 deprecated + 入边/出边迁移", async () => {
    // 构造图：a → merge → keep → c （merge 同时有入边和出边）
    const { node: a } = await upsertNode(driver, {
      type: "TASK", name: "Merge Source A", description: "src", content: "src content",
    }, TEST_SID);
    const { node: merge } = await upsertNode(driver, {
      type: "SKILL", name: "Merge Target", description: "will be merged",
      content: "merge-content-longer",
    }, TEST_SID);
    const { node: keep } = await upsertNode(driver, {
      type: "SKILL", name: "Merge Keeper", description: "will keep",
      content: "keep-content",
    }, TEST_SID);
    const { node: c } = await upsertNode(driver, {
      type: "SKILL", name: "Merge Downstream C", description: "downstream", content: "c content",
    }, TEST_SID);

    await upsertEdge(driver, { fromId: a.id, toId: merge.id, type: "USED_SKILL", instruction: "uses", sessionId: TEST_SID });
    await upsertEdge(driver, { fromId: merge.id, toId: c.id, type: "REQUIRES", instruction: "needs", sessionId: TEST_SID });

    const keepValidatedBefore = keep.validatedCount;
    const mergeContentBefore = (await findById(driver, merge.id))!.content;

    await mergeNodes(driver, keep.id, merge.id);

    const keepAfter = await findById(driver, keep.id);
    const mergeAfter = await findById(driver, merge.id);
    expect(keepAfter).not.toBeNull();
    expect(mergeAfter!.status).toBe("deprecated");
    // validatedCount 应累加
    expect(keepAfter!.validatedCount).toBeGreaterThanOrEqual(keepValidatedBefore);
    // content 应取较长的（merge-content-longer > keep-content）
    expect(keepAfter!.content).toBe(mergeContentBefore);

    // 入边迁移：a → merge 现在应是 a → keep
    const aOut = await edgesFrom(driver, a.id);
    expect(aOut.some(e => e.toId === keep.id && e.type === "USED_SKILL")).toBe(true);
    // 出边迁移：merge → c 现在应是 keep → c
    const keepOut = await edgesFrom(driver, keep.id);
    expect(keepOut.some(e => e.toId === c.id && e.type === "REQUIRES")).toBe(true);
  });

  it("saveVector + vectorSearchWithScore + getVectorHash（向量索引可用）", async () => {
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "Vector Test Skill", description: "v", content: "vector search target",
    }, TEST_SID);

    // 1024 维向量（与 initSchema 默认维度一致）
    const vec = new Array(1024).fill(0).map((_, i) => (i % 10) / 10);
    await saveVector(driver, node.id, "vector search target", vec);

    const hash = await getVectorHash(driver, node.id);
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[a-f0-9]{32}$/);

    // 向量搜索（自己搜自己应该排第一）
    const results = await vectorSearchWithScore(driver, vec, 5, 0);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].node.id).toBe(node.id);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("updateCommunities + getBySession + communityRepresentatives", async () => {
    const { node: n1 } = await upsertNode(driver, {
      type: "SKILL", name: "Community Member 1", description: "cm1", content: "c1",
    }, TEST_SID);
    const { node: n2 } = await upsertNode(driver, {
      type: "SKILL", name: "Community Member 2", description: "cm2", content: "c2",
    }, TEST_SID);

    const labels = new Map<string, string>([
      [n1.id, "c-test-1"], [n2.id, "c-test-1"],
    ]);
    await updateCommunities(driver, labels);

    const refetch1 = await findById(driver, n1.id);
    expect(refetch1!.communityId).toBe("c-test-1");

    // getBySession：两个节点都标记了 TEST_SID
    const bySid = await getBySession(driver, TEST_SID);
    const ids = bySid.map(n => n.id);
    expect(ids).toContain(n1.id);
    expect(ids).toContain(n2.id);
  });

  it("searchNodes 关键词模糊匹配 + topNodes 按 pagerank 排序", async () => {
    await upsertNode(driver, {
      type: "SKILL", name: "Kubernetes Deploy Unique Keyword", description: "k8s", content: "kubectl apply",
    }, TEST_SID);
    await upsertNode(driver, {
      type: "SKILL", name: "Another Kubernetes Skill", description: "k8s alt", content: "kubectl get pods",
    }, TEST_SID);

    const hits = await searchNodes(driver, "Kubernetes", 5);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every(n => n.name.includes("kubernetes") || n.description.includes("k8s") || n.content.includes("kubectl"))).toBe(true);

    // topNodes：先 updatePageranks，再查 top
    const { node: top } = await upsertNode(driver, {
      type: "TASK", name: "Top Ranked Task", description: "high", content: "important",
    }, TEST_SID);
    await updatePageranks(driver, new Map([[top.id, 999]]));
    const topHits = await topNodes(driver, 3);
    expect(topHits.length).toBeGreaterThanOrEqual(1);
    expect(topHits[0].id).toBe(top.id);
    expect(topHits[0].pagerank).toBeGreaterThanOrEqual(999);
  });

  it("searchNodes 空查询降级到 topNodes", async () => {
    const hits = await searchNodes(driver, "   ", 3);
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});
