/**
 * Tests for the database-backed store that can run without a database:
 * the pure record-to-document mapping, and the factory's store choice.
 * Nothing here connects anywhere — live database behaviour is verified
 * at deploy time, when the connection secret exists.
 */

import { describe, expect, it } from "vitest";

import { AtlasStore, fromStoredDoc, toStoredDoc } from "./atlas-store";
import { createStore } from "./factory";
import { MemoryStore } from "./store";

describe("stored document mapping", () => {
  /** Storing adds the record's id as `_key` and keeps every field. */
  it("adds the id as _key when storing", () => {
    const doc = toStoredDoc("a-1", { id: "a-1", ownerId: "sp-1" });
    expect(doc._key).toBe("a-1");
    expect(doc.id).toBe("a-1");
    expect(doc.ownerId).toBe("sp-1");
  });

  /** Reading strips the internal `_id` and `_key` fields back off. */
  it("strips internal fields when reading", () => {
    const record = fromStoredDoc({
      _id: "internal-id",
      _key: "a-1",
      id: "a-1",
      ownerId: "sp-1",
    });
    expect(record).toEqual({ id: "a-1", ownerId: "sp-1" });
  });

  /** A record survives the store-read roundtrip unchanged, nesting included. */
  it("roundtrips a record with nested data unchanged", () => {
    const original = {
      id: "s-1",
      ownerId: "sp-1",
      step: "intake",
      data: { budget: { amount: 500, label: "sample" }, tags: ["a", "b"] },
    };
    const stored = toStoredDoc("s-1", original);
    const readBack = fromStoredDoc({ _id: "internal-id", ...stored });
    expect(readBack).toEqual(original);
  });
});

describe("createStore", () => {
  /** With no environment at all, the factory picks the in-memory store. */
  it("picks the in-memory store when no env is given", () => {
    expect(createStore(undefined)).toBeInstanceOf(MemoryStore);
  });

  /** An env without a connection string still picks the in-memory store. */
  it("picks the in-memory store when the connection string is unset", () => {
    expect(createStore({ MONGODB_DB: "sales_memory" })).toBeInstanceOf(
      MemoryStore,
    );
    expect(createStore({ MONGODB_URI: "" })).toBeInstanceOf(MemoryStore);
  });

  /**
   * A non-empty connection string picks the database store. The value
   * here is a placeholder, not a connection string: building the store
   * must not connect, so nothing ever dials it.
   */
  it("picks the database store when a connection string is present", () => {
    const store = createStore({ MONGODB_URI: "unused-in-tests" });
    expect(store).toBeInstanceOf(AtlasStore);
  });
});
