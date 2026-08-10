/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * LLM 调用
 *
 * 显式 provider 路由（修 issue #48：日志/实际路由脱节）：
 *   provider: "openai"    → OpenAI 兼容协议（/chat/completions），需 baseURL + apiKey
 *   provider: "anthropic" → Anthropic Messages API（/v1/messages），需 apiKey；baseURL 默认 https://api.anthropic.com
 *   provider: "oauth"     → OpenAI Codex Responses API（/codex/responses），需 oauthPath；用 PKCE OAuth bearer token
 *
 * 向后兼容（未显式设 provider 时按旧行为推断，但告警提示显式设置）：
 *   - 配了 baseURL → 推断为 "openai"
 *   - 仅配 apiKey  → 推断为 "anthropic"
 *
 * "oauth" 必须显式声明（不会从启发式推断中产生）。
 *
 * 三条路径共用 effectiveModel（由调用方合并 cfg.llm.model ?? agents.defaults.model）。
 * 超时：AbortController 强制；默认 60s，cfg.llm.timeoutMs 可调（慢速 API 用户可调大）。
 */

import {
  loadOAuthSession,
  needsRefresh,
  refreshOAuthSession,
  saveOAuthSession,
  normalizeOauthModel,
  buildOauthEndpoint,
  extractOutputTextFromSse,
} from "./oauth.ts";
import type { OAuthSession } from "./oauth.ts";

export type LlmProvider = "openai" | "anthropic" | "oauth";

/** OpenAI Codex Responses API 思考强度。low=快速、medium=平衡、high=深度推理。 */
export type ReasoningEffort = "low" | "medium" | "high";

const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export interface LlmConfig {
  /** 显式 provider 切换。未设时按 baseURL 是否存在推断（向后兼容，仅产生 openai/anthropic）。 */
  provider?: LlmProvider;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  /** 单次 LLM 请求超时（毫秒）。未配时默认 60000。OAuth 刷新令牌也用此值。 */
  timeoutMs?: number;
  maxTokens?: number;
  /** OAuth 会话文件路径（provider="oauth" 时必填）。文件由 `openclaw graph-memory auth login` 生成。 */
  oauthPath?: string;
  /** OAuth 提供商标识（默认 "openai-codex"，目前仅支持此一种）。 */
  oauthProvider?: string;
  /** 推理模型思考强度（仅 oauth provider 生效；默认 "medium"）。 */
  reasoningEffort?: ReasoningEffort;
}

export type CompleteFn = (system: string, user: string) => Promise<string>;

const DEFAULT_LLM_TIMEOUT_MS = 60_000;
const DEFAULT_LLM_MAX_TOKENS = 4_000;
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * 解析 provider：显式 > 启发式推断。
 * 返回 provider 和是否为推断值（用于告警）。
 *
 * 注意：oauth 永远不会被推断出来——必须显式声明。
 */
