/**
 * The memory service: governed remember, recall, correct, forget, and
 * approve.
 *
 * Items live in the "memory_items" collection and belong to exactly one
 * owner. The read rule is the point of the service: only the owner can
 * recall an item. A read by anyone else is refused with a generic answer
 * that leaks nothing about the item — and the refusal itself is written
 * to the record log, so the attempt is provable later. Correcting an
 * item follows the same rule and keeps the previous value in the item's
 * own history. Every governed action here appends a record entry
 * through the `RecordLog`, and approving a proposal also hands it to
 * the outbox (see `Outbox`, the stand-in for a CRM).
 */

import { Outbox } from "./outbox";
import type { RecordLog } from "./record";
import type { Store } from "./store";

/**
 * One correction made to a memory item: which field changed and what it
 * held before. The previous value stays on the item itself, so the
 * item carries its own history; the record log names the field only.
 */
export interface Correction {
  field: string;
  /** The value the field held before this correction. */
  previous: unknown;
  /** ISO 8601 timestamp of when the correction was made. */
  at: string;
}

/** A stored memory item. `text` is the content only the owner may read. */
export interface MemoryItem {
  id: string;
  ownerId: string;
  /** Plain-word category, for example "note" or "preference". */
  kind: string;
  text: string;
  /** ISO 8601 timestamp of the most recent correction, once corrected. */
  correctedAt?: string;
  /** Every correction made to this item, oldest first. */
  history?: Correction[];
}

/** What a caller hands to `remember`; the service stamps the owner on it. */
export interface MemoryItemInput {
  id?: string;
  kind: string;
  text: string;
}

/** A proposed change waiting for an explicit approval. */
export interface Approval {
  id: string;
  ownerId: string;
  /** Plain-language description of exactly what would change. */
  description: string;
  /** The account the change is about, when it is about one. */
  accountId?: string;
  status: "pending" | "approved";
  /** Who approved it, once approved. */
  approvedBy?: string;
}

/** The result of a recall: the item, or a generic refusal. */
export type RecallResult =
  | { ok: true; item: MemoryItem }
  | { ok: false; error: "not yours" | "not found" };

/** The result of a forget attempt: done, or a generic refusal. */
export type ForgetResult =
  | { ok: true }
  | { ok: false; error: "not yours" | "not found" };

/** The result of an approve attempt: the approval, or a fail-closed error. */
export type ApproveResult =
  | { ok: true; approval: Approval }
  | { ok: false; error: "unknown approval" | "already decided" };

/** The result of a correct attempt: the item, or a fail-closed error. */
export type CorrectResult =
  | { ok: true; item: MemoryItem }
  | { ok: false; error: "not yours" | "not found" | "not correctable" };

/** The collection memory items live in. */
const ITEMS = "memory_items";

/** The collection pending and decided approvals live in. */
const APPROVALS = "approvals";

/**
 * Governed memory over a `Store`, with every action written to the log.
 * Storage goes only through the `Store` interface, so the backing store
 * can be swapped without changing this service.
 */
export class MemoryService {
  /** The outbox approvals are handed to; built over the same store. */
  private readonly outbox: Outbox;

  /** Wrap the given store and record log; the service holds no state. */
  constructor(
    private readonly store: Store,
    private readonly log: RecordLog,
  ) {
    this.outbox = new Outbox(store);
  }

  /**
   * Store an item for `ownerId` and append a "remember" record entry.
   * Generates an id when the caller does not supply one. The record
   * entry names the item id only — never its content.
   */
  async remember(ownerId: string, input: MemoryItemInput): Promise<MemoryItem> {
    const item: MemoryItem = {
      id: input.id ?? globalThis.crypto.randomUUID(),
      ownerId,
      kind: input.kind,
      text: input.text,
    };
    await this.store.put(ITEMS, item.id, { ...item });
    await this.log.append(ownerId, "remember", item.id, "Memory item stored.");
    return item;
  }

  /**
   * Read one item back — for its owner only (the read rule).
   * A read by anyone else appends a "refuse" record entry with a generic
   * detail and returns `{ ok: false, error: "not yours" }`, revealing
   * nothing about the item. A missing or forgotten item fails closed
   * with "not found".
   */
  async recall(requesterId: string, itemId: string): Promise<RecallResult> {
    const raw = await this.store.get(ITEMS, itemId);
    if (raw === undefined || raw.forgotten === true) {
      return { ok: false, error: "not found" };
    }
    const item = raw as unknown as MemoryItem;
    if (item.ownerId !== requesterId) {
      await this.log.append(
        requesterId,
        "refuse",
        itemId,
        "Read refused: not the owner.",
      );
      return { ok: false, error: "not yours" };
    }
    return { ok: true, item };
  }

