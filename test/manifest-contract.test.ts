import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("OpenClaw manifest contracts", () => {
  it("declares every graph maintenance tool", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { contracts?: { tools?: string[] } };

    expect(manifest.contracts?.tools).toEqual([
      "gm_search",
      "gm_record",
      "gm_update",
      "gm_link",
      "gm_unlink",
      "gm_merge",
      "gm_stats",
      "gm_maintain",
    ]);
  });
});
