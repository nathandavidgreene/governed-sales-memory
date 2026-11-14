/**
 * Tests for the in-memory store: the put/get/list roundtrip the whole app
 * builds on, plus the fail-closed reads for data that is not there.
 */

import { describe, expect, it } from "vitest";

import { MemoryStore } from "./store";

describe("MemoryStore", () => {
  /** A record put into a collection comes back out by id, unchanged. */
  it("returns a record that was put, by collection and id", async () => {
    const store = new MemoryStore();
    await store.put("accounts", "a-1", {
      id: "a-1",
      owner_salesperson_id: "sp-1",
    });
    await expect(store.get("accounts", "a-1")).resolves.toEqual({
      id: "a-1",
      owner_salesperson_id: "sp-1",
    });
  });

  /** Reading an id that was never stored reports undefined, not a guess. */
  it("returns undefined for a missing id", async () => {
    const store = new MemoryStore();
    await expect(store.get("accounts", "missing")).resolves.toBeUndefined();
  });

  /** List returns every record in the collection, and only those. */
  it("lists all records in a collection", async () => {
    const store = new MemoryStore();
    await store.put("accounts", "a-1", { id: "a-1" });
    await store.put("accounts", "a-2", { id: "a-2" });
    await store.put("products", "p-1", { id: "p-1" });
    await expect(store.list("accounts")).resolves.toEqual([
      { id: "a-1" },
      { id: "a-2" },
    ]);
  });

  /** Listing a collection that does not exist returns an empty list. */
  it("returns an empty list for an unknown collection", async () => {
    const store = new MemoryStore();
    await expect(store.list("nope")).resolves.toEqual([]);
  });

  /** An inserted record comes back by id, exactly as inserted. */
  it("returns a record that was inserted, by collection and id", async () => {
    const store = new MemoryStore();
    await store.insert("change_log", "1", { _id: "1", action: "remember" });
    await expect(store.get("change_log", "1")).resolves.toEqual({
      _id: "1",
      action: "remember",
    });
  });

  /**
   * Insert is insert-only: a second insert under a taken id rejects
   * and leaves the original record untouched — the guarantee the
   * change log's append relies on instead of read-then-write.
   */
  it("rejects an insert under a taken id and keeps the original", async () => {
    const store = new MemoryStore();
    await store.insert("change_log", "1", { _id: "1", action: "remember" });
    await expect(
      store.insert("change_log", "1", { _id: "1", action: "forget" }),
    ).rejects.toThrow();
    await expect(store.get("change_log", "1")).resolves.toEqual({
      _id: "1",
      action: "remember",
    });
  });
});