  /**
   * Forget one item — owner only. The stored content is replaced by a
   * tombstone that keeps just the id and owner, so the content is gone
   * while later reads fail closed instead of guessing. Appends a
   * "forget" record entry. A non-owner attempt is refused the generic
   * way and logged as "refuse"; the item is left untouched.
   */
  async forget(requesterId: string, itemId: string): Promise<ForgetResult> {
    const raw = await this.store.get(ITEMS, itemId);
    if (raw === undefined || raw.forgotten === true) {
      return { ok: false, error: "not found" };
    }
    const item = raw as unknown as MemoryItem;
    if (item.ownerId !== requesterId) {
      await this.log.append(
        requesterId,
        "refuse",
        itemId,
        "Forget refused: not the owner.",
      );
      return { ok: false, error: "not yours" };
    }
    await this.store.put(ITEMS, itemId, {
      id: itemId,
      ownerId: item.ownerId,
      forgotten: true,
    });
    await this.log.append(requesterId, "forget", itemId, "Memory item forgotten.");
    return { ok: true };
  }

  /**
   * Propose a change for `ownerId`: stored as a pending approval that
   * changes nothing until `approve` is called on it. Generates an id
   * when the caller does not supply one. A proposal may name the
   * account it is about; that account id rides along to the outbox
   * entry when the proposal is approved.
   */
  async propose(
    ownerId: string,
    change: { id?: string; description: string; accountId?: string },
  ): Promise<Approval> {
    const approval: Approval = {
      id: change.id ?? globalThis.crypto.randomUUID(),
      ownerId,
      description: change.description,
      status: "pending",
    };
    if (change.accountId !== undefined) {
      approval.accountId = change.accountId;
    }
    await this.store.put(APPROVALS, approval.id, { ...approval });
    return approval;
  }

  /**
   * Return the stored approval with this id, or `undefined` when there
   * is none. Read-only: checking a status never changes it.
   */
  async getApproval(approvalId: string): Promise<Approval | undefined> {
    const raw = await this.store.get(APPROVALS, approvalId);
    return raw === undefined ? undefined : (raw as unknown as Approval);
  }

  /**
   * Approve a pending change, append an "approve" record entry naming
   * who decided, and write the change to the outbox — the hand-off
   * point that stands in for a CRM. Fails closed: an unknown id returns
   * "unknown approval", and an approval that was already decided
   * returns "already decided" — one approval covers one decision, once,
   * and the outbox write is idempotent, so a decided approval can never
   * produce a second outbox entry.
   */
  async approve(
    approverId: string,
    approvalId: string,
  ): Promise<ApproveResult> {
    const approval = await this.getApproval(approvalId);
    if (approval === undefined) {
      return { ok: false, error: "unknown approval" };
    }
    if (approval.status !== "pending") {
      return { ok: false, error: "already decided" };
    }
    const decided: Approval = {
      ...approval,
      status: "approved",
      approvedBy: approverId,
    };
    await this.store.put(APPROVALS, approvalId, { ...decided });
    await this.log.append(
      approverId,
      "approve",
      approvalId,
      "Proposed change approved.",
    );
    await this.outbox.writeOnApprove(decided);
    return { ok: true, approval: decided };
  }

  /**
   * Correct one field of one item — owner only.
   * The new value replaces the field; the value it held goes into the
   * item's `history`, and the item is stamped with `correctedAt`. The
   * "correct" record entry names the field only — never the old or new
   * value — so the log proves a correction happened without carrying
   * content. The identity fields (`id`, `ownerId`) and the history
   * itself are not correctable and fail closed as "not correctable".
   * A non-owner attempt is refused the generic way, logged as "refuse",
   * and the item is left untouched; a missing or forgotten item fails
   * closed as "not found".
   */
  async correct(
    requesterId: string,
    itemId: string,
    field: string,
    value: unknown,
  ): Promise<CorrectResult> {
    const raw = await this.store.get(ITEMS, itemId);
    if (raw === undefined || raw.forgotten === true) {
      return { ok: false, error: "not found" };
    }
    const item = raw as unknown as MemoryItem & Record<string, unknown>;
    if (item.ownerId !== requesterId) {
      await this.log.append(
        requesterId,
        "refuse",
        itemId,
        "Correct refused: not the owner.",
      );
      return { ok: false, error: "not yours" };
    }
    if (field === "id" || field === "ownerId" || field === "history") {
      return { ok: false, error: "not correctable" };
    }
    const at = new Date().toISOString();
    const corrected: MemoryItem & Record<string, unknown> = {
      ...item,
      [field]: value,
      correctedAt: at,
      history: [
        ...(item.history ?? []),
        { field, previous: item[field], at },
      ],
    };
    await this.store.put(ITEMS, itemId, { ...corrected });
    await this.log.append(
      requesterId,
      "correct",
      itemId,
      `Field "${field}" corrected.`,
    );
    return { ok: true, item: corrected };
  }
}
