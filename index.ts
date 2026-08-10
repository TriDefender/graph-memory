/**
 * graph-memory-pro — Neo4j 版知识图谱记忆引擎
 *
 * 基于 graph-memory v1.2.1 改造
 * 存储：Neo4j 5.24.2 + GDS 2.12.0
 * 可视化：Neovis 3D（ClawX 内嵌）
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { getDriver, initSchema, getSession } from "./src/store/db.ts";
import {
  saveMessage, getUnextracted,
  markExtracted, isTurnExtracted,
  upsertNode, upsertEdge, findByName, updateNode,
  deleteNode, deprecateNodeAndDisconnect,
  getBySession, edgesFrom, edgesTo,
  deleteEdges, mergeNodes,
  deprecate, getStats,
} from "./src/store/store.ts";
import { createCompleteFn, resolveProvider } from "./src/engine/llm.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { Recaller, parseTimeRange } from "./src/recaller/recall.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { assembleContext } from "./src/format/assemble.ts";
import { sanitizeToolUseResultPairing } from "./src/format/transcript-repair.ts";
import { runMaintenance } from "./src/graph/maintenance.ts";
import { DEFAULT_CONFIG, type GmConfig, type RecallResult, type EdgeType } from "./src/types.ts";
import { registerCrudRoutes } from "./src/routes/crud.ts";
import { createGraphMemoryCli } from "./src/cli.ts";

/**
 * OpenClaw < 2026.7 does not expose registrationMode and loads the full plugin
 * while discovering plugin CLI commands. Avoid starting the Neo4j runtime for
 * an invocation that only needs the graph-memory CLI registrar.
 */
export function isGraphMemoryCliInvocation(argv: readonly string[] = process.argv): boolean {
  return argv.slice(2).includes("graph-memory");
}

// ─── 从 OpenClaw config 读默认 model 名 ──────────────────────

/**
 * 从 openclaw.json agents.defaults.model 读取默认 model 名。
 * 支持两种形式：字符串 或 { primary: "..." }。
 * 形如 "anthropic/claude-sonnet-4-5" 的 provider 前缀会被剥离 —— provider 路由
 * 由 cfg.llm.provider 显式声明，不再由此函数隐式推断（修 #48 根因）。
 */
export function readDefaultModel(apiConfig: unknown): string {
  if (!apiConfig || typeof apiConfig !== "object") return "";
  const m = (apiConfig as any).agents?.defaults?.model;
  let raw = "";
  if (typeof m === "string") {
    raw = m.trim();
  } else if (m && typeof m === "object" && typeof m.primary === "string") {
    raw = m.primary.trim();
  }
  if (!raw) return "";
  // 剥离 provider 前缀："anthropic/claude-x" → "claude-x"；多段 / 保留剩余部分
  if (raw.includes("/")) {
    const [, ...rest] = raw.split("/");
    return rest.join("/").trim();
  }
  return raw;
}

function throwNodeNotFound(name: string): never {
  throw new Error(
    `[graph-memory-pro] 未找到名称为 "${name}" 的节点。` +
    `请检查节点名称是否精确（名称标准化规则：全小写、空格/下划线转连字符、移除非字母数字字符），` +
    `或使用 gm_search 搜索已有节点。`,
  );
}

// ─── 清洗 OpenClaw metadata 包装 ─────────────────────────────

export function cleanPrompt(raw: string): string {
  let prompt = raw.trim();
  if (prompt.includes("Sender (untrusted metadata)")) {
    const jsonStart = prompt.indexOf("```json");
    if (jsonStart >= 0) {
      const jsonEnd = prompt.indexOf("```", jsonStart + 7);
      if (jsonEnd >= 0) prompt = prompt.slice(jsonEnd + 3).trim();
    }
    if (prompt.includes("Sender (untrusted metadata)")) {
      const lines = prompt.split("\n").filter(l => l.trim() && !l.includes("Sender") && !l.startsWith("```") && !l.startsWith("{"));
      prompt = lines.join("\n").trim();
    }
  }
  prompt = prompt.replace(/^\/\w+\s+/, "").trim();
  prompt = prompt.replace(/^\[[\w\s\-:]+\]\s*/, "").trim();
  return prompt;
}

// ─── 规范化消息 content，防 OpenClaw content.filter() 崩溃 ────

export function normalizeMessageContent(messages: any[]): any[] {
  return messages.map((msg: any) => {
    if (!msg || typeof msg !== "object") return msg;
    const c = msg.content;
    // 数组 → 修复畸形 block（如 { type: "text" } 缺 text 属性）
    if (Array.isArray(c)) {
      const fixed = c.map((block: any) => {
        if (block && typeof block === "object" && block.type === "text" && !("text" in block)) {
          return { ...block, text: "" };
        }
        return block;
      });
      if (fixed !== c) return { ...msg, content: fixed };
      return msg;
    }
    // string → 包装成标准 content block 数组
    if (typeof c === "string") {
      return { ...msg, content: [{ type: "text", text: c }] };
    }
    // undefined/null → 空 text block
    if (c == null) {
      return { ...msg, content: [{ type: "text", text: "" }] };
    }
    return msg;
  });
}

/** Return only the completed-turn messages not already delivered by ingest(). */
export function missingIngestMessages(messages: any[], ingestedCount: number): any[] {
  const delivered = Math.max(0, Math.min(messages.length, ingestedCount));
  return messages.slice(delivered);
}

// ─── assemble 消息裁剪：保留最近 N 轮，旧轮只留文本 ──────────

const KEEP_TURNS = 5;

function estimateMsgTokens(msg: any): number {
  const text = typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content ?? "");
  return Math.ceil(text.length / 3);
}

export function extractAssistantText(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
}

export function extractUserText(msg: any): string {
  let raw: string;
  if (typeof msg.content === "string") {
    raw = msg.content;
  } else if (!Array.isArray(msg.content)) {
    raw = String(msg.content ?? "");
  } else {
    raw = msg.content
      .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
  }
  // 去掉 OpenClaw metadata（Sender JSON block、命令前缀、时间戳）
  const fenceEnd = raw.lastIndexOf("```");
  if (fenceEnd >= 0 && raw.includes("Sender")) {
    raw = raw.slice(fenceEnd + 3).trim();
  }
  raw = raw.replace(/^\/\w+\s+/, "").trim();
  raw = raw.replace(/^\[[\w\s\-:]+\]\s*/, "").trim();
  return raw;
}

