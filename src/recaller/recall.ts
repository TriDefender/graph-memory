/**
 * graph-memory-pro — 跨对话召回 (Neo4j 版)
 *
 * 双路径召回：精确路径（向量搜索） + 泛化路径（社区代表节点）
 */

import type { Driver } from "neo4j-driver";
import { createHash } from "crypto";
import type { GmConfig, RecallResult, GmNode, GmEdge } from "../types.ts";
import type { EmbedFn } from "../engine/embed.ts";
import {
  searchNodes, vectorSearchWithScore,
  graphWalk, communityRepresentatives,
  communityVectorSearch, nodesByCommunityIds,
  saveVector, getVectorHash,
} from "../store/store.ts";
import { getCommunityPeers } from "../graph/community.ts";
import { personalizedPageRank } from "../graph/pagerank.ts";

export function buildNodeEmbeddingText(
  node: Pick<GmNode, "name" | "description" | "content">,
): string {
  return `${node.name}: ${node.description}\n${node.content.slice(0, 500)}`;
}

// ─── 时间筛选 ───────────────────────────────────────────────

export type RecallTimeField = "createdAt" | "updatedAt";

export interface RecallOptions {
  /** ISO 8601 字符串；只返回 timeField 对应时刻 >= after 的节点 */
  after?: string;
  /** ISO 8601 字符串；只返回 timeField 对应时刻 <= before 的节点 */
  before?: string;
  /** 筛选字段，默认 createdAt */
  timeField?: RecallTimeField;
}

export interface ParsedTimeRange {
  sinceMs: number;
  untilMs: number;
  field: RecallTimeField;
}

/**
 * 解析时间筛选参数为 epoch 毫秒区间。
 * - 仅 after：[after, +∞)
 * - 仅 before：[0, before]（节点时间均为正 epoch，下界 0 即"无下界"）
 * - 同时传：[after, before]
 * 非法 ISO 字符串、区间反向均抛错。
 */
export function parseTimeRange(opts: RecallOptions): ParsedTimeRange {
  const field = opts.timeField ?? "createdAt";
  const sinceMs = opts.after ? Date.parse(opts.after) : 0;
  const untilMs = opts.before ? Date.parse(opts.before) : Number.MAX_SAFE_INTEGER;
  if (opts.after && Number.isNaN(sinceMs)) {
    throw new Error(`[graph-memory-pro] invalid "after" time: ${opts.after}`);
  }
  if (opts.before && Number.isNaN(untilMs)) {
    throw new Error(`[graph-memory-pro] invalid "before" time: ${opts.before}`);
  }
  if (sinceMs > untilMs) {
    throw new Error(`[graph-memory-pro] "after" must be earlier than "before"`);
  }
  return { sinceMs, untilMs, field };
}

/** 判断节点是否落在时间区间内（闭区间，含两端） */
export function matchTimeRange(
  node: Pick<GmNode, "createdAt" | "updatedAt">,
  range: ParsedTimeRange,
): boolean {
  const t = node[range.field];
  return t >= range.sinceMs && t <= range.untilMs;
}

export class Recaller {
  private embed: EmbedFn | null = null;

  constructor(private driver: Driver, private cfg: GmConfig) {}

  setEmbedFn(fn: EmbedFn): void { this.embed = fn; }

  async recall(query: string, options?: RecallOptions): Promise<RecallResult> {
    const limit = this.cfg.recallMaxNodes;
    const timeRange = options ? parseTimeRange(options) : null;

    const precise = await this.recallPrecise(query, limit, timeRange);
    const generalized = await this.recallGeneralized(query, limit, timeRange);
    const merged = this.mergeResults(precise, generalized);

    return merged;
  }

