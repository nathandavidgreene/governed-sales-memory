/**
 * Tests for the database-backed store that can run without a database:
 * the pure record-to-document mapping, the factory's store choice
 * (including its fail-closed refusal), and the store's surface shape.
 * Nothing here connects anywhere — live database behaviour, including
 * insert's duplicate rejection against a real collection, is verified
 * at deploy time, when the connection secret exists. (The duplicate
 * half of the `insert` contract is covered against the in-memory
 * store in store.test.ts.)
 */

import { describe, expect, it } from "vitest";

import { AtlasStore, fromStoredDoc, toStoredDoc } from "./atlas-store";
import { createStore } from "./factory";
import { MemoryStore } from "./store";

describe("stored document mapping", () => {
  /**
   * Storing sets the document's `_id` to the id the record is stored
   * under — the seeded data is keyed on `_id`, so that is the address
   * every read uses.
   */
  it("keys the stored document on _id", () => {
    const doc = toStoredDoc("a-1", {
      id: "a-1",
      owner_salesperson_id: "sp-1",
    });
    expect(doc._id).toBe("a-1");
    expect(doc.id).toBe("a-1");
    expect(doc.owner_salesperson_id).toBe("sp-1");
  });

  /** An `_id` already on the record never disagrees with its address. */
  it("replaces a stale _id on the record with the storage id", () => {
    const doc = toStoredDoc("a-1", { _id: "something-else", id: "a-1" });
    expect(doc._id).toBe("a-1");
  });

  /** Reading keeps `_id`: the document is the record, key included. */
  it("keeps _id when reading a document back", () => {
    const record = fromStoredDoc({
      _id: "a-1",
      id: "a-1",
      owner_salesperson_id: "sp-1",
    });
    expect(record).toEqual({
      _id: "a-1",
      id: "a-1",
      owner_salesperson_id: "sp-1",
    });
  });

  /** A record survives the store-read roundtrip unchanged, nesting included. */
  it("roundtrips a record with nested data unchanged", () => {
    const original = {
      _id: "s-1",
      id: "s-1",
      owner_salesperson_id: "sp-1",
      step: "intake",
      data: { budget: { amount: 500, label: "sample" }, tags: ["a", "b"] },
    };
    const stored = toStoredDoc("s-1", original);
    const readBack = fromStoredDoc(stored);
    expect(readBack).toEqual(original);
  });
});

describe("AtlasStore surface", () => {
  /**
   * The store offers the full seam — including insert-only `insert`,
   * the tail lookup, and `close` — without connecting: construction
   * alone must never dial the placeholder connection string.
   */
  it("offers insert, last and close without connecting", () => {
    const store = new AtlasStore("unused-in-tests", "sales_memory");
    expect(typeof store.insert).toBe("function");
    expect(typeof store.last).toBe("function");
    expect(typeof store.close).toBe("function");
  });

  /** Closing a store that never connected is a no-op, not an error. */
  it("closes cleanly when it never connected", async () => {
    const store = new AtlasStore("unused-in-tests", "sales_memory");
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });
});

describe("createStore", () => {
  /**
   * A non-empty connection string picks the database store. The value
   * here is a placeholder, not a connection string: building the store
   * must not connect, so nothing ever dials it.
   */
  it("picks the database store when a connection string is present", () => {
    const store = createStore({ MONGODB_URI: "unused-in-tests" });
    expect(store).toBeInstanceOf(AtlasStore);
  });

  /** The dev flag set to exactly "true" allows the in-memory store. */
  it("picks the in-memory store when the dev flag is exactly true", () => {
    expect(createStore({ ALLOW_IN_MEMORY_STORE: "true" })).toBeInstanceOf(
      MemoryStore,
    );
    expect(
      createStore({ MONGODB_URI: "", ALLOW_IN_MEMORY_STORE: "true" }),
    ).toBeInstanceOf(MemoryStore);
  });

  /**
   * With no connection string and no flag, the factory refuses —
   * failing closed is the point, so a deployment missing its secret
   * stops instead of running on memory.
   */
  it("refuses when no connection string is set and no flag allows memory", () => {
    expect(() => createStore(undefined)).toThrow(/refusing/);
    expect(() => createStore({})).toThrow(/refusing/);
    expect(() => createStore({ MONGODB_URI: "" })).toThrow(/refusing/);
    expect(() => createStore({ MONGODB_DB: "sales_memory" })).toThrow(
      /refusing/,
    );
  });

  /** Only the exact string "true" opens the escape hatch. */
  it("refuses for flag values other than exactly true", () => {
    for (const value of ["TRUE", "True", "1", "yes", " true"]) {
      expect(() => createStore({ ALLOW_IN_MEMORY_STORE: value })).toThrow(
        /refusing/,
      );
    }
  });

  /** A connection string wins over the dev flag when both are set. */
  it("prefers the database store when both are set", () => {
    const store = createStore({
      MONGODB_URI: "unused-in-tests",
      ALLOW_IN_MEMORY_STORE: "true",
    });
    expect(store).toBeInstanceOf(AtlasStore);
  });
});