export function sliceLastTurn(
  messages: any[],
): { messages: any[]; tokens: number; dropped: number } {
  if (!messages.length) {
    return { messages: [], tokens: 0, dropped: 0 };
  }

  // 找到最近 N 个 user 消息的位置
  const userIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userIndices.push(i);
      if (userIndices.length >= KEEP_TURNS) break;
    }
  }
  if (!userIndices.length) {
    return { messages: [], tokens: 0, dropped: messages.length };
  }

  const lastTurnUserIdx = userIndices[0];

  // 最后 1 轮：完整保留（含 toolResult，Agent 需要最新执行结果），但截断超长 tool_result
  let lastTurnMsgs = messages.slice(lastTurnUserIdx);
  const TOOL_MAX = 6000;
  lastTurnMsgs = lastTurnMsgs.map((msg: any) => {
    if (msg.role !== "tool" && msg.role !== "toolResult") return msg;
    if (typeof msg.content !== "string") return msg;
    if (msg.content.length <= TOOL_MAX) return msg;
    const head = Math.floor(TOOL_MAX * 0.6);
    const tail = Math.floor(TOOL_MAX * 0.3);
    return { ...msg, content: msg.content.slice(0, head) + `\n...[truncated ${msg.content.length - head - tail} chars]...\n` + msg.content.slice(-tail) };
  });

  // 前 N-1 轮：只保留 user 输入 + assistant 文本（去掉 tool schema）
  const prevTurnMsgs: any[] = [];
  if (userIndices.length > 1) {
    const earliestIdx = userIndices[userIndices.length - 1];
    for (let i = earliestIdx; i < lastTurnUserIdx; i++) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role === "user") {
        const text = extractUserText(msg);
        if (text) prevTurnMsgs.push({ role: "user", content: text });
      } else if (msg.role === "assistant") {
        const text = extractAssistantText(msg);
        if (text) prevTurnMsgs.push({ role: "assistant", content: text });
      }
    }
  }

  // 合并：前 N-1 轮摘要 + 最后 1 轮完整
  const kept = [...prevTurnMsgs, ...lastTurnMsgs];
  const dropped = messages.length - kept.length;
  let tokens = 0;
  for (const msg of kept) tokens += estimateMsgTokens(msg);
  return { messages: kept, tokens, dropped };
}

/** 图谱为空时也必须执行相同的裁剪、工具配对修复和 content 规范化。 */
export function prepareAssemblyMessages(
  messages: any[],
): { messages: any[]; tokens: number; dropped: number } {
  const sliced = sliceLastTurn(messages);
  return {
    messages: normalizeMessageContent(sanitizeToolUseResultPairing(sliced.messages)),
    tokens: sliced.tokens,
    dropped: sliced.dropped,
  };
}

// ─── 插件对象 ─────────────────────────────────────────────────

