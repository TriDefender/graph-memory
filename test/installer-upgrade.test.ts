import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("setup-graph-memory-pro upgrade", () => {
  it("preserves an existing Neo4j data directory", () => {
    const output = execFileSync("bash", ["test/installer-upgrade.fixture.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(output.trim()).toBe("preserved");
  });

  it("leaves files and services untouched in dry-run install and uninstall modes", () => {
    const output = execFileSync("bash", ["test/installer-dry-run.fixture.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(output.trim()).toBe("dry-run-clean");
  });
});
