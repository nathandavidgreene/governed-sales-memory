/**
 * Storage seam for the app.
 *
 * Everything that reads or writes data goes through the `Store` interface,
 * so the in-memory implementation used by the skeleton can later be swapped
 * for a database-backed one without changing any caller.
 */

/** A single stored record: plain JSON data keyed by string field names. */
export type JsonRecord = Record<string, unknown>;

/**
 * A store over named collections of JSON records.
 *
 * Records are addressed by a caller-chosen string id inside a named
 * collection (for example the "accounts" collection). Reads of a missing
 * collection or id report "not there" instead of guessing a default.
 */
export interface Store {
  /**
   * Return the record stored under `id` in `collection`.
   * Returns `undefined` when the collection or the id does not exist.
   */
  get(collection: string, id: string): Promise<JsonRecord | undefined>;

  /**
   * Store `record` under `id` in `collection`, replacing any record that
   * was there before. The store keeps its own copy, so later edits to the
   * caller's object do not leak into stored state.
   */
  put(collection: string, id: string, record: JsonRecord): Promise<void>;

  /**
   * Insert `record` under `id` in `collection` only when that id is
   * still unused; rejects when a record already exists there. This is
   * the insert-only write the change log's append is built on: the
   * database-backed store implements it with `insertOne` and a unique
   * index on the key, so a racing writer fails instead of overwriting.
   */
  insert(collection: string, id: string, record: JsonRecord): Promise<void>;

  /**
   * Return every record in `collection`, in insertion order.
   * Returns an empty list when the collection does not exist.
   */
  list(collection: string): Promise<JsonRecord[]>;

  /**
   * Return the most recently inserted record in `collection`, or
   * `undefined` when the collection is empty or does not exist.
   * Optional: stores that can answer cheaply provide it so hot paths
   * (the change log's append) do not have to list a whole collection
   * just to find its tail.
   */
  last?(collection: string): Promise<JsonRecord | undefined>;

  /**
   * Release any resources the store holds (connections, clients).
   * Optional: stores with nothing to release omit it. Callers close a
   * store when the work that created it — one request — is finished.
   */
  close?(): Promise<void>;
}

/**
 * In-memory `Store` backed by plain maps.
 *
 * State lives only as long as the object does and is never shared between
 * instances, which makes it safe for per-request use and for tests. It is
 * the skeleton's stand-in until the database-backed store lands.
 */
export class MemoryStore implements Store {
  /** Collections by name; each maps record ids to records. */
  private readonly collections = new Map<string, Map<string, JsonRecord>>();

  /** See `Store.get`. Returned records are copies, not live references. */
  async get(collection: string, id: string): Promise<JsonRecord | undefined> {
    const record = this.collections.get(collection)?.get(id);
    return record === undefined ? undefined : { ...record };
  }

  /** See `Store.put`. */
  async put(
    collection: string,
    id: string,
    record: JsonRecord,
  ): Promise<void> {
    let bucket = this.collections.get(collection);
    if (bucket === undefined) {
      bucket = new Map<string, JsonRecord>();
      this.collections.set(collection, bucket);
    }
    bucket.set(id, { ...record });
  }

  /**
   * See `Store.insert`. Rejects when the id is already taken, leaving
   * the stored record untouched.
   */
  async insert(
    collection: string,
    id: string,
    record: JsonRecord,
  ): Promise<void> {
    let bucket = this.collections.get(collection);
    if (bucket === undefined) {
      bucket = new Map<string, JsonRecord>();
      this.collections.set(collection, bucket);
    }
    if (bucket.has(id)) {
      throw new Error(`duplicate key "${id}" in collection "${collection}"`);
    }
    bucket.set(id, { ...record });
  }

  /** See `Store.list`. Returned records are copies, not live references. */
  async list(collection: string): Promise<JsonRecord[]> {
    const bucket = this.collections.get(collection);
    if (bucket === undefined) {
      return [];
    }
    return [...bucket.values()].map((record) => ({ ...record }));
  }

  /**
   * See `Store.last`. The in-memory store keeps insertion order, so
   * the tail is simply the most recently stored record. The returned
   * record is a copy, not a live reference.
   */
  async last(collection: string): Promise<JsonRecord | undefined> {
    const bucket = this.collections.get(collection);
    if (bucket === undefined || bucket.size === 0) {
      return undefined;
    }
    const records = [...bucket.values()];
    return { ...records[records.length - 1] };
  }
}
