import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  needsRefresh,
  saveOAuthSession,
  type OAuthSession,
} from "../src/engine/oauth.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
  })));
});

function makeSession(overrides: Partial<OAuthSession> = {}): OAuthSession {
  return {
    accessToken: "access-token",
    accountId: "account-id",
    providerId: "openai-codex",
    authPath: "/tmp/oauth.json",
    ...overrides,
  };
}

describe("OAuth session lifecycle", () => {
  it("flags an expired session even when it has no refresh token", () => {
    expect(needsRefresh(makeSession({ expiresAt: Date.now() - 1_000 }))).toBe(true);
  });

  it("does not refresh a session with no expiry", () => {
    expect(needsRefresh(makeSession())).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "tightens permissions when overwriting an existing session file",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "graph-memory-oauth-"));
      temporaryDirectories.push(directory);
      const authPath = path.join(directory, "oauth.json");
      await writeFile(authPath, "{}\n", { mode: 0o644 });
      await chmod(authPath, 0o644);

      await saveOAuthSession(authPath, makeSession({ authPath, refreshToken: "refresh-token" }));

      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    },
  );
});