  /**
   * 精确召回：向量搜索 → 社区扩展 → 图遍历 → PPR 排序
   */
  private async recallPrecise(
    query: string,
    limit: number,
    timeRange: ParsedTimeRange | null,
  ): Promise<RecallResult> {
    let seeds: GmNode[] = [];

    if (this.embed) {
      try {
        const vec = await this.embed(query, "query");
        const scored = await vectorSearchWithScore(this.driver, vec, Math.ceil(limit / 2));
        seeds = scored.map(s => s.node);

        if (seeds.length < 2) {
          const fts = await searchNodes(this.driver, query, limit);
          const seen = new Set(seeds.map(n => n.id));
          seeds.push(...fts.filter(n => !seen.has(n.id)));
        }
      } catch {
        seeds = await searchNodes(this.driver, query, limit);
      }
    } else {
      seeds = await searchNodes(this.driver, query, limit);
    }

    if (!seeds.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    const seedIds = seeds.map(n => n.id);

    // 社区扩展
    const expandedIds = new Set(seedIds);
    for (const seed of seeds) {
      const peers = await getCommunityPeers(this.driver, seed.id, 2);
      for (const peerId of peers) expandedIds.add(peerId);
    }

    // 图遍历
    const { nodes, edges } = await graphWalk(
      this.driver,
      Array.from(expandedIds),
      this.cfg.recallMaxDepth,
    );

    if (!nodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    // PPR 排序
    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = await personalizedPageRank(
      this.driver, seedIds, candidateIds, this.cfg,
    );

    const filtered = nodes
      .filter(n => !timeRange || matchTimeRange(n, timeRange))
      .sort((a, b) =>
        (pprScores.get(b.id) || 0) - (pprScores.get(a.id) || 0) ||
        b.validatedCount - a.validatedCount ||
        b.updatedAt - a.updatedAt
      )
      .slice(0, limit);

    const ids = new Set(filtered.map(n => n.id));
    return {
      nodes: filtered,
      edges: edges.filter(e => ids.has(e.fromId) && ids.has(e.toId)),
      tokenEstimate: this.estimateTokens(filtered),
    };
  }

  /**
   * 泛化召回：社区向量搜索 → 图遍历 → PPR 排序
   */
  private async recallGeneralized(
    query: string,
    limit: number,
    timeRange: ParsedTimeRange | null,
  ): Promise<RecallResult> {
    let seeds: GmNode[] = [];

    if (this.embed) {
      try {
        const vec = await this.embed(query, "query");
        const scoredCommunities = await communityVectorSearch(this.driver, vec);

        if (scoredCommunities.length > 0) {
          const communityIds = scoredCommunities.map(c => c.id);
          seeds = await nodesByCommunityIds(this.driver, communityIds, 3);

        }
      } catch {}
    }

    if (!seeds.length) {
      seeds = await communityRepresentatives(this.driver, 2);
    }

    if (!seeds.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    const seedIds = seeds.map(n => n.id);
    const { nodes, edges } = await graphWalk(this.driver, seedIds, 1);
    if (!nodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = await personalizedPageRank(
      this.driver, seedIds, candidateIds, this.cfg,
    );

    const filtered = nodes
      .filter(n => !timeRange || matchTimeRange(n, timeRange))
      .sort((a, b) =>
        (pprScores.get(b.id) || 0) - (pprScores.get(a.id) || 0) ||
        b.updatedAt - a.updatedAt ||
        b.validatedCount - a.validatedCount
      )
      .slice(0, limit);

    const ids = new Set(filtered.map(n => n.id));
    return {
      nodes: filtered,
      edges: edges.filter(e => ids.has(e.fromId) && ids.has(e.toId)),
      tokenEstimate: this.estimateTokens(filtered),
    };
  }

  private mergeResults(precise: RecallResult, generalized: RecallResult): RecallResult {
    const nodeMap = new Map<string, GmNode>();
    const edgeMap = new Map<string, GmEdge>();

    for (const n of precise.nodes) nodeMap.set(n.id, n);
    for (const e of precise.edges) edgeMap.set(e.id, e);

    for (const n of generalized.nodes) {
      if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
    }

    const finalIds = new Set(nodeMap.keys());
    for (const e of generalized.edges) {
      if (!edgeMap.has(e.id) && finalIds.has(e.fromId) && finalIds.has(e.toId)) {
        edgeMap.set(e.id, e);
      }
    }

    const nodes = Array.from(nodeMap.values());
    const edges = Array.from(edgeMap.values());
    return { nodes, edges, tokenEstimate: this.estimateTokens(nodes) };
  }

  private estimateTokens(nodes: GmNode[]): number {
    return Math.ceil(nodes.reduce((s, n) => s + n.content.length + n.description.length, 0) / 3);
  }

  async syncEmbed(node: GmNode): Promise<void> {
    if (!this.embed) return;
    const text = buildNodeEmbeddingText(node);
    const hash = createHash("md5").update(text).digest("hex");
    const existingHash = await getVectorHash(this.driver, node.id);
    if (existingHash === hash) return;
    try {
      const vec = await this.embed(text, "db");
      if (vec.length) await saveVector(this.driver, node.id, text, vec);
    } catch {}
  }
}
