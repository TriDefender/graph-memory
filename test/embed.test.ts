import { afterEach, describe, expect, it, vi } from "vitest";

import { createEmbedFn, isMinimaxEndpoint } from "../src/engine/embed.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MiniMax embedding adapter", () => {
  it("matches only MiniMax hostnames and subdomains", () => {
    expect(isMinimaxEndpoint("https://api.minimaxi.com/v1")).toBe(true);
    expect(isMinimaxEndpoint("api.minimax.io/v1")).toBe(true);
    expect(isMinimaxEndpoint("https://evilminimaxi.com/v1")).toBe(false);
    expect(isMinimaxEndpoint("https://example.com/minimaxi.com/v1")).toBe(false);
  });

  it("uses texts/type requests and reads vector responses", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ data: [{ vector: [0.1, 0.2, 0.3] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const embed = await createEmbedFn({
      apiKey: "test-key",
      baseURL: "https://api.minimaxi.com/v1",
      model: "embo-01",
      dimensions: 1536,
    });

    expect(embed).not.toBeNull();
    await embed!("stored text", "db");
    await embed!("search text", "query");

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.minimaxi.com/v1/embeddings",
      "https://api.minimaxi.com/v1/embeddings",
      "https://api.minimaxi.com/v1/embeddings",
    ]);
    expect(requests.map((request) => request.body)).toEqual([
      { model: "embo-01", texts: ["ping"], type: "query" },
      { model: "embo-01", texts: ["stored text"], type: "db" },
      { model: "embo-01", texts: ["search text"], type: "query" },
    ]);
  });

  it("keeps the OpenAI-compatible request and response shape", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const embed = await createEmbedFn({
      apiKey: "test-key",
      baseURL: "https://evilminimaxi.com/v1",
      model: "text-embedding-test",
      dimensions: 512,
    });

    expect(await embed!("hello", "query")).toEqual([1, 2]);
    expect(bodies).toEqual([
      { model: "text-embedding-test", input: "ping", dimensions: 512 },
      { model: "text-embedding-test", input: "hello", dimensions: 512 },
    ]);
  });
});
