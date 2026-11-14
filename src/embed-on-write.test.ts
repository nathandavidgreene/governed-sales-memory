/**
 * Tests for embedding on write: `remember`, `rememberOnAccount`, and a
 * text `correct` embed the stored text one call at a time when an
 * embedder is configured, and fail soft when it is not or when it
 * throws — the write still succeeds, just without a vector. A text
 * correction never leaves the old, stale vector behind.
 */

import { describe, expect, it } from "vitest";

import { ChangeLog } from "./change-log";
import { MemoryService, type EmbedDocument } from "./memory";
import { seededStore } from "./seed";
import type { Store } from "./store";

/** The first salesperson, owner of acct_willow in the seed. */
const SP1 = "acct_salesperson";

/**
 * An embedder that records each text it is asked to embed and returns
 * a vector derived from the text's length, so tests can tell vectors
 * for different texts apart.
 */
function recordingEmbedder(): { embed: EmbedDocument; texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    embed: (text) => {
      texts.push(text);
      return Promise.resolve([text.length, 1, 0]);
    },
  };
}

/** An embedder that always fails, as Voyage would on a rate limit. */
const failingEmbedder: EmbedDocument = () => Promise.reject(new Error("429"));

/** Build a memory service over a fresh seeded store with the given embedder. */
async function serviceWith(
  embed?: EmbedDocument,
): Promise<{ service: MemoryService; store: Store }> {
  const store = await seededStore();
  return { service: new MemoryService(store, new ChangeLog(store), embed), store };
}

describe("embedding on write", () => {
  /** remember stores the text's vector in the embedding field, one text per call. */
  it("embeds remembered text", async () => {
    const { embed, texts } = recordingEmbedder();
    const { service, store } = await serviceWith(embed);
    await service.remember(SP1, { id: "m1", kind: "note", text: "Dan likes golf." });
    const result = await service.rememberOnAccount(SP1, "acct_willow", {
      id: "m2",
      kind: "note",
      text: "Budget is small.",
    });
    expect(result.ok).toBe(true);
    expect(texts).toEqual(["Dan likes golf.", "Budget is small."]);
    expect((await store.get("memories", "m1"))?.embedding).toEqual([15, 1, 0]);
    expect((await store.get("memories", "m2"))?.embedding).toEqual([16, 1, 0]);
  });

  /** A failing embedder or none at all still stores the item, with no vector. */
  it("stores the item without a vector when embedding fails or is not configured", async () => {
    for (const embed of [failingEmbedder, undefined]) {
      const { service, store } = await serviceWith(embed);
      const item = await service.remember(SP1, { id: "m1", kind: "note", text: "Hi." });
      expect(item.text).toBe("Hi.");
      const stored = await store.get("memories", "m1");
      expect(stored?.text).toBe("Hi.");
      expect(stored).not.toHaveProperty("embedding");
    }
  });

  /** Correcting the text replaces the vector with one for the new text. */
  it("re-embeds corrected text", async () => {
    const { embed } = recordingEmbedder();
    const { service, store } = await serviceWith(embed);
    await service.remember(SP1, { id: "m1", kind: "note", text: "Short." });
    await service.correct(SP1, "m1", "text", "A much longer note.");
    expect((await store.get("memories", "m1"))?.embedding).toEqual([19, 1, 0]);
  });

  /**
   * When re-embedding fails, the stale vector from before the
   * correction is cleared rather than kept, and the correction still
   * succeeds.
   */
  it("clears the stale vector when re-embedding a correction fails", async () => {
    const { service, store } = await serviceWith(failingEmbedder);
    await store.put("memories", "m1", {
      _id: "m1",
      id: "m1",
      owner_salesperson_id: SP1,
      kind: "note",
      text: "Old text.",
      forgotten: false,
      embedding: [9, 9, 9],
    });
    const result = await service.correct(SP1, "m1", "text", "New text.");
    expect(result.ok).toBe(true);
    const stored = await store.get("memories", "m1");
    expect(stored?.text).toBe("New text.");
    expect(stored).not.toHaveProperty("embedding");
  });

  /** Correcting only the kind keeps the vector, since the text did not change. */
  it("keeps the vector when only the kind is corrected", async () => {
    const { embed, texts } = recordingEmbedder();
    const { service, store } = await serviceWith(embed);
    await service.remember(SP1, { id: "m1", kind: "note", text: "Same." });
    await service.correct(SP1, "m1", "kind", "stakeholder");
    expect(texts).toEqual(["Same."]);
    expect((await store.get("memories", "m1"))?.embedding).toEqual([5, 1, 0]);
  });

  /** A refused write never calls the embedder. */
  it("does not embed when remember on another owner's account is refused", async () => {
    const { embed, texts } = recordingEmbedder();
    const { service } = await serviceWith(embed);
    const result = await service.rememberOnAccount("acct_salesperson_2", "acct_willow", {
      kind: "note",
      text: "x",
    });
    expect(result).toEqual({ ok: false, error: "not found" });
    expect(texts).toEqual([]);
  });
});
