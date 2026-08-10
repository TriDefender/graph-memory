import { describe, expect, it } from "vitest";

import { missingIngestMessages } from "../index.ts";

describe("ingest lifecycle compatibility", () => {
  const messages = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("backfills every message when an older host skips ingest", () => {
    expect(missingIngestMessages(messages, 0)).toEqual(messages);
  });

  it("backfills only the suffix after partial ingest delivery", () => {
    expect(missingIngestMessages(messages, 1)).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it("does not duplicate messages already delivered by ingest", () => {
    expect(missingIngestMessages(messages, messages.length)).toEqual([]);
    expect(missingIngestMessages(messages, 99)).toEqual([]);
  });
});