export function resolveProvider(cfg: LlmConfig | undefined): {
  provider: LlmProvider;
  inferred: boolean;
} {
  if (cfg?.provider === "openai" || cfg?.provider === "anthropic" || cfg?.provider === "oauth") {
    return { provider: cfg.provider, inferred: false };
  }
  // 向后兼容：未显式设 provider 时按 baseURL 推断（仅 openai/anthropic）
  const inferred = cfg?.baseURL ? "openai" : "anthropic";
  return { provider: inferred, inferred: true };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`[graph-memory] LLM request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

async function fetchRetry(
  url: string,
  init: RequestInit,
  retries: number,
  timeoutMs: number,
): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    const res = await fetchWithTimeout(url, init, timeoutMs);
    if (res.ok || i >= retries || !RETRYABLE.has(res.status)) return res;
    await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
  }
  throw new Error("[graph-memory] fetch failed after retries");
}

/**
 * 构造 LLM CompleteFn。
 *
 * @param effectiveModel 已合并后的模型名（cfg.llm.model ?? agents.defaults.model）。
 * @param llmConfig       插件 config.llm（provider / apiKey / baseURL / model / timeoutMs）。
 */
export function createCompleteFn(
  effectiveModel: string,
  llmConfig?: LlmConfig,
): CompleteFn {
  const { provider } = resolveProvider(llmConfig);
  const timeoutMs = llmConfig?.timeoutMs && llmConfig.timeoutMs > 0
    ? llmConfig.timeoutMs
    : DEFAULT_LLM_TIMEOUT_MS;
  const maxTokens = llmConfig?.maxTokens && llmConfig.maxTokens > 0
    ? llmConfig.maxTokens
    : DEFAULT_LLM_MAX_TOKENS;
  const reasoningEffort: ReasoningEffort =
    llmConfig?.reasoningEffort === "low" ||
    llmConfig?.reasoningEffort === "medium" ||
    llmConfig?.reasoningEffort === "high"
      ? llmConfig.reasoningEffort
      : DEFAULT_REASONING_EFFORT;

  // ── OAuth 会话缓存：单飞刷新，避免并发请求同时触发 refresh ──
  const oauthPath = provider === "oauth" ? llmConfig?.oauthPath : undefined;
  let cachedSessionPromise: Promise<OAuthSession> | null = null;
  let refreshPromise: Promise<OAuthSession> | null = null;

  async function getOAuthSession(): Promise<OAuthSession> {
    if (!oauthPath) {
      throw new Error("[graph-memory] provider=oauth 需要 llm.oauthPath");
    }
    if (!cachedSessionPromise) {
      cachedSessionPromise = loadOAuthSession(oauthPath).catch((error) => {
        cachedSessionPromise = null;
        throw error;
      });
    }
    let session = await cachedSessionPromise;
    if (needsRefresh(session)) {
      if (!refreshPromise) {
        refreshPromise = refreshOAuthSession(session, timeoutMs)
          .then(async (s) => {
            await saveOAuthSession(oauthPath, s);
            cachedSessionPromise = Promise.resolve(s);
            refreshPromise = null;
            return s;
          })
          .catch((err) => {
            refreshPromise = null;
            throw err;
          });
      }
      session = await refreshPromise;
    }
    return session;
  }

  return async (system, user) => {
    // ── 路径 C：OAuth Codex Responses API ──
    if (provider === "oauth") {
      if (!oauthPath) {
        throw new Error("[graph-memory] provider=oauth 需要 llm.oauthPath");
      }
      const session = await getOAuthSession();
      const endpoint = buildOauthEndpoint(llmConfig?.baseURL, llmConfig?.oauthProvider);
      const oauthModel = normalizeOauthModel(llmConfig?.model ?? effectiveModel);

      const res = await fetchRetry(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "OpenAI-Beta": "responses=experimental",
          "chatgpt-account-id": session.accountId,
          "originator": "codex_cli_rs",
        },
        body: JSON.stringify({
          model: oauthModel,
          instructions: system.trim(),
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: user }],
            },
          ],
          reasoning: { effort: reasoningEffort },
          store: false,
          stream: false,
          text: { format: { type: "text" } },
        }),
      }, 3, timeoutMs);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`[graph-memory] OAuth LLM API ${res.status}: ${errText.slice(0, 500)}`);
      }

      const bodyText = await res.text();
      let text: string | null = null;
      try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        const output = Array.isArray(parsed.output) ? parsed.output : [];
        for (const item of output) {
          if (!item || typeof item !== "object") continue;
          const content = Array.isArray((item as Record<string, unknown>).content)
            ? (item as Record<string, unknown>).content as Array<Record<string, unknown>>
            : [];
          for (const part of content) {
            if (part?.type === "output_text" && typeof part.text === "string") {
              text = (text ?? "") + part.text;
            }
          }
        }
      } catch {
        // 服务器忽略 stream:false 时回退到 SSE 解析
        text = extractOutputTextFromSse(bodyText);
      }

      if (text) return text;
      throw new Error("[graph-memory] OAuth LLM returned empty content");
    }

    if (provider === "anthropic") {
      // ── Anthropic Messages API ──
      const key = llmConfig?.apiKey;
      if (!key) {
        throw new Error(
          "[graph-memory] llm.provider=anthropic 但未配 llm.apiKey。请在 graph-memory config.llm 中配置 apiKey",
        );
      }
      const baseURL = (llmConfig?.baseURL ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
      const res = await fetchWithTimeout(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      }, timeoutMs);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`[graph-memory] Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
      }
      const data = await res.json() as any;
      const text = data.content?.[0]?.text;
      if (text) return text;
      const stop = data.choices?.[0]?.finish_reason ?? data.stop_reason;
      throw new Error(
        `[graph-memory] LLM returned empty content${stop ? ` (stop_reason=${stop})` : ""}. ` +
        `Reasoning models may exhaust max_tokens (${maxTokens}); raise llm.maxTokens if recurring.`,
      );
    }

    // ── OpenAI 兼容 /chat/completions ──
    const apiKey = llmConfig?.apiKey;
    const baseURL = llmConfig?.baseURL;
    if (!apiKey || !baseURL) {
      throw new Error(
        "[graph-memory] llm.provider=openai 需要 llm.apiKey + llm.baseURL。请在 graph-memory config.llm 中配置",
      );
    }
    const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: effectiveModel,
        messages: [
          ...(system.trim() ? [{ role: "system", content: system.trim() }] : []),
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
      }),
    }, timeoutMs);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`[graph-memory] LLM API ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (text) return text;
    const stop = choice?.finish_reason;
    const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens;
    throw new Error(
      `[graph-memory] LLM returned empty content${stop ? ` (finish_reason=${stop})` : ""}` +
      (reasoningTokens ? ` — reasoning consumed ${reasoningTokens} of ${maxTokens} tokens` : "") +
      `. Raise llm.maxTokens if recurring.`,
    );
  };
}
