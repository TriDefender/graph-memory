import { describe, it, expect } from "vitest";
import { applyNodePatch, applyDeprecateMarker } from "../src/store/store.ts";
import type { GmNode } from "../src/types.ts";

const baseNode: Pick<GmNode, "description" | "content"> = {
  description: "旧描述",
  content: "旧内容",
};

describe("applyNodePatch (#57 updateNode 字段合并语义)", () => {
  it("空 patch 保留原值", () => {
    expect(applyNodePatch(baseNode, {})).toEqual({ description: "旧描述", content: "旧内容" });
  });

  it("只更新 description，保留 content", () => {
    expect(applyNodePatch(baseNode, { description: "新描述" }))
      .toEqual({ description: "新描述", content: "旧内容" });
  });

  it("只更新 content，保留 description", () => {
    expect(applyNodePatch(baseNode, { content: "新内容" }))
      .toEqual({ description: "旧描述", content: "新内容" });
  });

  it("同时更新 description 和 content", () => {
    expect(applyNodePatch(baseNode, { description: "新描述", content: "新内容" }))
      .toEqual({ description: "新描述", content: "新内容" });
  });

  it("空字符串 patch 字段会覆盖原值（?? 语义：仅 undefined 保留原值）", () => {
    expect(applyNodePatch(baseNode, { description: "" }))
      .toEqual({ description: "", content: "旧内容" });
  });

  it("显式 undefined 等价于不传该字段", () => {
    expect(applyNodePatch(baseNode, { description: undefined, content: "新" }))
      .toEqual({ description: "旧描述", content: "新" });
  });
});

describe("applyDeprecateMarker (gm_update mode=deprecate)", () => {
  it("在普通描述前加 [DEPRECATED] 前缀", () => {
    expect(applyDeprecateMarker("处理 PDF 提取")).toBe("[DEPRECATED] 处理 PDF 提取");
  });

  it("空描述仅返回 [DEPRECATED]", () => {
    expect(applyDeprecateMarker("")).toBe("[DEPRECATED]");
  });

  it("已带前缀的描述保持幂等（不重复添加）", () => {
    expect(applyDeprecateMarker("[DEPRECATED] 旧技能"))
      .toBe("[DEPRECATED] 旧技能");
  });

  it("不会误判仅出现 [DEPRECATED] 子串的描述为已标记", () => {
    expect(applyDeprecateMarker("讨论了 [DEPRECATED] 标记的用法"))
      .toBe("[DEPRECATED] 讨论了 [DEPRECATED] 标记的用法");
  });

  it("保留原描述内容完整不截断", () => {
    const long = "A".repeat(500);
    const result = applyDeprecateMarker(long);
    expect(result).toBe(`[DEPRECATED] ${long}`);
    expect(result.endsWith(long)).toBe(true);
  });
});
