/**
 * The memory service: governed remember, recall, forget, and approve.
 *
 * Items live in the "memory_items" collection and belong to exactly one
 * owner. The read rule is the point of the service: only the owner can
 * recall an item. A read by anyone else is refused with a generic answer
 * that leaks nothing about the item — and the refusal itself is written
 * to the record log, so the attempt is provable later. Every governed
 * action here appends a record entry through the `RecordLog`.
 */

import type { RecordLog } from "./record";
import type { Store } from "./store";

/** A stored memory item. `text` is the content only the owner may read. */
export interface MemoryItem {
  id: string;
  ownerId: string;
  /** Plain-word category, for example "note" or "preference". */
  kind: string;
  text: string;
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
  /** Wrap the given store and record log; the service holds no state. */
  constructor(
    private readonly store: Store,
    private readonly log: RecordLog,
  ) {}

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
   * when the caller does not supply one.
   */
  async propose(
    ownerId: string,
    change: { id?: string; description: string },
  ): Promise<Approval> {
    const approval: Approval = {
      id: change.id ?? globalThis.crypto.randomUUID(),
      ownerId,
      description: change.description,
      status: "pending",
    };
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
   * Approve a pending change and append an "approve" record entry
   * naming who decided. Fails closed: an unknown id returns "unknown
   * approval", and an approval that was already decided returns
   * "already decided" — one approval covers one decision, once.
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
    return { ok: true, approval: decided };
  }
}
