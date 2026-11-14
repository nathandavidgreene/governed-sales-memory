/**
 * The outbox: where approved changes are handed to the CRM.
 *
 * This outbox stands in for a CRM; no external system is contacted.
 * Approving a proposal writes exactly one entry here, so what would
 * have been sent onward is inspectable in the store instead of lost.
 * Entries live in the "crm_outbox" collection, keyed by entry id, and
 * each one names the approval that produced it.
 */

import type { Store } from "./store";

/** One entry in the outbox: the record of one approved hand-off. */
export interface OutboxEntry {
  id: string;
  /** The approval this entry came from; unique across the outbox. */
  approvalId: string;
  /** The salesperson who owns the approved change. */
  ownerId: string;
  /** The account the change was about, when the proposal carried one. */
  accountId?: string;
  /** Plain-language summary of the approved change. */
  summary: string;
  /** ISO 8601 timestamp of when the entry was written. */
  at: string;
}

/** The fields of an approved change the outbox needs to write an entry. */
export interface ApprovedChange {
  id: string;
  ownerId: string;
  accountId?: string;
  description: string;
}

/** The collection outbox entries live in. */
const OUTBOX = "crm_outbox";

/**
 * The fake-CRM outbox over a `Store`.
 *
 * Writing is idempotent per approval: one approval produces one entry,
 * however many times the write is attempted, so a repeated approval can
 * never send the same change onward twice.
 */
export class Outbox {
  /** Wrap the given store; the outbox keeps no state of its own. */
  constructor(private readonly store: Store) {}

  /**
   * Write the entry for one approved change, unless one already exists.
   * Returns the entry — the newly written one, or the one that was
   * already there for this approval.
   */
  async writeOnApprove(change: ApprovedChange): Promise<OutboxEntry> {
    const existing = await this.list();
    const already = existing.find(
      (entry) => entry.approvalId === change.id,
    );
    if (already !== undefined) {
      return already;
    }
    const entry: OutboxEntry = {
      id: globalThis.crypto.randomUUID(),
      approvalId: change.id,
      ownerId: change.ownerId,
      summary: change.description,
      at: new Date().toISOString(),
    };
    if (change.accountId !== undefined) {
      entry.accountId = change.accountId;
    }
    await this.store.put(OUTBOX, entry.id, { ...entry });
    return entry;
  }

  /**
   * Return every entry in the outbox, oldest first.
   * An untouched outbox returns an empty list.
   */
  async list(): Promise<OutboxEntry[]> {
    const raw = await this.store.list(OUTBOX);
    return raw as unknown as OutboxEntry[];
  }
}
