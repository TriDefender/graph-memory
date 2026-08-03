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
 *
 * 向后兼容（未显式设 provider 时按旧行为推断，但告警提示显式设置）：
 *   - 配了 baseURL → 推断为 "openai"
 *   - 仅配 apiKey  → 推断为 "anthropic"
 *
 * 两条路径共用 effectiveModel（由调用方合并 cfg.llm.model ?? agents.defaults.model）。
 * 超时：AbortController 强制；默认 60s，cfg.llm.timeoutMs 可调（慢速 API 用户可调大）。
 */

export type LlmProvider = "openai" | "anthropic";

export interface LlmConfig {
  /** 显式 provider 切换。未设时按 baseURL 是否存在推断（向后兼容）。 */
  provider?: LlmProvider;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  /** 单次 LLM 请求超时（毫秒）。未配时默认 60000。 */
  timeoutMs?: number;
}

export type CompleteFn = (system: string, user: string) => Promise<string>;

const DEFAULT_LLM_TIMEOUT_MS = 60_000;
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * 解析 provider：显式 > 启发式推断。
 * 返回 provider 和是否为推断值（用于告警）。
 */
export function resolveProvider(cfg: LlmConfig | undefined): {
  provider: LlmProvider;
  inferred: boolean;
} {
  if (cfg?.provider === "openai" || cfg?.provider === "anthropic") {
    return { provider: cfg.provider, inferred: false };
  }
  // 向后兼容：未显式设 provider 时按 baseURL 推断
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

  return async (system, user) => {
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
          max_tokens: 2000,
          system,
          messages: [{ role: "user", content: user }],
        }),
      }, timeoutMs);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`[graph-memory] Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
      }
      return ((await res.json() as any).content?.[0]?.text) ?? "";
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
        max_tokens: 2000,
        temperature: 0.1,
      }),
    }, timeoutMs);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`[graph-memory] LLM API ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    const text = data.choices?.[0]?.message?.content ?? "";
    if (text) return text;
    throw new Error("[graph-memory] LLM returned empty content");
  };
}
