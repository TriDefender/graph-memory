import { describe, expect, it } from "vitest";
import {
  applyOAuthConfig,
  ensurePluginConfigRoot,
  type OpenClawConfigRoot,
} from "../src/cli.ts";

describe("OAuth CLI OpenClaw config updates", () => {
  it("writes under plugins.entries.<id>.config and preserves sibling fields", () => {
    const config: OpenClawConfigRoot = {
      agents: { defaults: { model: "anthropic/claude-sonnet" } },
      plugins: {
        slots: { contextEngine: "graph-memory-pro" },
        entries: {
          other: { enabled: true, config: { untouched: true } },
          "graph-memory-pro": {
            enabled: false,
            config: {
              neo4j: { uri: "bolt://localhost:7687" },
              llm: { provider: "openai", apiKey: "keep-me", timeoutMs: 1234 },
            },
          },
        },
      },
    };

    const result = applyOAuthConfig(config, "graph-memory-pro", {
      providerId: "openai-codex",
      oauthPath: "/tmp/oauth.json",
      model: "gpt-test",
      reasoningEffort: "high",
    });

    expect(result.wasOauthMode).toBe(false);
    expect(result.existingLlm).toEqual({
      provider: "openai",
      apiKey: "keep-me",
      timeoutMs: 1234,
    });
    expect(config.plugins?.entries?.["graph-memory-pro"]).toEqual({
      enabled: false,
      config: {
        neo4j: { uri: "bolt://localhost:7687" },
        llm: {
          provider: "oauth",
          apiKey: "keep-me",
          timeoutMs: 1234,
          oauthProvider: "openai-codex",
          oauthPath: "/tmp/oauth.json",
          model: "gpt-test",
          reasoningEffort: "high",
        },
      },
    });
    expect(config.plugins?.entries?.other).toEqual({
      enabled: true,
      config: { untouched: true },
    });
    expect((config.plugins as Record<string, unknown>)["graph-memory-pro"]).toBeUndefined();
  });

  it("creates a valid enabled plugin entry when none exists", () => {
    const config: OpenClawConfigRoot = {};
    const pluginConfig = ensurePluginConfigRoot(config, "graph-memory-pro");
    pluginConfig.neo4j = { uri: "bolt://localhost:7687" };

    expect(config).toEqual({
      plugins: {
        entries: {
          "graph-memory-pro": {
            enabled: true,
            config: { neo4j: { uri: "bolt://localhost:7687" } },
          },
        },
      },
    });
  });
});
