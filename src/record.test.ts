/**
 * Tests for the record log: the chain verifies when untouched, and any
 * edit to a stored entry breaks verification at exactly that entry.
 */

import { describe, expect, it } from "vitest";

import { RecordLog } from "./record";
import { MemoryStore } from "./store";

/**
 * Build a log over a fresh in-memory store and append three entries.
 * Returns both, so a test can tamper with the store under the log.
 */
async function threeEntryLog(): Promise<{
  store: MemoryStore;
  log: RecordLog;
}> {
  const store = new MemoryStore();
  const log = new RecordLog(store);
  await log.append("sp-1", "remember", "item-1", "Memory item stored.");
  await log.append("sp-2", "refuse", "item-1", "Read refused: not the owner.");
  await log.append("sp-1", "approve", "chg-1", "Proposed change approved.");
  return { store, log };
}

describe("RecordLog", () => {
  /** The first entry chains onto GENESIS and each later one onto the last. */
  it("chains the first entry onto GENESIS and verifies ok", async () => {
    const { log } = await threeEntryLog();
    const entries = await log.entries();
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(entries[0].prevHash).toBe("GENESIS");
    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(entries[2].prevHash).toBe(entries[1].hash);
    await expect(log.verify()).resolves.toEqual({ ok: true, count: 3 });
  });

  /** Editing a stored entry's detail breaks verify at that entry's seq. */
  it("reports the tampered entry's seq when a detail is edited", async () => {
    const { store, log } = await threeEntryLog();
    const second = (await log.entries())[1];
    await store.put("records", String(second.seq), {
      ...second,
      detail: "Edited after the fact.",
    });
    await expect(log.verify()).resolves.toEqual({
      ok: false,
      brokenSeq: 2,
    });
  });

  /** An empty log verifies ok with a count of zero, not an error. */
  it("verifies an empty log as ok", async () => {
    const log = new RecordLog(new MemoryStore());
    await expect(log.verify()).resolves.toEqual({ ok: true, count: 0 });
  });
});
