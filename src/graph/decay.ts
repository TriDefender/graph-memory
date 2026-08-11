/**
 * graph-memory-pro — 柔性衰减（三因子加权评分 + tier 双向转换）
 *
 * 完整公式、字段映射、默认值来源、调参指南见 docs/decay.md。
 * 评分 / tier 决策 / applyDecay 的入口均在本文件。
 *
 * 调用时机：runMaintenance 的第 0 步（去重/PageRank/社区之前）。
 * decay 不动 status，只动 tier。
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig, DecayConfig, GmNode, NodeTier } from "../types.ts";
import { getSession } from "../store/db.ts";
import { allActiveNodes } from "../store/store.ts";

const MS_PER_DAY = 86_400_000;

export interface CompositeScore {
  composite: number;
  recency: number;
  frequency: number;
  intrinsic: number;
}

export interface TierTransition {
  coreToWorking: number;
  workingToPeripheral: number;
  peripheralToWorking: number;
  workingToCore: number;
}

export interface DecayResult {
  enabled: boolean;
  scanned: number;
  tierTransitions: TierTransition;
  durationMs: number;
}

// ─── 归一化辅助（纯函数，便于单元测试） ──────────────────────

/** importance ∈ [0,1]：当前批次的 pagerank 归一化值。 */
export function normalizeImportance(pagerank: number, maxPagerank: number): number {
  if (maxPagerank <= 0) return 0;
  return Math.min(1, Math.max(0, pagerank / maxPagerank));
}

/** confidence ∈ [0,1)：validatedCount 越高越可信，饱和收敛到 1。 */
export function computeConfidence(validatedCount: number): number {
  const c = Math.max(0, validatedCount);
  return 1 - 1 / (1 + c);
}

// ─── 三因子评分（纯函数） ────────────────────────────────────

/** β 随 tier 变化：core 缓衰、peripheral 促衰。 */
export function computeBeta(tier: NodeTier, cfg: DecayConfig): number {
  switch (tier) {
    case "core": return cfg.betaCore;
    case "working": return cfg.betaWorking;
    case "peripheral": return cfg.betaPeripheral;
  }
}

/**
 * Recency 分量：Weibull 拉伸指数衰减。
 * tier 决定 β；importance 调制半衰期（高重要性 → 慢衰减）。
 */
export function scoreRecency(
  node: Pick<GmNode, "lastAccessedAt" | "updatedAt" | "createdAt" | "tier">,
  importance: number,
  now: number,
  cfg: DecayConfig,
): number {
  const lastActive = node.lastAccessedAt > 0
    ? node.lastAccessedAt
    : (node.updatedAt > 0 ? node.updatedAt : node.createdAt);
  const daysSince = Math.max(0, (now - lastActive) / MS_PER_DAY);

  const effectiveHL = cfg.recencyHalfLifeDays * Math.exp(cfg.importanceModulation * importance);
  const lambda = Math.LN2 / effectiveHL;
  const beta = computeBeta(node.tier ?? "working", cfg);

  return Math.exp(-lambda * Math.pow(daysSince, beta));
}

/**
 * Frequency 分量：基础饱和项 × 平均访问间隔新鲜度。
 * validatedCount ≤ 1 时只返回基础项（无法算平均间隔）。
 */
export function scoreFrequency(
  node: Pick<GmNode, "validatedCount" | "lastAccessedAt" | "updatedAt" | "createdAt">,
): number {
  const count = Math.max(0, node.validatedCount);
  const base = 1 - Math.exp(-count / 5);
  if (count <= 1) return base;

  const lastActive = node.lastAccessedAt > 0
    ? node.lastAccessedAt
    : (node.updatedAt > 0 ? node.updatedAt : node.createdAt);
  const accessSpanDays = Math.max(1, (lastActive - node.createdAt) / MS_PER_DAY);
  const avgGapDays = accessSpanDays / Math.max(count - 1, 1);
  const recentnessBonus = Math.exp(-avgGapDays / 30);

  return base * (0.5 + 0.5 * recentnessBonus);
}

/** Intrinsic 分量：importance × confidence。 */
export function scoreIntrinsic(importance: number, confidence: number): number {
  return importance * confidence;
}

/** 三因子加权汇总。权重和在运行时归一化到 1，避免用户配置偏差导致 composite > 1。 */
export function scoreNode(
  node: Pick<GmNode,
    "lastAccessedAt" | "updatedAt" | "createdAt" | "tier"
    | "validatedCount" | "pagerank">,
  maxPagerank: number,
  now: number,
  cfg: DecayConfig,
): CompositeScore {
  const importance = normalizeImportance(node.pagerank, maxPagerank);
  const confidence = computeConfidence(node.validatedCount);
  const recency = scoreRecency(node, importance, now, cfg);
  const frequency = scoreFrequency(node);
  const intrinsic = scoreIntrinsic(importance, confidence);

  const wSum = cfg.recencyWeight + cfg.frequencyWeight + cfg.intrinsicWeight;
  const safeSum = wSum > 0 ? wSum : 1;
  const wR = cfg.recencyWeight / safeSum;
  const wF = cfg.frequencyWeight / safeSum;
  const wI = cfg.intrinsicWeight / safeSum;

  const composite = wR * recency + wF * frequency + wI * intrinsic;

  return { composite, recency, frequency, intrinsic };
}

