/**
 * graph-memory-pro v2.1 — 类型定义
 *
 * Label 体系：Task / Skill / Event / Community
 * 去掉 Signal 类型，去掉 GmNode 统一 label
 */

// ─── 节点 ─────────────────────────────────────────────────────

export type NodeType = "TASK" | "SKILL" | "EVENT";
export type NodeStatus = "active" | "deprecated";

/**
 * 记忆分层 tier（与 NodeStatus 正交）。
 * decay 评分模型据此双向转换：core↔working↔peripheral。
 * 节点仍保持 status=active，仅 tier 变化；status=deprecated 只由手动弃用触发。
 */
export type NodeTier = "core" | "working" | "peripheral";

/** Neo4j label 映射：TASK->Task, SKILL->Skill, EVENT->Event */
export const NODE_TYPE_TO_LABEL: Record<NodeType, string> = {
  TASK: "Task",
  SKILL: "Skill",
  EVENT: "Event",
};

export interface GmNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  content: string;
  status: NodeStatus;
  tier: NodeTier;
  validatedCount: number;
  sourceSessions: string[];
  communityId: string | null;
  pagerank: number;
  createdAt: number;
  updatedAt: number;
  /**
   * 最近一次"相关性活动"时间戳（epoch ms），由 upsertNode 在任意写入路径刷新
   * （重新提取、gm_record、gm_update、CRUD POST）。是衰减判定的基准。
   * 与 updatedAt 的区别：updatedAt 在 deprecate/merge 时也会变，不能代表相关性；
   * 而 mergeNodes 故意不更新 lastAccessedAt（合并 ≠ 用户重新激活）。
   */
  lastAccessedAt: number;
  /** 最近一次 decay 评分（0~1，越大越鲜活/重要）。仅 applyDecay 写入。 */
  decayScore?: number;
  /** decayScore 的计算时间戳（epoch ms）。 */
  decayComputedAt?: number;
}

// ─── 边 ───────────────────────────────────────────────────────

export const EDGE_TYPES = [
  "USED_SKILL",
  "SOLVED_BY",
  "REQUIRES",
  "PATCHES",
  "CONFLICTS_WITH",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

const EDGE_DIRECTION_RULES: Record<EdgeType, {
  from: readonly NodeType[];
  to: readonly NodeType[];
}> = {
  USED_SKILL:     { from: ["TASK"], to: ["SKILL"] },
  SOLVED_BY:      { from: ["EVENT", "SKILL"], to: ["SKILL"] },
  REQUIRES:       { from: ["SKILL"], to: ["SKILL"] },
  PATCHES:        { from: ["SKILL"], to: ["SKILL"] },
  CONFLICTS_WITH: { from: ["SKILL"], to: ["SKILL"] },
};

/** 运行时校验关系白名单及端点方向（LLM/HTTP 输入不能依赖 TS 类型）。 */
export function isValidEdgeDirection(
  type: string,
  fromType: string,
  toType: string,
): type is EdgeType {
  const rule = EDGE_DIRECTION_RULES[type as EdgeType];
  return !!rule
    && rule.from.includes(fromType as NodeType)
    && rule.to.includes(toType as NodeType);
}

export interface GmEdge {
  id: string;
  fromId: string;
  toId: string;
  type: EdgeType;
  instruction: string;
  condition?: string;
  sessionId: string;
  createdAt: number;
}

// ─── 提取结果 ─────────────────────────────────────────────────

export interface ExtractionResult {
  nodes: Array<{
    type: NodeType;
    name: string;
    description: string;
    content: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: EdgeType;
    instruction: string;
    condition?: string;
  }>;
}

export interface FinalizeResult {
  promotedSkills: Array<{
    type: "SKILL";
    name: string;
    description: string;
    content: string;
  }>;
  newEdges: Array<{
    from: string;
    to: string;
    type: EdgeType;
    instruction: string;
  }>;
  invalidations: string[];
}

// ─── 召回结果 ─────────────────────────────────────────────────

export interface RecallResult {
  nodes: GmNode[];
  edges: GmEdge[];
  tokenEstimate: number;
}

// ─── Embedding 配置 ──────────────────────────────────────────

export interface EmbeddingConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
}

// ─── Neo4j 连接配置 ──────────────────────────────────────────

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

// ─── 衰减（柔性评分模型）配置 ─────────────────────────────────
//
// 完整公式、字段映射、默认值来源、调参指南见 docs/decay.md。
// 评分和 tier 转换逻辑实现在 src/graph/decay.ts。

export interface DecayConfig {
  enabled: boolean;
  recencyHalfLifeDays: number;
  recencyWeight: number;
  importanceModulation: number;
  frequencyWeight: number;
  intrinsicWeight: number;
  betaCore: number;
  betaWorking: number;
  betaPeripheral: number;
  coreAccessThreshold: number;
  coreCompositeThreshold: number;
  coreImportanceThreshold: number;
  peripheralCompositeThreshold: number;
  peripheralAgeDays: number;
  workingAccessThreshold: number;
  workingCompositeThreshold: number;
}

// ─── 插件配置 ─────────────────────────────────────────────────

export interface GmConfig {
  neo4j: Neo4jConfig;
  compactTurnCount: number;
  recallMaxNodes: number;
  recallMaxDepth: number;
  freshTailCount: number;
  embedding?: EmbeddingConfig;
  llm?: {
    provider?: "openai" | "anthropic" | "oauth";
    apiKey?: string;
    baseURL?: string;
    model?: string;
    timeoutMs?: number;
    maxTokens?: number;
    /** OAuth 会话文件路径（provider="oauth" 时必填）。 */
    oauthPath?: string;
    /** OAuth 提供商标识（默认 "openai-codex"）。 */
    oauthProvider?: string;
    /** 推理模型思考强度（仅 oauth provider 生效；默认 "medium"）。 */
    reasoningEffort?: "low" | "medium" | "high";
  };
  dedupThreshold: number;
  pagerankDamping: number;
  pagerankIterations: number;
  /** 遗忘曲线衰减配置；未提供时使用 DEFAULT_CONFIG.decay。 */
  decay?: DecayConfig;
}

export const DEFAULT_CONFIG: GmConfig = {
  neo4j: {
    uri: "bolt://localhost:7687",
    user: "neo4j",
    password: "neo4j",
  },
  compactTurnCount: 6,
  recallMaxNodes: 6,
  recallMaxDepth: 2,
  freshTailCount: 10,
  dedupThreshold: 0.90,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
  decay: {
    enabled: true,
    recencyHalfLifeDays: 30,
    recencyWeight: 0.4,
    importanceModulation: 1.5,
    frequencyWeight: 0.3,
    intrinsicWeight: 0.3,
    betaCore: 0.8,
    betaWorking: 1.0,
    betaPeripheral: 1.3,
    coreAccessThreshold: 10,
    coreCompositeThreshold: 0.7,
    coreImportanceThreshold: 0.8,
    peripheralCompositeThreshold: 0.15,
    peripheralAgeDays: 60,
    workingAccessThreshold: 3,
    workingCompositeThreshold: 0.4,
  },
};
