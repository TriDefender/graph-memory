import { describe, it, expect } from "vitest";
import { readDefaultModel } from "../index.ts";

describe("readDefaultModel", () => {
  describe("#48 根因修复：只返回 model 字符串，不再硬编码 provider", () => {
    it("null 配置返回空字符串", () => {
      expect(readDefaultModel(null)).toBe("");
    });

    it("undefined 配置返回空字符串", () => {
      expect(readDefaultModel(undefined)).toBe("");
    });

    it("空对象返回空字符串", () => {
      expect(readDefaultModel({})).toBe("");
    });

    it("model 为空字符串返回空", () => {
      expect(readDefaultModel({ agents: { defaults: { model: "" } } })).toBe("");
    });

    it("缺少 agents.defaults.model 返回空", () => {
      expect(readDefaultModel({ agents: {} })).toBe("");
    });

    it("agents.defaults 不存在返回空", () => {
      expect(readDefaultModel({ agents: { foo: 1 } })).toBe("");
    });
  });

  describe("字符串 model 解析", () => {
    it("带 provider 前缀的字符串剥离前缀，只返回 model", () => {
      expect(readDefaultModel({ agents: { defaults: { model: "anthropic/claude-sonnet-4-5" } } }))
        .toBe("claude-sonnet-4-5");
    });

    it("多段 / 时只剥离第一段，保留剩余", () => {
      expect(readDefaultModel({ agents: { defaults: { model: "openai/gpt-4/mini" } } }))
        .toBe("gpt-4/mini");
    });

    it("无 / 的裸 model 原样返回（不再硬编码 provider=anthropic）", () => {
      expect(readDefaultModel({ agents: { defaults: { model: "claude-sonnet-4-5" } } }))
        .toBe("claude-sonnet-4-5");
    });

    it("无 / 的非 anthropic 裸 model 也原样返回", () => {
      expect(readDefaultModel({ agents: { defaults: { model: "gpt-4o-mini" } } }))
        .toBe("gpt-4o-mini");
    });

    it("去除首尾空白", () => {
      expect(readDefaultModel({ agents: { defaults: { model: "  anthropic/claude-x  " } } }))
        .toBe("claude-x");
    });

    it("只有空白返回空", () => {
      expect(readDefaultModel({ agents: { defaults: { model: "   " } } })).toBe("");
    });

    it("只有前缀没有 model 返回空", () => {
      expect(readDefaultModel({ agents: { defaults: { model: "anthropic/" } } })).toBe("");
    });
  });

  describe("对象形式 { primary } 解析", () => {
    it("从 model.primary 取值并剥离前缀", () => {
      expect(readDefaultModel({ agents: { defaults: { model: { primary: "anthropic/claude-opus-4" } } } }))
        .toBe("claude-opus-4");
    });

    it("primary 为裸字符串原样返回", () => {
      expect(readDefaultModel({ agents: { defaults: { model: { primary: "claude-opus-4" } } } }))
        .toBe("claude-opus-4");
    });

    it("primary 为空字符串回退到空", () => {
      expect(readDefaultModel({ agents: { defaults: { model: { primary: "" } } } }))
        .toBe("");
    });

    it("primary 为非字符串类型返回空", () => {
      expect(readDefaultModel({ agents: { defaults: { model: { primary: 42 } } } }))
        .toBe("");
    });

    it("model 为对象但无 primary 字段返回空", () => {
      expect(readDefaultModel({ agents: { defaults: { model: { foo: "bar" } } } }))
        .toBe("");
    });
  });
});
