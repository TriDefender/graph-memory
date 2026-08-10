import { describe, it, expect } from "vitest";
import {
  parseTimeRange,
  matchTimeRange,
} from "../src/recaller/recall.ts";

describe("parseTimeRange", () => {
  it("无参数 → 全区间 + 默认 field=createdAt", () => {
    const r = parseTimeRange({});
    expect(r.field).toBe("createdAt");
    expect(r.sinceMs).toBe(0);
    expect(r.untilMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("只传 after → [after, +∞)", () => {
    const r = parseTimeRange({ after: "2024-01-01T00:00:00Z" });
    expect(r.sinceMs).toBe(Date.parse("2024-01-01T00:00:00Z"));
    expect(r.untilMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("只传 before → [0, before]", () => {
    const r = parseTimeRange({ before: "2024-12-31T00:00:00Z" });
    expect(r.sinceMs).toBe(0);
    expect(r.untilMs).toBe(Date.parse("2024-12-31T00:00:00Z"));
  });

  it("同时传 after+before → [after, before]", () => {
    const r = parseTimeRange({
      after: "2024-01-01T00:00:00Z",
      before: "2024-12-31T00:00:00Z",
    });
    expect(r.sinceMs).toBe(Date.parse("2024-01-01T00:00:00Z"));
    expect(r.untilMs).toBe(Date.parse("2024-12-31T00:00:00Z"));
  });

  it("支持纯日期格式 '2024-01-01'", () => {
    const r = parseTimeRange({ after: "2024-01-01" });
    expect(Number.isNaN(r.sinceMs)).toBe(false);
    expect(r.sinceMs).toBe(Date.parse("2024-01-01"));
  });

  it("尊重 timeField: 'updatedAt'", () => {
    const r = parseTimeRange({ timeField: "updatedAt" });
    expect(r.field).toBe("updatedAt");
  });

  it("非法 after 抛错", () => {
    expect(() => parseTimeRange({ after: "not-a-date" })).toThrow(/invalid "after"/);
  });

  it("非法 before 抛错", () => {
    expect(() => parseTimeRange({ before: "not-a-date" })).toThrow(/invalid "before"/);
  });

  it("after > before 抛错", () => {
    expect(() => parseTimeRange({
      after: "2024-12-31T00:00:00Z",
      before: "2024-01-01T00:00:00Z",
    })).toThrow(/must be earlier/);
  });

  it("after == before 合法（单时间点）", () => {
    const t = "2024-06-15T00:00:00Z";
    const r = parseTimeRange({ after: t, before: t });
    expect(r.sinceMs).toBe(r.untilMs);
  });
});

describe("matchTimeRange", () => {
  const baseNode = {
    createdAt: Date.parse("2024-06-15T00:00:00Z"),
    updatedAt: Date.parse("2024-07-20T00:00:00Z"),
  };

  it("createdAt 在区间内 → true", () => {
    const range = parseTimeRange({ after: "2024-01-01", before: "2024-12-31" });
    expect(matchTimeRange(baseNode, range)).toBe(true);
  });

  it("createdAt 早于 after → false", () => {
    const range = parseTimeRange({ after: "2025-01-01" });
    expect(matchTimeRange(baseNode, range)).toBe(false);
  });

  it("createdAt 晚于 before → false", () => {
    const range = parseTimeRange({ before: "2024-01-01" });
    expect(matchTimeRange(baseNode, range)).toBe(false);
  });

  it("updatedAt 字段：在区间内 → true", () => {
    const range = parseTimeRange({
      after: "2024-07-01",
      before: "2024-07-31",
      timeField: "updatedAt",
    });
    expect(matchTimeRange(baseNode, range)).toBe(true);
  });

  it("updatedAt 字段：不在区间 → false", () => {
    const range = parseTimeRange({
      after: "2024-08-01",
      timeField: "updatedAt",
    });
    expect(matchTimeRange(baseNode, range)).toBe(false);
  });

  it("边界：createdAt 等于 after 与 before → true（闭区间）", () => {
    const range = parseTimeRange({
      after: "2024-06-15T00:00:00Z",
      before: "2024-06-15T00:00:00Z",
    });
    expect(matchTimeRange(baseNode, range)).toBe(true);
  });

  it("全区间 → 任意节点都命中", () => {
    const range = parseTimeRange({});
    expect(matchTimeRange(baseNode, range)).toBe(true);
    expect(matchTimeRange({ createdAt: 0, updatedAt: 0 }, range)).toBe(true);
  });
});
