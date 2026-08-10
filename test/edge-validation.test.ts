import { describe, expect, it } from "vitest";
import { correctEdgeType } from "../src/extractor/extract.ts";
import { isValidEdgeDirection } from "../src/types.ts";

const edge = (type: string) => ({
  from: "source",
  to: "target",
  type,
  instruction: "do it",
});

describe("edge validation", () => {
  it("rejects an unknown relationship type even when endpoint types are unavailable", () => {
    expect(correctEdgeType(edge("ARBITRARY_REL"), new Map())).toBeNull();
  });

  it("keeps a whitelisted relationship until the store can validate existing endpoints", () => {
    expect(correctEdgeType(edge("USED_SKILL"), new Map())).toEqual(edge("USED_SKILL"));
  });

  it("corrects known TASK -> SKILL endpoints to USED_SKILL", () => {
    const types = new Map([["source", "TASK"], ["target", "SKILL"]]);
    expect(correctEdgeType(edge("SOLVED_BY"), types)?.type).toBe("USED_SKILL");
  });

  it("enforces every endpoint direction at runtime", () => {
    expect(isValidEdgeDirection("USED_SKILL", "TASK", "SKILL")).toBe(true);
    expect(isValidEdgeDirection("USED_SKILL", "SKILL", "TASK")).toBe(false);
    expect(isValidEdgeDirection("REQUIRES", "SKILL", "SKILL")).toBe(true);
    expect(isValidEdgeDirection("ARBITRARY_REL", "SKILL", "SKILL")).toBe(false);
  });
});
