import { afterEach, describe, expect, it, vi } from "vitest";

import graphMemoryProPlugin from "../index.ts";
import { closeDriver } from "../src/store/db.ts";

/** 完整运行时模式的 fake api（覆盖 register() 用到的全部方法）。 */
function fullApi(pluginConfig: Record<string, unknown> = {}) {
  return {
    pluginConfig,
    config: {},
    resolvePath: (v: string) => v,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerCli: vi.fn(),
    registerTool: vi.fn(),
    registerContextEngine: vi.fn(),
    registerHttpRoute: vi.fn(),
    on: vi.fn(),
  } as any;
}

describe("duplicate register() guard", () => {
  let createdEngine: { dispose: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (createdEngine) {
      await createdEngine.dispose();
      createdEngine = null;
    }
    await closeDriver();
  });

  it("reuses the active engine when the host registers twice without dispose", () => {
    const api1 = fullApi();
    graphMemoryProPlugin.register(api1);
    expect(api1.registerContextEngine).toHaveBeenCalledTimes(1);
    createdEngine = api1.registerContextEngine.mock.calls[0][1]();

    // 第二次 register：只重绑引擎工厂，不再注册工具/路由/hook
    const api2 = fullApi();
    graphMemoryProPlugin.register(api2);
    expect(api2.registerContextEngine).toHaveBeenCalledTimes(1);
    expect(api2.registerTool).not.toHaveBeenCalled();
    expect(api2.registerHttpRoute).not.toHaveBeenCalled();
    expect(api2.on).not.toHaveBeenCalled();
    expect(api2.registerContextEngine.mock.calls[0][1]()).toBe(createdEngine);
    expect(api2.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("duplicate register() ignored"),
    );
  });

  it("creates a fresh engine after dispose() (genuine reload)", async () => {
    const api1 = fullApi();
    graphMemoryProPlugin.register(api1);
    const engineA = api1.registerContextEngine.mock.calls[0][1]();
    createdEngine = engineA;
    await engineA.dispose();

    const api2 = fullApi();
    graphMemoryProPlugin.register(api2);
    const engineB = api2.registerContextEngine.mock.calls[0][1]();
    expect(engineB).not.toBe(engineA);
    expect(api2.registerTool).toHaveBeenCalled();
    // afterEach 清理的是"最后创建"的引擎（engineB 才是当前活跃的）
    createdEngine = engineB;
  });

  it("normalizes lowercase llm.baseUrl to baseURL before provider resolution", () => {
    // 只有 apiKey 时启发式推断为 anthropic；归一生效后 baseURL 存在 → 推断为 openai
    const api = fullApi({ llm: { apiKey: "k", baseUrl: "http://localhost:8080/v1/" } });
    graphMemoryProPlugin.register(api);
    createdEngine = api.registerContextEngine.mock.calls[0]?.[1]?.() ?? null;

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('推断为 "openai"'),
    );
  });

  it("explicit baseURL wins over baseUrl spelling", () => {
    const api = fullApi({
      llm: { apiKey: "k", baseURL: "http://explicit/v1", baseUrl: "http://lowercase/v1" },
    });
    graphMemoryProPlugin.register(api);
    createdEngine = api.registerContextEngine.mock.calls[0]?.[1]?.() ?? null;

    // 显式配置优先 —— 这里只验证 register 未被拼写兼容逻辑破坏（推断告警产生一次）
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('推断为 "openai"'),
    );
    expect(
      api.logger.warn.mock.calls.filter((args: unknown[]) =>
        String(args[0]).includes("llm.provider 未显式设置"),
      ),
    ).toHaveLength(1);
  });
});
