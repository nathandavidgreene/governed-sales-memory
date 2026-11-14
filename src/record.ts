/**
 * The record: an append-only, hash-chained log of what happened.
 *
 * Every governed action (remember, refuse, forget, approve) appends one
 * entry. Each entry carries the hash of the entry before it, so changing
 * any earlier entry breaks every later link and `verify` can name the
 * first entry that no longer checks out. Entries are stored through the
 * `Store` seam, in the "records" collection, keyed by their sequence
 * number. The first entry's `prevHash` is the literal string "GENESIS".
 */

import type { Store } from "./store";

/** One immutable entry in the record log. */
export interface RecordEntry {
  /** Position in the chain, starting at 1 and never reused. */
  seq: number;
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
  /** Hash of the previous entry, or "GENESIS" on the first entry. */
  prevHash: string;
  /** SHA-256 hex of this entry's canonical form, without this field. */
  hash: string;
}

/** The outcome of checking the whole chain. */
export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; brokenSeq: number };

/** The collection the record log lives in. */
const RECORDS = "records";

/** The prevHash of the first entry, before anything exists to point at. */
const GENESIS = "GENESIS";

/**
 * The canonical JSON of an entry without its hash.
 *
 * Keys are written in one fixed order so the same entry always produces
 * the same string — and therefore the same hash — on any runtime.
 */
function canonicalJson(entry: Omit<RecordEntry, "hash">): string {
  return JSON.stringify({
    seq: entry.seq,
    at: entry.at,
    actor: entry.actor,
    action: entry.action,
    subject: entry.subject,
    detail: entry.detail,
    prevHash: entry.prevHash,
  });
}

/**
 * Hash one entry-without-a-hash: SHA-256 hex of its canonical JSON.
 * Uses WebCrypto, which Workers and current Node both provide.
 */
async function hashEntry(entry: Omit<RecordEntry, "hash">): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(entry));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * An append-only, hash-chained record log over a `Store`.
 *
 * There is deliberately no edit or delete: the only way in is `append`,
 * and the only way to trust what comes out is `verify`.
 */
export class RecordLog {
  /** Wrap the given store; the log keeps no state of its own. */
  constructor(private readonly store: Store) {}

  /**
   * Return every entry in chain order (by `seq`).
   * An empty log returns an empty list.
   */
  async entries(): Promise<RecordEntry[]> {
    const raw = await this.store.list(RECORDS);
    return (raw as unknown as RecordEntry[])
      .slice()
      .sort((a, b) => a.seq - b.seq);
  }

  /**
   * Append one entry for an action and return it, hash included.
   * The entry is chained onto the current last entry, or onto "GENESIS"
   * when the log is empty. Side effect: one `put` into the store.
   */
  async append(
    actor: string,
    action: string,
    subject: string,
    detail: string,
  ): Promise<RecordEntry> {
    const existing = await this.entries();
    const last = existing[existing.length - 1];
    const unsigned: Omit<RecordEntry, "hash"> = {
      seq: last === undefined ? 1 : last.seq + 1,
      at: new Date().toISOString(),
      actor,
      action,
      subject,
      detail,
      prevHash: last === undefined ? GENESIS : last.hash,
    };
    const entry: RecordEntry = { ...unsigned, hash: await hashEntry(unsigned) };
    await this.store.put(RECORDS, String(entry.seq), { ...entry });
    return entry;
  }

  /**
   * Recompute the whole chain and report whether it still holds.
   * Returns ok with the entry count, or the `seq` of the first entry
   * whose stored hash or `prevHash` link does not recompute — which is
   * also where a removed or reordered entry first shows up.
   */
  async verify(): Promise<VerifyResult> {
    const entries = await this.entries();
    let prevHash = GENESIS;
    for (const [index, entry] of entries.entries()) {
      if (entry.seq !== index + 1 || entry.prevHash !== prevHash) {
        return { ok: false, brokenSeq: entry.seq };
      }
      const { hash, ...unsigned } = entry;
      if ((await hashEntry(unsigned)) !== hash) {
        return { ok: false, brokenSeq: entry.seq };
      }
      prevHash = entry.hash;
    }
    return { ok: true, count: entries.length };
  }
}
