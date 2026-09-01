/**
 * graph-memory-pro — 图谱维护
 *
 * 调用时机：session_end（finalize 之后）
 * 执行顺序：衰减 → 去重 → 全局 PageRank → 社区检测 → 社区描述 → 消息保留（opt-in）
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { computeGlobalPageRank, type GlobalPageRankResult } from "./pagerank.ts";
import { detectCommunities, summarizeCommunities, type CommunityResult } from "./community.ts";
import { dedup, type DedupResult } from "./dedup.ts";
import { applyDecay, type DecayResult } from "./decay.ts";
import {
  normalizeMessageRetentionPolicy, runMessageRetention,
  type MessageRetentionResult,
} from "../store/retention.ts";

export interface MaintenanceResult {
  decay: DecayResult;
  dedup: DedupResult;
  pagerank: GlobalPageRankResult;
  community: CommunityResult;
  communitySummaries: number;
  /** 原始消息保留（opt-in）；未配置 messageRetention 或 keep=all 时为 undefined，
   *  执行失败时为 { error }（fail-soft，不否定整轮维护）。 */
  retention?: MessageRetentionResult | { error: string };
  durationMs: number;
}

export async function runMaintenance(
  driver: Driver, cfg: GmConfig, llm?: CompleteFn, embedFn?: EmbedFn,
): Promise<MaintenanceResult> {
  const start = Date.now();

  // 0. 衰减（柔性评分 + tier 转换）—— 先于其他步骤，让后续基于最新 tier 集合运算
  const decayResult = await applyDecay(driver, cfg);

  // 1. 去重
  const dedupResult = await dedup(driver, cfg);

  // 2. 全局 PageRank
  const pagerankResult = await computeGlobalPageRank(driver, cfg);

  // 3. 社区检测
  const communityResult = await detectCommunities(driver);

  // 4. 社区描述生成
  let communitySummaries = 0;
  if (llm && communityResult.communities.size > 0) {
    try {
      communitySummaries = await summarizeCommunities(driver, communityResult.communities, llm, embedFn);
    } catch {}
  }

  // 5. 原始消息保留（opt-in；keep=all 零开销直返）。
  // fail-soft：链尾清理失败（非法策略 fail-closed 不删 / Neo4j 故障）不应否定
  // 已完成的 decay/dedup/PageRank/社区步骤 —— 前面步骤成功说明连接健康，
  // 也不计入 Neo4j 熔断。错误记入结果，由调用方记日志，下一周期重试。
  let retention: MessageRetentionResult | { error: string } | undefined;
  if (cfg.messageRetention) {
    try {
      const policy = normalizeMessageRetentionPolicy(cfg.messageRetention);
      if (policy.keep !== "all") {
        retention = await runMessageRetention(driver, policy);
      }
    } catch (err) {
      retention = { error: String(err) };
    }
  }

  return {
    decay: decayResult,
    dedup: dedupResult,
    pagerank: pagerankResult,
    community: communityResult,
    communitySummaries,
    ...(retention ? { retention } : {}),
    durationMs: Date.now() - start,
  };
}
