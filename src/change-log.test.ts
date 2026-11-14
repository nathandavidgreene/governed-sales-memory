/**
 * Tests for the change log: the chain verifies when untouched, any edit
 * to a stored entry breaks verification at exactly that entry, and
 * concurrent appends cannot fork the chain.
 */

import { describe, expect, it } from "vitest";

import { ChangeLog } from "./change-log";
import { MemoryStore, type JsonRecord, type Store } from "./store";

/**
 * Build a log over a fresh in-memory store and append three entries.
 * Returns both, so a test can tamper with the store under the log.
 */
async function threeEntryLog(): Promise<{
  store: MemoryStore;
  log: ChangeLog;
}> {
  const store = new MemoryStore();
  const log = new ChangeLog(store);
  await log.append("sp-1", "remember", "item-1", "Memory item stored.");
  await log.append("sp-2", "refuse", "item-1", "Read refused: not the owner.");
  await log.append("sp-1", "approve", "chg-1", "Proposed change approved.");
  return { store, log };
}

describe("ChangeLog", () => {
  /** The first entry links to GENESIS and each later one via previous_id. */
  it("chains the first entry onto GENESIS and verifies ok", async () => {
    const { log } = await threeEntryLog();
    const entries = await log.entries();
    expect(entries.map((entry) => entry._id)).toEqual(["1", "2", "3"]);
    expect(entries[0].previous_id).toBe("GENESIS");
    expect(entries[1].previous_id).toBe(entries[0]._id);
    expect(entries[2].previous_id).toBe(entries[1]._id);
    await expect(log.verify()).resolves.toEqual({ ok: true, count: 3 });
  });

  /** Editing a stored entry's detail breaks verify at that entry's id. */
  it("reports the tampered entry's id when a detail is edited", async () => {
    const { store, log } = await threeEntryLog();
    const second = (await log.entries())[1];
    await store.put("change_log", second._id, {
      ...second,
      detail: "Edited after the fact.",
    });
    await expect(log.verify()).resolves.toEqual({
      ok: false,
      brokenId: "2",
    });
  });

  /** Rewriting an entry's previous_id link breaks verify at that entry. */
  it("reports the entry whose previous_id link was rewritten", async () => {
    const { store, log } = await threeEntryLog();
    const third = (await log.entries())[2];
    await store.put("change_log", third._id, {
      ...third,
      previous_id: "1",
    });
    await expect(log.verify()).resolves.toEqual({
      ok: false,
      brokenId: "3",
    });
  });

  /** An empty log verifies ok with a count of zero, not an error. */
  it("verifies an empty log as ok", async () => {
    const log = new ChangeLog(new MemoryStore());
    await expect(log.verify()).resolves.toEqual({ ok: true, count: 0 });
  });

  /**
   * Five appends fired at once through one log still land as one
   * unbroken chain with each sequence id used exactly once — the
   * append queue assigns ids atomically instead of read-then-write.
   */
  it("keeps one unbroken chain under concurrent appends", async () => {
    const log = new ChangeLog(new MemoryStore());
    const appended = await Promise.all(
      ["a", "b", "c", "d", "e"].map((subject) =>
        log.append("sp-1", "remember", subject, "Memory item stored."),
      ),
    );
    expect(new Set(appended.map((entry) => entry._id)).size).toBe(5);
    await expect(log.verify()).resolves.toEqual({ ok: true, count: 5 });
  });

  /**
   * Two log instances over one store appending at once still produce
   * a single verifiable chain: the losing insert retries from the new
   * tail rather than overwriting the winner's entry.
   */
  it("keeps one chain when two instances share a store", async () => {
    const store = new MemoryStore();
    const first = new ChangeLog(store);
    const second = new ChangeLog(store);
    await Promise.all([
      first.append("sp-1", "remember", "item-1", "Memory item stored."),
      second.append("sp-2", "remember", "item-2", "Memory item stored."),
      first.append("sp-1", "approve", "chg-1", "Proposed change approved."),
      second.append("sp-2", "approve", "chg-2", "Proposed change approved."),
    ]);
    await expect(first.verify()).resolves.toEqual({ ok: true, count: 4 });
  });

  /**
   * Appends chain onto the store's tail lookup, not a full listing:
   * with a store that counts its `list` calls, an append after the
   * first entry must not list the collection at all. This is what
   * keeps a long log's append cheap against the database.
   */
  it("appends via the tail lookup without listing the log", async () => {
    const inner = new MemoryStore();
    let listCalls = 0;
    const counting: Store = {
      get: (collection, id) => inner.get(collection, id),
      put: (collection, id, record) => inner.put(collection, id, record),
      insert: (collection, id, record) =>
        inner.insert(collection, id, record),
      list: (collection): Promise<JsonRecord[]> => {
        listCalls += 1;
        return inner.list(collection);
      },
      last: (collection) => inner.last(collection),
    };
    const log = new ChangeLog(counting);
    await log.append("sp-1", "remember", "item-1", "Memory item stored.");
    await log.append("sp-1", "approve", "chg-1", "Proposed change approved.");
    expect(listCalls).toBe(0);
    await expect(log.verify()).resolves.toEqual({ ok: true, count: 2 });
  });
});
