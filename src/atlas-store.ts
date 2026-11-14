/**
 * Database-backed `Store`: the same seam as the in-memory store, kept in
 * MongoDB Atlas through the official `mongodb` Node driver.
 *
 * Each record lives in a named collection as one document: the record's
 * fields plus a `_key` field holding the caller-chosen id the record is
 * stored under. Reads strip the internal fields (`_id`, `_key`) back off,
 * so callers see exactly the record they put in — the same contract the
 * in-memory store keeps.
 *
 * Connection discipline (per the repo rules): there is no shared client.
 * Every operation opens a fresh `MongoClient`, runs, and closes it in a
 * `finally`, so a client never outlives the work that asked for it.
 * Connection and query errors propagate to the caller: this store never
 * falls back to in-memory data, because a demo that silently stops
 * persisting would be faking the thing it exists to prove.
 */

import { MongoClient, type Db, type Document } from "mongodb";

import type { JsonRecord, Store } from "./store";

/** How long to wait for a database server before failing the operation. */
const SERVER_SELECTION_TIMEOUT_MS = 5000;

/**
 * Turn a record and its id into the document that gets stored.
 * Pure: the record's fields are copied, `_key` is added, and a `_key`
 * field already on the record is replaced by the id it is stored under.
 */
export function toStoredDoc(id: string, record: JsonRecord): Document {
  return { ...record, _key: id };
}

/**
 * Turn a stored document back into the record it came from.
 * Pure: the internal `_id` and `_key` fields are removed; every other
 * field is returned as stored.
 */
export function fromStoredDoc(doc: Document): JsonRecord {
  const { _id, _key, ...record } = doc;
  return record as JsonRecord;
}

/**
 * A `Store` backed by one MongoDB database.
 *
 * The connection string arrives from the caller (in the Worker it is the
 * `MONGODB_URI` secret); this class never reads the environment itself
 * and never logs the string. Constructing the store does not connect —
 * connections happen per operation, inside `withDb`.
 */
export class AtlasStore implements Store {
  /**
   * Wrap a connection string and a database name.
   * No connection is opened here; see the class docs.
   */
  constructor(
    private readonly uri: string,
    private readonly dbName: string,
  ) {}

  /**
   * Run `run` against the database with a fresh client, always closing
   * the client afterwards — including when `run` or the connect throws.
   * The server-selection timeout bounds how long a dead or unreachable
   * cluster can stall an operation before it fails honestly.
   */
  private async withDb<T>(run: (db: Db) => Promise<T>): Promise<T> {
    const client = new MongoClient(this.uri, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    });
    try {
      await client.connect();
      return await run(client.db(this.dbName));
    } finally {
      await client.close();
    }
  }

  /** See `Store.get`. Missing collection or id returns `undefined`. */
  async get(collection: string, id: string): Promise<JsonRecord | undefined> {
    return this.withDb(async (db) => {
      const doc = await db.collection(collection).findOne({ _key: id });
      return doc === null ? undefined : fromStoredDoc(doc);
    });
  }

  /** See `Store.put`. Upserts by `_key`, replacing any prior record. */
  async put(
    collection: string,
    id: string,
    record: JsonRecord,
  ): Promise<void> {
    await this.withDb(async (db) => {
      await db
        .collection(collection)
        .replaceOne({ _key: id }, toStoredDoc(id, record), { upsert: true });
    });
  }

  /**
   * See `Store.list`. Records come back sorted by their stored key, so
   * the order is stable across calls; a missing collection reads empty.
   */
  async list(collection: string): Promise<JsonRecord[]> {
    return this.withDb(async (db) => {
      const docs = await db
        .collection(collection)
        .find({})
        .sort({ _key: 1 })
        .toArray();
      return docs.map((doc) => fromStoredDoc(doc));
    });
  }
}
