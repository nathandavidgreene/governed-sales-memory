/**
 * The memory service: governed remember, recall, forget, and approve.
 *
 * Items live in the "memories" collection, are keyed by `_id`, and
 * belong to exactly one owner, named by `owner_salesperson_id`. The
 * read rule is the point of the service: only the owner can recall an
 * item. Every other answer is one identical generic refusal — the same
 * for a cross-owner read, a forgotten item, and an id that never
 * existed — so an outsider cannot tell whether an item exists at all.
 * A cross-owner attempt is still written to the change log as a
 * "refuse" entry, so the attempt is provable later. Every governed
 * action here appends a change log entry through the `ChangeLog`.
 */

import type { ChangeLog } from "./change-log";
import type { Store } from "./store";

/** A stored memory item. `text` is the content only the owner may read. */
export interface MemoryItem {
  id: string;
  owner_salesperson_id: string;
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
  owner_salesperson_id: string;
  /** Plain-language description of exactly what would change. */
  description: string;
  status: "pending" | "approved";
  /** Who approved it, once approved. */
  approvedBy?: string;
}

/**
 * The one generic refusal. Cross-owner, forgotten, and never-existing
 * ids all produce this exact shape, so nothing about an item — not
 * even whether it exists — leaks to anyone but its owner.
 */
export interface Refusal {
  ok: false;
  error: "not found";
}

/** The single refusal value every failed read, forget, or approve returns. */
const NOT_FOUND: Refusal = { ok: false, error: "not found" };

/** The result of a recall: the item, or the generic refusal. */
export type RecallResult = { ok: true; item: MemoryItem } | Refusal;

/** The result of a forget attempt: done, or the generic refusal. */
export type ForgetResult = { ok: true } | Refusal;

/**
 * The result of an approve attempt: the approval, the generic refusal
 * (unknown id or someone else's approval), or "already decided" —
 * which only the approval's owner can ever be told.
 */
export type ApproveResult =
  | { ok: true; approval: Approval }
  | Refusal
  | { ok: false; error: "already decided" };

/** The collection memory items live in. */
const ITEMS = "memories";

/** The collection pending and decided approvals live in. */
const APPROVALS = "approvals";

/**
 * Governed memory over a `Store`, with every action written to the log.
 * Storage goes only through the `Store` interface, so the backing store
 * can be swapped without changing this service.
 */
export class MemoryService {
  /** Wrap the given store and change log; the service holds no state. */
  constructor(
    private readonly store: Store,
    private readonly log: ChangeLog,
  ) {}

  /**
   * Store an item for `ownerSalespersonId` and append a "remember"
   * change log entry. Generates an id when the caller does not supply
   * one. The entry names the item id only — never its content.
   */
  async remember(
    ownerSalespersonId: string,
    input: MemoryItemInput,
  ): Promise<MemoryItem> {
    const item: MemoryItem = {
      id: input.id ?? globalThis.crypto.randomUUID(),
      owner_salesperson_id: ownerSalespersonId,
      kind: input.kind,
      text: input.text,
    };
    await this.store.put(ITEMS, item.id, { _id: item.id, ...item });
    await this.log.append(
      ownerSalespersonId,
      "remember",
      item.id,
      "Memory item stored.",
    );
    return item;
  }

  /**
   * Read one item back — for its owner only (the read rule).
   * Anyone else gets the one generic refusal, identical to the answer
   * for a missing or forgotten item; a cross-owner attempt on an item
   * that does exist also appends a "refuse" change log entry.
   */
  async recall(requesterId: string, itemId: string): Promise<RecallResult> {
    const raw = await this.store.get(ITEMS, itemId);
    if (raw === undefined || raw.forgotten === true) {
      return NOT_FOUND;
    }
    const { _id: _key, ...rest } = raw;
    const item = rest as unknown as MemoryItem;
    if (item.owner_salesperson_id !== requesterId) {
      await this.log.append(
        requesterId,
        "refuse",
        itemId,
        "Read refused: not the owner.",
      );
      return NOT_FOUND;
    }
    return { ok: true, item };
  }

  /**
   * Forget one item — owner only. The stored content is replaced by a
   * tombstone that keeps just the id and owner, so the content is gone
   * while later reads fail closed instead of guessing. Appends a
   * "forget" change log entry. A non-owner attempt gets the generic
   * refusal, is logged as "refuse", and leaves the item untouched.
   */
  async forget(requesterId: string, itemId: string): Promise<ForgetResult> {
    const raw = await this.store.get(ITEMS, itemId);
    if (raw === undefined || raw.forgotten === true) {
      return NOT_FOUND;
    }
    const item = raw as unknown as MemoryItem;
    if (item.owner_salesperson_id !== requesterId) {
      await this.log.append(
        requesterId,
        "refuse",
        itemId,
        "Forget refused: not the owner.",
      );
      return NOT_FOUND;
    }
    await this.store.put(ITEMS, itemId, {
      _id: itemId,
      id: itemId,
      owner_salesperson_id: item.owner_salesperson_id,
      forgotten: true,
    });
    await this.log.append(requesterId, "forget", itemId, "Memory item forgotten.");
    return { ok: true };
  }

  /**
   * Propose a change for `ownerSalespersonId`: stored as a pending
   * approval that changes nothing until `approve` is called on it.
   * Generates an id when the caller does not supply one.
   */
  async propose(
    ownerSalespersonId: string,
    change: { id?: string; description: string },
  ): Promise<Approval> {
    const approval: Approval = {
      id: change.id ?? globalThis.crypto.randomUUID(),
      owner_salesperson_id: ownerSalespersonId,
      description: change.description,
      status: "pending",
    };
    await this.store.put(APPROVALS, approval.id, {
      _id: approval.id,
      ...approval,
    });
    return approval;
  }

  /**
   * Return the stored approval with this id, or `undefined` when there
   * is none. Read-only: checking a status never changes it.
   */
  async getApproval(approvalId: string): Promise<Approval | undefined> {
    const raw = await this.store.get(APPROVALS, approvalId);
    if (raw === undefined) {
      return undefined;
    }
    const { _id: _key, ...rest } = raw;
    return rest as unknown as Approval;
  }

  /**
   * Approve a pending change — for the approval's owner only — and
   * append an "approve" change log entry naming who decided.
   *
   * Fails closed with the one generic refusal: an unknown id and an
   * approval that belongs to someone else are indistinguishable, and
   * the cross-owner attempt is logged as "refuse". An approval that
   * was already decided returns "already decided", which only its
   * owner can be told — one approval covers one decision, once.
   */
  async approve(
    approverId: string,
    approvalId: string,
  ): Promise<ApproveResult> {
    const approval = await this.getApproval(approvalId);
    if (approval === undefined) {
      return NOT_FOUND;
    }
    if (approval.owner_salesperson_id !== approverId) {
      await this.log.append(
        approverId,
        "refuse",
        approvalId,
        "Approve refused: not the owner.",
      );
      return NOT_FOUND;
    }
    if (approval.status !== "pending") {
      return { ok: false, error: "already decided" };
    }
    const decided: Approval = {
      ...approval,
      status: "approved",
      approvedBy: approverId,
    };
    await this.store.put(APPROVALS, approvalId, {
      _id: approvalId,
      ...decided,
    });
    await this.log.append(
      approverId,
      "approve",
      approvalId,
      "Proposed change approved.",
    );
    return { ok: true, approval: decided };
  }
}
