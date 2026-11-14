/**
 * The change log: an append-only, hash-chained log of what happened.
 *
 * Every governed action (remember, refuse, forget, approve) appends one
 * entry. Each entry links to the entry before it by `previous_id` and
 * carries the SHA-256 hash of its own canonical form, so changing any
 * earlier entry breaks that entry's hash and `verify` can name the first
 * entry that no longer checks out. Entries live in the "change_log"
 * collection and are keyed by `_id`, which is also their sequence:
 * "1", "2", "3", and so on, never reused. The first entry's
 * `previous_id` is the literal string "GENESIS".
 *
 * Appends are insert-only. `append` never updates or replaces an entry:
 * it computes the next `_id` and inserts a brand-new entry, so a second
 * writer racing the same `_id` fails instead of forking the chain. The
 * database-backed store must back this with `insertOne` plus a unique
 * index on `_id` — no upsert path — to keep the same guarantee.
 */

import type { Store } from "./store";

/** One immutable entry in the change log. */
export interface ChangeLogEntry {
  /** The entry's key and sequence: "1", "2", "3", …, never reused. */
  _id: string;
  /** ISO 8601 timestamp of when the action happened. */
  at: string;
  /** Who did the action (a salesperson id, or "system"). */
  actor: string;
  /** What happened, in plain words: remember, refuse, forget, approve. */
  action: string;
  /** What the action was about (an item or approval id, never content). */
  subject: string;
  /** Plain-language note about the action. Never carries item content. */
  detail: string;
  /** The `_id` of the previous entry, or "GENESIS" on the first entry. */
  previous_id: string;
  /** SHA-256 hex of this entry's canonical form, without this field. */
  hash: string;
}

/** The outcome of checking the whole chain. */
export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; brokenId: string };

/** The collection the change log lives in. */
const CHANGE_LOG = "change_log";

/** The previous_id of the first entry, before anything exists to point at. */
const GENESIS = "GENESIS";

/** How many times one append retries when another writer wins the race. */
const MAX_APPEND_ATTEMPTS = 3;

/**
 * The canonical JSON of an entry without its hash.
 *
 * Keys are written in one fixed order so the same entry always produces
 * the same string — and therefore the same hash — on any runtime.
 */
function canonicalJson(entry: Omit<ChangeLogEntry, "hash">): string {
  return JSON.stringify({
    _id: entry._id,
    at: entry.at,
    actor: entry.actor,
    action: entry.action,
    subject: entry.subject,
    detail: entry.detail,
    previous_id: entry.previous_id,
  });
}

/**
 * Hash one entry-without-a-hash: SHA-256 hex of its canonical JSON.
 * Uses WebCrypto, which Workers and current Node both provide.
 */
async function hashEntry(entry: Omit<ChangeLogEntry, "hash">): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(entry));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * An append-only, hash-chained change log over a `Store`.
 *
 * There is deliberately no edit or delete: the only way in is `append`,
 * and the only way to trust what comes out is `verify`. Appends through
 * one instance are serialized on a promise queue, so the sequence is
 * assigned atomically in-process even under concurrent requests.
 */
export class ChangeLog {
  /** Tail of the append queue; each append chains onto the last one. */
  private appendQueue: Promise<void> = Promise.resolve();

  /** Wrap the given store; the log keeps no entry state of its own. */
  constructor(private readonly store: Store) {}

  /**
   * Return every entry in chain order (by numeric `_id`).
   * An empty log returns an empty list.
   */
  async entries(): Promise<ChangeLogEntry[]> {
    const raw = await this.store.list(CHANGE_LOG);
    return (raw as unknown as ChangeLogEntry[])
      .slice()
      .sort((a, b) => Number(a._id) - Number(b._id));
  }

  /**
   * Append one entry for an action and return it, hash included.
   *
   * The append runs inside this instance's queue, so two appends at
   * once cannot read the same tail and fork the chain. The entry itself
   * is written with the store's insert-only operation: if another
   * writer sharing the store took the `_id` first, the insert fails and
   * the append retries from the new tail instead of overwriting.
   */
  async append(
    actor: string,
    action: string,
    subject: string,
    detail: string,
  ): Promise<ChangeLogEntry> {
    const run = this.appendQueue.then(() =>
      this.appendNow(actor, action, subject, detail),
    );
    this.appendQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The append itself, run one at a time by the queue.
   * Chains onto the current last entry, or onto "GENESIS" when the log
   * is empty. Side effect: one insert into the store, never an update.
   */
  private async appendNow(
    actor: string,
    action: string,
    subject: string,
    detail: string,
  ): Promise<ChangeLogEntry> {
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
      const existing = await this.entries();
      const last = existing[existing.length - 1];
      const unsigned: Omit<ChangeLogEntry, "hash"> = {
        _id: last === undefined ? "1" : String(Number(last._id) + 1),
        at: new Date().toISOString(),
        actor,
        action,
        subject,
        detail,
        previous_id: last === undefined ? GENESIS : last._id,
      };
      const entry: ChangeLogEntry = {
        ...unsigned,
        hash: await hashEntry(unsigned),
      };
      try {
        await this.store.insert(CHANGE_LOG, entry._id, { ...entry });
        return entry;
      } catch {
        // Another writer inserted this _id first; retry from the new tail.
        if (attempt === MAX_APPEND_ATTEMPTS) {
          throw new Error("change log append kept losing the race");
        }
      }
    }
    throw new Error("change log append failed");
  }

  /**
   * Recompute the whole chain and report whether it still holds.
   * Returns ok with the entry count, or the `_id` of the first entry
   * whose stored hash or `previous_id` link does not recompute — which
   * is also where a removed or reordered entry first shows up.
   */
  async verify(): Promise<VerifyResult> {
    const entries = await this.entries();
    let previous_id = GENESIS;
    for (const [index, entry] of entries.entries()) {
      if (entry._id !== String(index + 1) || entry.previous_id !== previous_id) {
        return { ok: false, brokenId: entry._id };
      }
      const { hash, ...unsigned } = entry;
      if ((await hashEntry(unsigned)) !== hash) {
        return { ok: false, brokenId: entry._id };
      }
      previous_id = entry._id;
    }
    return { ok: true, count: entries.length };
  }
}
