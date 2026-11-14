/**
 * The outbox: where approved changes are handed to the CRM.
 *
 * This outbox stands in for a CRM; no external system is contacted.
 * Approving a proposal writes exactly one entry here, so what would
 * have been sent onward is inspectable in the store instead of lost.
 * Entries live in the "crm_outbox" collection, are keyed by `_id`, and
 * each one names the approval that produced it and the salesperson who
 * owns the change, `owner_salesperson_id`. Reading the outbox is
 * owner-filtered: a caller only ever sees their own entries.
 */

import type { Store } from "./store";

/** One entry in the outbox: the record of one approved hand-off. */
export interface OutboxEntry {
  id: string;
  /** The approval this entry came from; unique across the outbox. */
  approvalId: string;
  /** The salesperson who owns the approved change. */
  owner_salesperson_id: string;
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
  owner_salesperson_id: string;
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
   * already there for this approval. A failed write propagates to the
   * caller and leaves no entry behind, so the caller can fail closed.
   */
  async writeOnApprove(change: ApprovedChange): Promise<OutboxEntry> {
    const existing = await this.entries();
    const already = existing.find(
      (entry) => entry.approvalId === change.id,
    );
    if (already !== undefined) {
      return already;
    }
    const entry: OutboxEntry = {
      id: globalThis.crypto.randomUUID(),
      approvalId: change.id,
      owner_salesperson_id: change.owner_salesperson_id,
      summary: change.description,
      at: new Date().toISOString(),
    };
    if (change.accountId !== undefined) {
      entry.accountId = change.accountId;
    }
    await this.store.put(OUTBOX, entry.id, { _id: entry.id, ...entry });
    return entry;
  }

  /**
   * Return one salesperson's entries in the outbox, oldest first.
   * The owner filter is the point: entries belonging to anyone else
   * are never returned, so one salesperson's hand-offs cannot be read
   * through another's view. An owner with no entries gets an empty
   * list.
   */
  async list(ownerSalespersonId: string): Promise<OutboxEntry[]> {
    const all = await this.entries();
    return all.filter(
      (entry) => entry.owner_salesperson_id === ownerSalespersonId,
    );
  }

  /**
   * Return every entry in the outbox, oldest first, with the stored
   * `_id` key stripped. Internal: the idempotency scan in
   * `writeOnApprove` needs the whole outbox; outside callers use the
   * owner-filtered `list`.
   */
  private async entries(): Promise<OutboxEntry[]> {
    const raw = await this.store.list(OUTBOX);
    return raw.map((record) => {
      const { _id: _key, ...rest } = record;
      return rest as unknown as OutboxEntry;
    });
  }
}
