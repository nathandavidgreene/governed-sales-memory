/**
 * Database-backed `Store`: the seam the in-memory store defines, kept
 * in MongoDB Atlas through the official `mongodb` Node driver.
 *
 * Each record lives in a named collection as one document, and the
 * document IS the record: its key is the document's `_id`, exactly as
 * the seeded data is keyed. There is no parallel key field — reads look
 * documents up by `_id`, and what comes back is the record as stored,
 * `_id` included, just as the in-memory store returns it.
 *
 * Connection discipline (per the repo rules): one store instance holds
 * at most one `MongoClient`, connected lazily on first use and reused
 * for the life of the instance. A store is created per request and the
 * request wiring calls `close()` when the request finishes, so a
 * client never outlives the request that asked for it — and no
 * operation opens a client of its own. Connection and query errors
 * propagate to the caller: this store never falls back to in-memory
 * data, because an app that silently stops persisting would be faking
 * the thing it exists to prove.
 */

import { MongoClient, type Db, type Document } from "mongodb";

import type { JsonRecord, Store } from "./store";

/** How long to wait for a database server before failing an operation. */
const SERVER_SELECTION_TIMEOUT_MS = 5000;

/** The MongoDB duplicate-key error code, raised by a taken `_id`. */
const DUPLICATE_KEY_CODE = 11000;

/**
 * Turn a record and its id into the document that gets stored.
 * Pure: the record's fields are copied and `_id` is set to the id the
 * record is stored under — an `_id` already on the record is replaced
 * by that id, so the stored key always matches the address it was
 * written to.
 */
export function toStoredDoc(
  id: string,
  record: JsonRecord,
): JsonRecord & { _id: string } {
  return { ...record, _id: id };
}

/**
 * Turn a stored document back into the record it came from.
 * Pure: the document is the record, so this is just a copy — `_id`
 * stays, because callers address and read records by it.
 */
export function fromStoredDoc(doc: Document): JsonRecord {
  return { ...doc } as JsonRecord;
}

/**
 * A `Store` backed by one MongoDB database.
 *
 * The connection string arrives from the caller (in the Worker it is
 * the `MONGODB_URI` secret); this class never reads the environment
 * itself and never logs the string. Constructing the store does not
 * connect — the single client connects on first use, inside `db()`.
 */
export class AtlasStore implements Store {
  /** The one client this instance may open; unset until first use. */
  private client: MongoClient | undefined;

  /** The connected database handle, once the client has connected. */
  private database: Db | undefined;

  /**
   * Wrap a connection string and a database name.
   * No connection is opened here; see the class docs.
   */
  constructor(
    private readonly uri: string,
    private readonly dbName: string,
  ) {}

  /**
   * Return this instance's database handle, connecting its one client
   * on first use. Concurrent first uses share the single connect: the
   * client object is created synchronously and only ever replaced by
   * `close()`, never duplicated.
   */
  private async db(): Promise<Db> {
    if (this.database !== undefined) {
      return this.database;
    }
    if (this.client === undefined) {
      this.client = new MongoClient(this.uri, {
        serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
      });
    }
    await this.client.connect();
    this.database = this.client.db(this.dbName);
    return this.database;
  }

  /**
   * Close the instance's client, if it ever connected, and forget it.
   * Safe to call more than once, and on a store that never connected.
   * The request wiring calls this when the request finishes.
   */
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.database = undefined;
    if (client !== undefined) {
      await client.close();
    }
  }

  /**
   * The named collection, typed with this app's record shape so `_id`
   * filters and documents are plain JSON values rather than the
   * driver's default document typing.
   */
  private async collection(name: string) {
    const db = await this.db();
    return db.collection<JsonRecord & { _id: string }>(name);
  }

  /** See `Store.get`. Missing collection or id returns `undefined`. */
  async get(collection: string, id: string): Promise<JsonRecord | undefined> {
    const coll = await this.collection(collection);
    const doc = await coll.findOne({ _id: id });
    return doc === null ? undefined : fromStoredDoc(doc);
  }

  /** See `Store.put`. Upserts by `_id`, replacing any prior record. */
  async put(
    collection: string,
    id: string,
    record: JsonRecord,
  ): Promise<void> {
    const coll = await this.collection(collection);
    await coll.replaceOne({ _id: id }, toStoredDoc(id, record), {
      upsert: true,
    });
  }

  /**
   * See `Store.insert`. Insert-only, via `insertOne`: a taken `_id`
   * rejects with the same duplicate-key error the in-memory store
   * raises, and the stored record is left untouched. There is
   * deliberately no upsert path here — the change log's append depends
   * on a racing writer failing instead of overwriting.
   */
  async insert(
    collection: string,
    id: string,
    record: JsonRecord,
  ): Promise<void> {
    const coll = await this.collection(collection);
    try {
      await coll.insertOne(toStoredDoc(id, record));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === DUPLICATE_KEY_CODE
      ) {
        throw new Error(
          `duplicate key "${id}" in collection "${collection}"`,
        );
      }
      throw error;
    }
  }

  /**
   * See `Store.list`. Records come back in the order they were stored
   * (the collection's natural order); a missing collection reads empty.
   */
  async list(collection: string): Promise<JsonRecord[]> {
    const coll = await this.collection(collection);
    const docs = await coll.find({}).toArray();
    return docs.map((doc) => fromStoredDoc(doc));
  }

  /**
   * See `Store.last`. A single sorted query — newest stored document
   * first, limit one — so a caller finding a collection's tail never
   * reads the whole collection to do it. Returns `undefined` when the
   * collection is empty or does not exist.
   */
  async last(collection: string): Promise<JsonRecord | undefined> {
    const coll = await this.collection(collection);
    const docs = await coll
      .find({})
      .sort({ $natural: -1 })
      .limit(1)
      .toArray();
    return docs.length === 0 ? undefined : fromStoredDoc(docs[0]);
  }
}