// ─── Tier 转换决策（纯函数） ─────────────────────────────────

/**
 * 决定节点的下一个 tier。返回 null 表示保持不变。
 * importance 已归一化（调用方须先 normalizeImportance）。
 */
export function decideTierTransition(
  node: Pick<GmNode, "tier" | "validatedCount" | "createdAt">,
  score: CompositeScore,
  importance: number,
  cfg: DecayConfig,
  now: number = Date.now(),
): NodeTier | null {
  const current = node.tier ?? "working";
  const count = node.validatedCount;
  const ageDays = Math.max(0, (now - node.createdAt) / MS_PER_DAY);
  const composite = score.composite;

  if (current === "core"
    && composite < cfg.peripheralCompositeThreshold
    && count < cfg.workingAccessThreshold) {
    return "working";
  }

  if (current === "working") {
    if (composite < cfg.peripheralCompositeThreshold) return "peripheral";
    if (ageDays > cfg.peripheralAgeDays && count < cfg.workingAccessThreshold) {
      return "peripheral";
    }
  }

  if (current === "peripheral"
    && count >= cfg.workingAccessThreshold
    && composite >= cfg.workingCompositeThreshold) {
    return "working";
  }

  if (current === "working"
    && count >= cfg.coreAccessThreshold
    && composite >= cfg.coreCompositeThreshold
    && importance >= cfg.coreImportanceThreshold) {
    return "core";
  }

  return null;
}

// ─── 应用层：扫描 + 评分 + 转换 ──────────────────────────────

const EMPTY_TRANSITIONS: TierTransition = {
  coreToWorking: 0,
  workingToPeripheral: 0,
  peripheralToWorking: 0,
  workingToCore: 0,
};

function bumpTransition(transitions: TierTransition, from: NodeTier, to: NodeTier): void {
  if (from === "core" && to === "working") transitions.coreToWorking++;
  else if (from === "working" && to === "peripheral") transitions.workingToPeripheral++;
  else if (from === "peripheral" && to === "working") transitions.peripheralToWorking++;
  else if (from === "working" && to === "core") transitions.workingToCore++;
}

/**
 * 扫描所有 active 节点：评分 + tier 转换 + 写回 decayScore / tier。
 * 不动 status（status=deprecated 仅由手动弃用触发）。
 */
export async function applyDecay(driver: Driver, cfg: Pick<GmConfig, "decay">): Promise<DecayResult> {
  const start = Date.now();
  const d = cfg.decay;
  if (!d?.enabled) {
    return { enabled: false, scanned: 0, tierTransitions: { ...EMPTY_TRANSITIONS }, durationMs: 0 };
  }

  const nodes = await allActiveNodes(driver);
  if (nodes.length === 0) {
    return { enabled: true, scanned: 0, tierTransitions: { ...EMPTY_TRANSITIONS }, durationMs: 0 };
  }

  const maxPagerank = Math.max(...nodes.map(n => n.pagerank), 0.0001);

  const updates: Array<{ id: string; tier: NodeTier; composite: number; tierChanged: boolean }> = [];
  const transitions: TierTransition = { ...EMPTY_TRANSITIONS };

  for (const node of nodes) {
    const score = scoreNode(node, maxPagerank, start, d);
    const importance = normalizeImportance(node.pagerank, maxPagerank);
    const currentTier = node.tier ?? "working";
    const nextTier = decideTierTransition(node, score, importance, d, start);
    const finalTier = nextTier ?? currentTier;
    const tierChanged = nextTier !== null;

    if (tierChanged) bumpTransition(transitions, currentTier, finalTier);

    updates.push({
      id: node.id,
      tier: finalTier,
      composite: score.composite,
      tierChanged,
    });
  }

  if (updates.length > 0) {
    const session = getSession(driver);
    try {
      await session.run(
        `UNWIND $updates AS u
         MATCH (n:Task|Skill|Event {id: u.id})
         SET n.tier = u.tier,
             n.decayScore = u.composite,
             n.decayComputedAt = $now,
             n.updatedAt = CASE WHEN u.tierChanged THEN $now ELSE n.updatedAt END`,
        { updates, now: start },
      );
    } finally {
      await session.close();
    }
  }

  return {
    enabled: true,
    scanned: nodes.length,
    tierTransitions: transitions,
    durationMs: Date.now() - start,
  };
}