const graphMemoryProPlugin = {
  id: "graph-memory-pro",
  name: "Graph Memory Pro",
  description:
    "Neo4j 知识图谱记忆引擎：三元组存储 + GDS 图算法 + 向量索引 + Neovis 3D 可视化",

  register(api: OpenClawPluginApi) {
    // ── 读配置 ──────────────────────────────────────────────
    const raw =
      api.pluginConfig && typeof api.pluginConfig === "object"
        ? (api.pluginConfig as any)
        : {};

    // Register CLI metadata before any database, schema, or embedding work.
    // New OpenClaw versions load plugins in cli-metadata mode; older supported
    // versions are covered by the argv fallback above.
    if (typeof api.registerCli === "function") {
      api.registerCli(
        createGraphMemoryCli({
          pluginId: "graph-memory-pro",
          pluginConfig: raw as Record<string, unknown> | undefined,
          resolveConfigPath: (p: string) => api.resolvePath?.(p) ?? p,
        }),
        { commands: ["graph-memory"] },
      );
    }
    if (
      api.registrationMode === "cli-metadata" ||
      isGraphMemoryCliInvocation()
    ) {
      return;
    }

    const cfg: GmConfig = { ...DEFAULT_CONFIG, ...raw };
    if (raw.neo4j) cfg.neo4j = { ...DEFAULT_CONFIG.neo4j, ...raw.neo4j };

    const providerModel = readDefaultModel(api.config);

    // Model 解析链：cfg.llm.model（插件级显式配置） → agents.defaults.model（openclaw provider 级）
    // 留空也能工作 —— 但 extraction / community summaries 会因无 model 而失败，故仅告警。
    const effectiveModel = cfg.llm?.model ?? providerModel;
    if (!effectiveModel) {
      api.logger.warn(
        "[graph-memory-pro] No LLM model configured. Set agents.defaults.model in openclaw.json " +
        "or config.llm.model in graph-memory plugin config — extraction and community summaries will fail.",
      );
    }

    // Provider 解析（显式 > 启发式推断）。推断时告警，建议显式设置 —— 修 issue #48：
    // 旧版日志里打的 provider 来自 agents.defaults.model 解析，跟实际路由（基于 !baseURL）脱节。
    const { provider: llmProvider, inferred: providerInferred } = resolveProvider(cfg.llm);
    if (providerInferred) {
      api.logger.warn(
        `[graph-memory-pro] llm.provider 未显式设置，按 baseURL 是否存在推断为 "${llmProvider}"。` +
        `建议在 config.llm 中显式设置 provider: "openai" | "anthropic" 以避免歧义。`,
      );
    }
    // 按真实路由校验必需字段，缺了清晰报错（而不是静默 fallthrough 后失败）
    if (llmProvider === "anthropic" && !cfg.llm?.apiKey) {
      api.logger.error(
        '[graph-memory-pro] llm.provider=anthropic 但未配 llm.apiKey — extraction/community summaries 将失败',
      );
    } else if (llmProvider === "openai" && (!cfg.llm?.apiKey || !cfg.llm?.baseURL)) {
      api.logger.error(
        '[graph-memory-pro] llm.provider=openai 需要 llm.apiKey + llm.baseURL — extraction/community summaries 将失败',
      );
    } else if (llmProvider === "oauth") {
      if (!cfg.llm?.oauthPath) {
        api.logger.error(
          '[graph-memory-pro] llm.provider=oauth 但未配 llm.oauthPath — LLM 调用将失败。' +
          '请先用 `openclaw graph-memory auth login` 生成 OAuth 会话文件，然后在 config.llm.oauthPath 中指定路径',
        );
      } else {
        api.logger.info(
          `[graph-memory-pro] llm.provider=oauth 已启用，会话文件: ${cfg.llm.oauthPath}`,
        );
      }
    }

    // ── 初始化 Neo4j ────────────────────────────────────────
    const driver = getDriver(cfg.neo4j);

    // Schema 初始化（异步，不阻塞启动）
    initSchema(driver, cfg.embedding)
      .then(() => api.logger.info("[graph-memory-pro] Neo4j schema initialized"))
      .catch(err => api.logger.error(`[graph-memory-pro] schema init failed: ${err}`));

    const llm = createCompleteFn(effectiveModel, cfg.llm);
    const recaller = new Recaller(driver, cfg);
    const extractor = new Extractor(llm);

    // ── 初始化 embedding ────────────────────────────────────
    createEmbedFn(cfg.embedding)
      .then((fn) => {
        if (fn) {
          recaller.setEmbedFn(fn);
          api.logger.info("[graph-memory-pro] vector search ready");
        } else {
          api.logger.info("[graph-memory-pro] text search mode (配置 embedding 可启用语义搜索)");
        }
      })
      .catch(() => {
        api.logger.info("[graph-memory-pro] text search mode");
      });

    /**
     * 每轮结束后直接从原始消息提取知识图谱
     * 一轮 = 用户发一条消息 → agent 不管调了多少工具 → 最终回复用户
     */
    async function extractTurnKnowledge(sessionId: string, turnNum: number, rawMessages: any[]): Promise<void> {
      try {
        if (await isTurnExtracted(driver, sessionId, turnNum)) {
          api.logger.info(`[graph-memory-pro] turn ${turnNum}: already extracted (compact), skipping`);
          return;
        }
        const existing = (await getBySession(driver, sessionId)).map(n => n.name);
        const result = await extractor.extract({
          messages: rawMessages,
          existingNames: existing,
        });

        if (!result.nodes.length && !result.edges.length) {
          await markExtracted(driver, sessionId, turnNum);
          api.logger.info(`[graph-memory-pro] turn ${turnNum}: no knowledge extracted (marked extracted)`);
          return;
        }

        const nameToId = new Map<string, string>();
        for (const nc of result.nodes) {
          const { node } = await upsertNode(driver, {
            type: nc.type, name: nc.name,
            description: nc.description, content: nc.content,
          }, sessionId);
          nameToId.set(node.name, node.id);
          recaller.syncEmbed(node).catch(() => {});
        }

        for (const ec of result.edges) {
          const fromNode = await findByName(driver, ec.from);
          const toNode = await findByName(driver, ec.to);
          const fromId = nameToId.get(ec.from) ?? fromNode?.id;
          const toId = nameToId.get(ec.to) ?? toNode?.id;
          if (fromId && toId) {
            await upsertEdge(driver, {
              fromId, toId, type: ec.type,
              instruction: ec.instruction, condition: ec.condition, sessionId,
            });
          }
        }

        // 标记该轮消息已提取
        await markExtracted(driver, sessionId, turnNum);

        api.logger.info(`[graph-memory-pro] turn ${turnNum}: extracted ${result.nodes.length} nodes, ${result.edges.length} edges`);
      } catch (err) {
        api.logger.error(`[graph-memory-pro] turn ${turnNum} extract failed: ${err}`);
      }
    }

    // ── Session 运行时状态 ──────────────────────────────────
    const msgSeq = new Map<string, number>();
    const recalled = new Map<string, RecallResult>();
    const sessionIdsByKey = new Map<string, string>();
    const pendingSubagentRecall = new Map<string, RecallResult>();
    const ingestedSinceTurn = new Map<string, number>();

    function bindSessionIdentity(sessionId: string, sessionKey?: string): void {
      if (!sessionKey) return;
      sessionIdsByKey.set(sessionKey, sessionId);
      const pendingRecall = pendingSubagentRecall.get(sessionKey);
      if (pendingRecall) {
        recalled.set(sessionId, pendingRecall);
        pendingSubagentRecall.delete(sessionKey);
      }
    }

    async function ingestMessage(sessionId: string, message: any): Promise<void> {
      const seq = (msgSeq.get(sessionId) ?? 0) + 1;
      msgSeq.set(sessionId, seq);
      await saveMessage(driver, sessionId, seq, message.role ?? "unknown", message);
    }

    // ── before_agent_start：召回 ────────────────────────────

    api.on("before_agent_start", async (event: any, ctx: any) => {
      try {
        const rawPrompt = typeof event?.prompt === "string" ? event.prompt : "";
        const prompt = cleanPrompt(rawPrompt);
        if (!prompt) return;
        if (prompt.includes("/new or /reset") || prompt.includes("new session was started")) return;

        api.logger.info(`[graph-memory-pro] recall query: "${prompt.slice(0, 80)}"`);

        const res = await recaller.recall(prompt);
        if (res.nodes.length) {
          const sessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId : undefined;
          const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined;
          if (sessionId) {
            bindSessionIdentity(sessionId, sessionKey);
            recalled.set(sessionId, res);
          }
          api.logger.info(`[graph-memory-pro] recalled ${res.nodes.length} nodes, ${res.edges.length} edges`);
        }
      } catch (err) {
        api.logger.warn(`[graph-memory-pro] recall failed: ${err}`);
      }
    });

    // ── ContextEngine ────────────────────────────────────────

    const engine = {
      info: {
        id: "graph-memory-pro",
        name: "Graph Memory Pro",
        ownsCompaction: true,
      },

      async bootstrap({ sessionId, sessionKey }: { sessionId: string; sessionKey?: string }) {
        bindSessionIdentity(sessionId, sessionKey);
        return { bootstrapped: true };
      },

      async ingest({ sessionId, sessionKey, message, isHeartbeat }: { sessionId: string; sessionKey?: string; message: any; isHeartbeat?: boolean }) {
        if (isHeartbeat) return { ingested: false };
        bindSessionIdentity(sessionId, sessionKey);
        await ingestMessage(sessionId, message);
        ingestedSinceTurn.set(sessionId, (ingestedSinceTurn.get(sessionId) ?? 0) + 1);
        return { ingested: true };
      },

      async assemble({ sessionId, sessionKey, messages, tokenBudget, prompt }: {
        sessionId: string; sessionKey?: string; messages: any[]; tokenBudget?: number; prompt?: string;
      }) {
        bindSessionIdentity(sessionId, sessionKey);
        const budget = tokenBudget ?? 128_000;

        const activeNodes = await getBySession(driver, sessionId);
        const activeEdges: any[] = [];
        for (const n of activeNodes) {
          activeEdges.push(...await edgesFrom(driver, n.id));
          activeEdges.push(...await edgesTo(driver, n.id));
        }

        // prompt-aware recall：优先用当前 prompt 做新鲜召回，回退到 before_agent_start 缓存
        let rec = recalled.get(sessionId) ?? { nodes: [], edges: [] };
        if (prompt) {
          const cleaned = cleanPrompt(prompt);
          if (cleaned) {
            try {
              const freshRec = await recaller.recall(cleaned);
              if (freshRec.nodes.length) {
                rec = freshRec;
                recalled.set(sessionId, freshRec);
              }
            } catch (err) {
              api.logger.warn(`[graph-memory-pro] assemble recall failed: ${err}`);
            }
          }
        }
        const totalGmNodes = activeNodes.length + rec.nodes.length;
        const prepared = prepareAssemblyMessages(messages);

        if (totalGmNodes === 0) {
          if (prepared.dropped > 0) {
            api.logger.info(
              `[graph-memory-pro] assemble: ${prepared.messages.length} msgs (~${prepared.tokens} tok), ` +
              `dropped ${prepared.dropped} older msgs, graph ~0 tok`,
            );
          }
          return {
            messages: prepared.messages,
            estimatedTokens: prepared.tokens,
          };
        }

        const { xml, systemPrompt, tokens: gmTokens } = await assembleContext(driver, {
          tokenBudget: budget,
          activeNodes,
          activeEdges,
          recalledNodes: rec.nodes,
          recalledEdges: rec.edges,
        });

        if (prepared.dropped > 0) {
          api.logger.info(
            `[graph-memory-pro] assemble: ${prepared.messages.length} msgs (~${prepared.tokens} tok), ` +
            `dropped ${prepared.dropped} older msgs, graph ~${gmTokens} tok`,
          );
        }

        let systemPromptAddition: string | undefined;
        if (xml) {
          systemPromptAddition = systemPrompt ? `${systemPrompt}\n\n${xml}` : xml;
        }

        return {
          messages: prepared.messages,
          estimatedTokens: gmTokens + prepared.tokens,
          ...(systemPromptAddition ? { systemPromptAddition } : {}),
        };
      },

      async compact({ sessionId, sessionKey, currentTokenCount }: { sessionId: string; sessionKey?: string; sessionFile: string; tokenBudget?: number; force?: boolean; currentTokenCount?: number }) {
        bindSessionIdentity(sessionId, sessionKey);
        const msgs = await getUnextracted(driver, sessionId, cfg.compactTurnCount * 3);

        if (!msgs.length) return { ok: true, compacted: false, reason: "no messages" };

        try {
          const existing = (await getBySession(driver, sessionId)).map(n => n.name);
          const result = await extractor.extract({ messages: msgs, existingNames: existing });

          const nameToId = new Map<string, string>();
          for (const nc of result.nodes) {
            const { node } = await upsertNode(driver, {
              type: nc.type, name: nc.name,
              description: nc.description, content: nc.content,
            }, sessionId);
            nameToId.set(node.name, node.id);
            recaller.syncEmbed(node).catch(() => {});
          }

          for (const ec of result.edges) {
            const fromNode = await findByName(driver, ec.from);
            const toNode = await findByName(driver, ec.to);
            const fromId = nameToId.get(ec.from) ?? fromNode?.id;
            const toId = nameToId.get(ec.to) ?? toNode?.id;
            if (fromId && toId) {
              await upsertEdge(driver, {
                fromId, toId, type: ec.type,
                instruction: ec.instruction, condition: ec.condition, sessionId,
              });
            }
          }

          const maxTurn = Math.max(...msgs.map((m: any) => m.turn_index));
          await markExtracted(driver, sessionId, maxTurn);

          return {
            ok: true, compacted: true,
            result: {
              summary: `extracted ${result.nodes.length} nodes, ${result.edges.length} edges`,
              tokensBefore: currentTokenCount ?? 0,
            },
          };
        } catch (err) {
          api.logger.error(`[graph-memory-pro] compact failed: ${err}`);
          return { ok: false, compacted: false, reason: String(err) };
        }
      },

      async afterTurn({ sessionId, sessionKey, messages, prePromptMessageCount, isHeartbeat }: {
        sessionId: string; sessionKey?: string; sessionFile: string; messages: any[];
        prePromptMessageCount: number; autoCompactionSummary?: string;
        isHeartbeat?: boolean; tokenBudget?: number;
      }) {
        if (isHeartbeat) return;
        bindSessionIdentity(sessionId, sessionKey);

        const newMessages = messages.slice(prePromptMessageCount ?? 0);
        if (!newMessages.length) {
          ingestedSinceTurn.delete(sessionId);
          return;
        }

        // Official OpenClaw delivers ingest() and afterTurn() as separate
        // lifecycle phases. Older downstream builds incorrectly call only
        // afterTurn(). Persist just the missing suffix so neither host loses
        // messages and modern hosts do not create duplicate GmMessage rows.
        const ingestedCount = ingestedSinceTurn.get(sessionId) ?? 0;
        const missingMessages = missingIngestMessages(newMessages, ingestedCount);
        for (const message of missingMessages) {
          await ingestMessage(sessionId, message);
        }
        if (missingMessages.length > 0) {
          api.logger.warn(
            `[graph-memory-pro] afterTurn backfilled ${missingMessages.length} message(s) missing from ingest lifecycle`,
          );
        }
        ingestedSinceTurn.delete(sessionId);

        const turnNum = msgSeq.get(sessionId) ?? 0;

        api.logger.info(`[graph-memory-pro] afterTurn sid=${sessionId.slice(0, 8)} turn=${turnNum} rawMsgs=${newMessages.length}`);

        // 直接用原始消息提取知识图谱（异步，不阻塞）
        extractTurnKnowledge(sessionId, turnNum, newMessages).catch(err => {
          api.logger.error(`[graph-memory-pro] extract failed: ${err}`);
        });
      },

      async prepareSubagentSpawn({ parentSessionKey, childSessionKey, parentSessionId }: {
        parentSessionKey: string; childSessionKey: string; parentSessionId?: string;
      }) {
        const canonicalParentId = parentSessionId ?? sessionIdsByKey.get(parentSessionKey);
        const rec = canonicalParentId ? recalled.get(canonicalParentId) : undefined;
        if (rec) pendingSubagentRecall.set(childSessionKey, rec);
        return { rollback: () => { pendingSubagentRecall.delete(childSessionKey); } };
      },

      async onSubagentEnded({ childSessionKey }: { childSessionKey: string }) {
        const childSessionId = sessionIdsByKey.get(childSessionKey);
        if (childSessionId) {
          recalled.delete(childSessionId);
          msgSeq.delete(childSessionId);
          ingestedSinceTurn.delete(childSessionId);
        }
        sessionIdsByKey.delete(childSessionKey);
        pendingSubagentRecall.delete(childSessionKey);
      },

      async dispose() {
        msgSeq.clear();
        recalled.clear();
        sessionIdsByKey.clear();
        pendingSubagentRecall.clear();
        ingestedSinceTurn.clear();
        // 不关闭 Neo4j driver — 连接池自管理生命周期，进程退出时由 OS 回收
      },
    };

    api.registerContextEngine("graph-memory-pro", () => engine);

    // ── session_end：finalize + 图维护 ──────────────────────

    api.on("session_end", async (event: any, ctx: any) => {
      const sid = typeof event?.sessionId === "string"
        ? event.sessionId
        : typeof ctx?.sessionId === "string" ? ctx.sessionId : undefined;
      if (!sid) return;
      const sessionKey = typeof event?.sessionKey === "string"
        ? event.sessionKey
        : typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined;

      try {
        const nodes = await getBySession(driver, sid);
        if (nodes.length) {
          // 获取图谱摘要
          const session = getSession(driver);
          let summary = "";
          try {
            const summaryResult = await session.run(`
              MATCH (n:Task|Skill|Event {status: 'active'})
              RETURN n.name AS name, n.type AS type, n.validatedCount AS vc, n.pagerank AS pr
              ORDER BY n.pagerank DESC LIMIT 20
            `);
            summary = summaryResult.records
              .map(r => `${r.get("type")}:${r.get("name")}(v${r.get("vc")},pr${(r.get("pr") ?? 0).toFixed?.(3) ?? "0"})`)
              .join(", ");
          } finally {
            await session.close();
          }

          const fin = await extractor.finalize({ sessionNodes: nodes, graphSummary: summary });

          for (const nc of fin.promotedSkills) {
            if (nc.name && nc.content) {
              await upsertNode(driver, {
                type: "SKILL", name: nc.name,
                description: nc.description ?? "", content: nc.content,
              }, sid);
            }
          }
          for (const ec of fin.newEdges) {
            const fromNode = await findByName(driver, ec.from);
            const toNode = await findByName(driver, ec.to);
            if (fromNode && toNode) {
              await upsertEdge(driver, {
                fromId: fromNode.id, toId: toNode.id, type: ec.type,
                instruction: ec.instruction, sessionId: sid,
              });
            }
          }
          for (const id of fin.invalidations) await deprecate(driver, id);
        }

        // 图维护
        const embedFn = (recaller as any).embed ?? undefined;
        const result = await runMaintenance(driver, cfg, llm, embedFn);
        api.logger.info(
          `[graph-memory-pro] maintenance: ${result.durationMs}ms, ` +
          `dedup=${result.dedup.merged}, communities=${result.community.count}, ` +
          `summaries=${result.communitySummaries}, ` +
          `top_pr=${result.pagerank.topK.slice(0, 3).map(n => `${n.name}(${n.score.toFixed(3)})`).join(",")}`,
        );
      } catch (err) {
        api.logger.error(`[graph-memory-pro] session_end error: ${err}`);
      } finally {
        msgSeq.delete(sid);
        recalled.delete(sid);
        ingestedSinceTurn.delete(sid);
        if (sessionKey && sessionIdsByKey.get(sessionKey) === sid) {
          sessionIdsByKey.delete(sessionKey);
          pendingSubagentRecall.delete(sessionKey);
        }
      }
    });

    // ── Agent Tools ─────────────────────────────────────────

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_search",
        label: "Search Graph Memory",
        description: "搜索知识图谱中的相关经验、技能和解决方案。支持按时间筛选：after（晚于某时间点）/before（早于某时间点）/两者同传（区间），timeField 选择 createdAt(默认) 或 updatedAt。",
        parameters: Type.Object({
          query: Type.String({ description: "搜索关键词或问题描述" }),
          after: Type.Optional(Type.String({
            description: "可选。ISO 8601 时间点（如 '2024-01-01' 或 '2024-01-01T00:00:00Z'），只返回 timeField >= 此刻的节点。晚于该时间。",
          })),
          before: Type.Optional(Type.String({
            description: "可选。ISO 8601 时间点，只返回 timeField <= 此刻的节点。早于该时间。与 after 同传即区间筛选。",
          })),
          timeField: Type.Optional(Type.Union([
            Type.Literal("createdAt"),
            Type.Literal("updatedAt"),
          ], { description: "按哪个时间字段筛选，默认 createdAt" })),
        }),
        async execute(_toolCallId: string, params: {
          query: string;
          after?: string;
          before?: string;
          timeField?: "createdAt" | "updatedAt";
        }) {
          let res;
          const hasTimeFilter = !!(params.after || params.before);
          if (hasTimeFilter) {
            try {
              parseTimeRange({
                after: params.after,
                before: params.before,
                timeField: params.timeField,
              });
            } catch (e: any) {
              return {
                content: [{ type: "text", text: `时间筛选参数错误：${e?.message ?? e}` }],
                details: { count: 0, query: params.query, error: true },
              };
            }
          }
          try {
            res = await recaller.recall(params.query, {
              after: params.after,
              before: params.before,
              timeField: params.timeField,
            });
          } catch (e: any) {
            return {
              content: [{ type: "text", text: `召回失败：${e?.message ?? e}` }],
              details: { count: 0, query: params.query, error: true },
            };
          }
          if (!res.nodes.length) {
            return { content: [{ type: "text", text: "图谱中未找到相关记录。" }], details: { count: 0, query: params.query } };
          }
          const lines = res.nodes.map(n => `[${n.type}] ${n.name} (pr:${n.pagerank.toFixed(3)})\n${n.description}\n${n.content.slice(0, 400)}`);
          const edgeLines = res.edges.map(e => {
            const from = res.nodes.find(n => n.id === e.fromId)?.name ?? e.fromId;
            const to = res.nodes.find(n => n.id === e.toId)?.name ?? e.toId;
            return `  ${from} --[${e.type}]--> ${to}: ${e.instruction}`;
          });
          const text = [`找到 ${res.nodes.length} 个节点：\n`, ...lines, ...(edgeLines.length ? ["\n关系：", ...edgeLines] : [])].join("\n\n");
          return { content: [{ type: "text", text }], details: { count: res.nodes.length, query: params.query } };
        },
      }),
      { name: "gm_search" },
    );

    api.registerTool(
      (ctx: any) => ({
        name: "gm_record",
        label: "Record to Graph Memory",
        description: "手动记录经验到知识图谱。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称" }),
          type: Type.String({ description: "TASK、SKILL 或 EVENT" }),
          description: Type.String({ description: "一句话说明" }),
          content: Type.String({ description: "纯文本知识内容" }),
          relatedSkill: Type.Optional(Type.String({ description: "关联的已有技能名" })),
        }),
        async execute(_toolCallId: string, p: any) {
          const sid = ctx?.sessionKey ?? ctx?.sessionId ?? "manual";
          if (!["TASK", "SKILL", "EVENT"].includes(p.type)) {
            throw new Error(`[graph-memory-pro] 无效节点类型：${String(p.type)}`);
          }
          const { node } = await upsertNode(driver, { type: p.type, name: p.name, description: p.description, content: p.content }, sid);
          if (p.relatedSkill) {
            const rel = await findByName(driver, p.relatedSkill);
            if (rel?.type === "SKILL") {
              const edgeType = node.type === "TASK" ? "USED_SKILL" : "SOLVED_BY";
              await upsertEdge(driver, { fromId: node.id, toId: rel.id, type: edgeType, instruction: `关联 ${p.relatedSkill}`, sessionId: sid });
            }
          }
          recaller.syncEmbed(node).catch(() => {});
          return { content: [{ type: "text", text: `✅ 已记录：${node.name} (${node.type})` }], details: { name: node.name, type: node.type } };
        },
      }),
      { name: "gm_record" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_update",
        label: "Update Graph Memory Node",
        description:
          "更新知识图谱中已存在的节点。必须提供精确的节点名称（不存在会报错）。" +
          "三种模式：(1) 默认 update —— refine description/content；" +
          "(2) delete —— 硬删除节点及其所有关系；" +
          "(3) deprecate —— 标记 [DEPRECATED] 并切断所有关系（节点本身保留但被隔离）。",
        parameters: Type.Object({
          name: Type.String({ description: "目标节点名称（必须精确匹配已有节点；名称会被标准化：全小写、空格/下划线转连字符）" }),
          mode: Type.Optional(Type.Union([
            Type.Literal("update"),
            Type.Literal("delete"),
            Type.Literal("deprecate"),
          ], { description: "操作模式：update（默认，更新 description/content）、delete（硬删除节点+所有关系）、deprecate（标记 [DEPRECATED] 并删除所有关系，节点保留）" })),
          description: Type.Optional(
            Type.String({ description: "新的一句话说明（one-line summary）。仅 update 模式生效，不传则保留原值" }),
          ),
          content: Type.Optional(
            Type.String({ description: "新的知识内容（纯文本）。仅 update 模式生效，不传则保留原值" }),
          ),
        }),
        async execute(
          _toolCallId: string,
          p: {
            name: string;
            mode?: "update" | "delete" | "deprecate";
            description?: string;
            content?: string;
          },
        ) {
          const mode = p.mode ?? "update";
          const notFoundHint =
            `[graph-memory-pro] 未找到名称为 "${p.name}" 的节点。` +
            `请检查节点名称是否精确（名称标准化规则：全小写、空格/下划线转连字符、移除非字母数字字符），` +
            `或使用 gm_record 创建新节点，也可用 gm_search 搜索已有节点。`;

          if (mode === "delete") {
            const deleted = await deleteNode(driver, p.name);
            if (!deleted) throw new Error(notFoundHint);
            return {
              content: [{
                type: "text",
                text: `已删除：${deleted.name} (${deleted.type}) —— 节点及其所有关系已从图谱中移除`,
              }],
              details: { mode, name: deleted.name, type: deleted.type, id: deleted.id },
            };
          }

          if (mode === "deprecate") {
            const deprecated = await deprecateNodeAndDisconnect(driver, p.name);
            if (!deprecated) throw new Error(notFoundHint);
            recaller.syncEmbed(deprecated).catch(() => {});
            return {
              content: [{
                type: "text",
                text:
                  `已标记 [DEPRECATED] 并切断图谱连接：${deprecated.name} (${deprecated.type})\n` +
                  `节点本身保留（status=deprecated，描述前缀 [DEPRECATED]），但所有入边/出边已删除，不再参与召回或社区分析。`,
              }],
              details: {
                mode,
                name: deprecated.name,
                type: deprecated.type,
                status: "deprecated",
                description: deprecated.description,
              },
            };
          }

          if (p.description === undefined && p.content === undefined) {
            throw new Error(
              "[graph-memory-pro] gm_update mode=update 至少需要提供 description 或 content 中的一个" +
              "（如需删除节点请用 mode=delete，如需弃用请用 mode=deprecate）",
            );
          }
          const updated = await updateNode(driver, p.name, {
            description: p.description,
            content: p.content,
          });
          if (!updated) {
            throw new Error(notFoundHint);
          }
          recaller.syncEmbed(updated).catch(() => {});
          const changes: string[] = [];
          if (p.description !== undefined) changes.push(`description="${updated.description}"`);
          if (p.content !== undefined) changes.push(`content (${updated.content.length} chars)`);
          return {
            content: [{
              type: "text",
              text: `已更新：${updated.name} (${updated.type})\n变更：${changes.join("，")}`,
            }],
            details: {
              mode,
              name: updated.name,
              type: updated.type,
              description: updated.description,
              contentLength: updated.content.length,
            },
          };
        },
      }),
      { name: "gm_update" },
    );

    const EDGE_TYPE_LITERAL = (label: string) => Type.Literal(label);
    const edgeTypeUnion = (description: string) => Type.Union(
      [EDGE_TYPE_LITERAL("USED_SKILL"), EDGE_TYPE_LITERAL("SOLVED_BY"),
       EDGE_TYPE_LITERAL("REQUIRES"), EDGE_TYPE_LITERAL("PATCHES"),
       EDGE_TYPE_LITERAL("CONFLICTS_WITH")],
      { description },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_link",
        label: "Link Graph Memory Nodes",
        description:
          "手动在两个已存在节点之间建立关系边。两端节点必须存在；类型和方向必须符合图谱白名单" +
          "（USED_SKILL: TASK→SKILL；SOLVED_BY: EVENT|SKILL→SKILL；REQUIRES/PATCHES/CONFLICTS_WITH: SKILL→SKILL）。" +
          "用于纠正 LLM 提取遗漏的关系或细化现有 instruction。同 from+to+type 已存在时仅更新 instruction。",
        parameters: Type.Object({
          from: Type.String({ description: "起点节点名（必须已存在；会被标准化）" }),
          to: Type.String({ description: "终点节点名（必须已存在；会被标准化）" }),
          type: edgeTypeUnion("关系类型（详见白名单方向规则）"),
          instruction: Type.String({ description: "关系的自然语言说明（一句话）" }),
          condition: Type.Optional(Type.String({ description: "关系生效的条件（可选）" })),
        }),
        async execute(
          _toolCallId: string,
          p: { from: string; to: string; type: EdgeType; instruction: string; condition?: string },
        ) {
          const fromNode = await findByName(driver, p.from);
          const toNode = await findByName(driver, p.to);
          if (!fromNode) throwNodeNotFound(p.from);
          if (!toNode) throwNodeNotFound(p.to);

          const stored = await upsertEdge(driver, {
            fromId: fromNode.id, toId: toNode.id, type: p.type,
            instruction: p.instruction, condition: p.condition, sessionId: "manual",
          });
          if (!stored) {
            throw new Error(
              `[graph-memory-pro] ${p.type} 方向不被允许：${fromNode.type} → ${toNode.type}` +
              `（白名单：USED_SKILL: TASK→SKILL；SOLVED_BY: EVENT|SKILL→SKILL；REQUIRES/PATCHES/CONFLICTS_WITH: SKILL→SKILL）`,
            );
          }
          return {
            content: [{
              type: "text",
              text: `已连接：${fromNode.name} -[${p.type}]-> ${toNode.name}\n说明：${p.instruction}`,
            }],
            details: {
              from: fromNode.name, to: toNode.name, type: p.type,
              instruction: p.instruction, condition: p.condition ?? null,
            },
          };
        },
      }),
      { name: "gm_link" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_unlink",
        label: "Unlink Graph Memory Nodes",
        description:
          "手动删除 from→to 方向的关系边（仅匹配 (from)-[r]->(to)，不影响 to→from 方向的边）。" +
          "可选 type 只删该类型，不传则删除 from→to 方向上所有类型的边。" +
          "用于清理 LLM 错误提取的关系或重置关系集合。两端节点保留。",
        parameters: Type.Object({
          from: Type.String({ description: "起点节点名（必须已存在）" }),
          to: Type.String({ description: "终点节点名（必须已存在）" }),
          type: Type.Optional(edgeTypeUnion("只删该类型的边；省略则删除 from→to 方向上所有类型的边（不影响 to→from）")),
        }),
        async execute(
          _toolCallId: string,
          p: { from: string; to: string; type?: EdgeType },
        ) {
          const fromNode = await findByName(driver, p.from);
          const toNode = await findByName(driver, p.to);
          if (!fromNode) throwNodeNotFound(p.from);
          if (!toNode) throwNodeNotFound(p.to);

          const deleted = await deleteEdges(driver, fromNode.id, toNode.id, p.type);
          const typeHint = p.type ? ` (type=${p.type})` : " (所有类型)";
          if (deleted === 0) {
            return {
              content: [{
                type: "text",
                text: `未找到 ${fromNode.name} → ${toNode.name} 之间的边${typeHint}，无操作。`,
              }],
              details: { deleted: 0, from: fromNode.name, to: toNode.name, type: p.type ?? null },
            };
          }
          return {
            content: [{
              type: "text",
              text: `已删除 ${deleted} 条边：${fromNode.name} → ${toNode.name}${typeHint}`,
            }],
            details: { deleted, from: fromNode.name, to: toNode.name, type: p.type ?? null },
          };
        },
      }),
      { name: "gm_unlink" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_merge",
        label: "Merge Graph Memory Nodes",
        description:
          "合并两个同类型的重复节点。keep 节点保留并吸收 merge 节点的 validatedCount / 较长 content/description / sourceSessions；" +
          "merge 节点的入/出边去重迁移到 keep 后被标记 deprecated（不硬删）。用于清理 LLM 重复提取产生的同名变体。" +
          "合并后建议再调用 gm_maintain 刷新 PageRank 和社区。",
        parameters: Type.Object({
          keep: Type.String({ description: "保留的节点名（必须已存在）" }),
          merge: Type.String({ description: "被合并的节点名（必须已存在，类型必须与 keep 相同，会被标记 deprecated）" }),
        }),
        async execute(
          _toolCallId: string,
          p: { keep: string; merge: string },
        ) {
          const keepNode = await findByName(driver, p.keep);
          const mergeNode = await findByName(driver, p.merge);
          if (!keepNode) throwNodeNotFound(p.keep);
          if (!mergeNode) throwNodeNotFound(p.merge);

          if (keepNode.id === mergeNode.id) {
            throw new Error(
              `[graph-memory-pro] keep 和 merge 解析到同一个节点（id=${keepNode.id}，name="${keepNode.name}"）。` +
              `名称标准化后等价（如 "React" 和 "react"），无需合并。`,
            );
          }

          if (keepNode.type !== mergeNode.type) {
            throw new Error(
              `[graph-memory-pro] 类型不匹配：keep="${keepNode.name}"(${keepNode.type}) vs merge="${mergeNode.name}"(${mergeNode.type})` +
              `（合并要求两端同类型，请用 gm_search 确认节点类型）`,
            );
          }

          await mergeNodes(driver, keepNode.id, mergeNode.id);

          const kept = await findByName(driver, p.keep);
          if (kept) recaller.syncEmbed(kept).catch(() => {});

          return {
            content: [{
              type: "text",
              text:
                `已合并：${mergeNode.name} → ${keepNode.name} (${keepNode.type})\n` +
                `- validatedCount 累加\n` +
                `- content/description 取较长版本\n` +
                `- sourceSessions 取并集\n` +
                `- 入边/出边去重迁移到 keep（同类型同端点已存在的丢弃，避免重复）\n` +
                `- merge 节点标记 deprecated（节点保留，不硬删）`,
            }],
            details: {
              kept: kept ? { name: kept.name, type: kept.type, validatedCount: kept.validatedCount } : null,
              merged: { name: mergeNode.name, type: mergeNode.type, status: "deprecated" },
            },
          };
        },
      }),
      { name: "gm_merge" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_stats",
        label: "Graph Memory Stats",
        description: "查看知识图谱统计信息。",
        parameters: Type.Object({}),
        async execute() {
          const stats = await getStats(driver);
          const session = getSession(driver);
          let topPr: any[] = [];
          try {
            const r = await session.run("MATCH (n:Task|Skill|Event {status:'active'}) RETURN n.name AS name, n.type AS type, n.pagerank AS pr ORDER BY n.pagerank DESC LIMIT 5");
            topPr = r.records.map(rec => ({ name: rec.get("name"), type: rec.get("type"), pr: rec.get("pr") ?? 0 }));
          } finally {
            await session.close();
          }
          const text = [
            `📊 知识图谱统计（Neo4j）`,
            `节点：${stats.totalNodes} 个 (${Object.entries(stats.byType).map(([t, c]) => `${t}: ${c}`).join(", ")})`,
            `边：${stats.totalEdges} 条 (${Object.entries(stats.byEdgeType).map(([t, c]) => `${t}: ${c}`).join(", ")})`,
            `社区：${stats.communities} 个`,
            `PageRank Top 5：`,
            ...topPr.map((n, i) => `  ${i + 1}. ${n.name} (${n.type}, pr=${(typeof n.pr === "number" ? n.pr : 0).toFixed(4)})`),
          ].join("\n");
          return { content: [{ type: "text", text }], details: stats };
        },
      }),
      { name: "gm_stats" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_maintain",
        label: "Graph Memory Maintenance",
        description: "手动触发图维护：去重、PageRank、社区检测。",
        parameters: Type.Object({}),
        async execute() {
          const embedFn = (recaller as any).embed ?? undefined;
          const result = await runMaintenance(driver, cfg, llm, embedFn);
          const text = [
            `🔧 图维护完成（${result.durationMs}ms）`,
            `去重：${result.dedup.pairs.length} 对相似，合并 ${result.dedup.merged} 对`,
            ...(result.dedup.pairs.length > 0
              ? result.dedup.pairs.slice(0, 5).map(p => `  "${p.nameA}" ≈ "${p.nameB}" (${(p.similarity * 100).toFixed(1)}%)`)
              : []),
            `社区：${result.community.count} 个`,
            `社区描述：${result.communitySummaries} 个`,
            `PageRank Top 5：`,
            ...result.pagerank.topK.slice(0, 5).map((n, i) => `  ${i + 1}. ${n.name} (${n.score.toFixed(4)})`),
          ].join("\n");
          return { content: [{ type: "text", text }], details: { durationMs: result.durationMs, dedupMerged: result.dedup.merged, communities: result.community.count } };
        },
      }),
      { name: "gm_maintain" },
    );

    // ── CRUD REST 路由（给 ClawX 前端用） ─────────────────
    registerCrudRoutes(api, driver, recaller);

    // ── Neovis 配置接口（给 ClawX 前端用） ──────────────────

    api.registerHttpRoute({
      path: "/graph-memory-pro/neo4j-config",
      auth: "gateway",
      match: "exact",
      handler: async (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          bolt: cfg.neo4j.uri,
          user: cfg.neo4j.user,
          password: cfg.neo4j.password,
          initialCypher: "MATCH (n:Task|Skill|Event {status:'active'})-[r]->(m:Task|Skill|Event {status:'active'}) RETURN n, r, m LIMIT 200",
        }));
        return true;
      },
    });

    api.logger.info(
      `[graph-memory-pro] ready | neo4j=${cfg.neo4j.uri} | llm.provider=${llmProvider} | model=${effectiveModel || "(none)"}`,
    );
  },
};

export default graphMemoryProPlugin;
