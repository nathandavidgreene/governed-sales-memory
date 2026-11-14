/**
 * The memory service: governed remember, recall, forget, correct, and
 * approve.
 *
 * Items live in the "memories" collection, are keyed by `_id`, and
 * belong to exactly one owner, named by `owner_salesperson_id`. The
 * read rule is the point of the service: only the owner can recall an
 * item. Every other answer is one identical generic refusal — the same
 * for a cross-owner read, a forgotten item, and an id that never
 * existed — so an outsider cannot tell whether an item exists at all.
 * A cross-owner attempt is still written to the change log as a
 * "refuse" entry, so the attempt is provable later. Correcting an item
 * follows the same rule, keeps the previous value in the item's own
 * history, and may touch only the `text` and `kind` fields. Proposing
 * a change against an account checks the same ownership rule against
 * the account. Approving a proposal also hands it to the outbox (see
 * `Outbox`, the stand-in for a CRM) — the outbox entry is written
 * first, so a failed write leaves the approval pending instead of
 * decided-but-never-handed-off. Every governed action here appends a
 * change log entry through the `ChangeLog`.
 */

import type { ChangeLog } from "./change-log";
import { Outbox } from "./outbox";
import type { Store } from "./store";

/**
 * One correction made to a memory item: which field changed and what it
 * held before. The previous value stays on the item itself, so the
 * item carries its own history; the change log names the field only.
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
  owner_salesperson_id: string;
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
  owner_salesperson_id: string;
  /** Plain-language description of exactly what would change. */
  description: string;
  /** The account the change is about, when it is about one. */
  accountId?: string;
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

/** The result of a propose attempt: the approval, or the generic refusal. */
export type ProposeResult = { ok: true; approval: Approval } | Refusal;

/** The result of a correct attempt: the item, or the generic refusal. */
export type CorrectResult = { ok: true; item: MemoryItem } | Refusal;

/**
 * The result of an approve attempt: the approval, the generic refusal
 * (unknown id or someone else's approval), "already decided" — which
 * only the approval's owner can ever be told — or "outbox write
 * failed", which means nothing was decided and the approval is still
 * pending, safe to approve again.
 */
export type ApproveResult =
  | { ok: true; approval: Approval }
  | Refusal
  | { ok: false; error: "already decided" }
  | { ok: false; error: "outbox write failed" };

/** The collection memory items live in. */
const ITEMS = "memories";

/** The collection pending and decided approvals live in. */
const APPROVALS = "approvals";

/** The collection accounts live in; propose checks ownership here. */
const ACCOUNTS = "accounts";

/** The only fields `correct` may change. Everything else fails closed. */
const CORRECTABLE_FIELDS: ReadonlySet<string> = new Set(["text", "kind"]);

/**
 * Governed memory over a `Store`, with every action written to the log.
 * Storage goes only through the `Store` interface, so the backing store
 * can be swapped without changing this service.
 */
export class MemoryService {
  /** The outbox approvals are handed to; built over the same store. */
  private readonly outbox: Outbox;

  /** Wrap the given store and change log; the service holds no state. */
  constructor(
    private readonly store: Store,
    private readonly log: ChangeLog,
  ) {
    this.outbox = new Outbox(store);
  }

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
   * Correct one field of one item — owner only, and only the `text`
   * and `kind` fields may be corrected.
   * The new value replaces the field; the value it held goes into the
   * item's `history`, and the item is stamped with `correctedAt`. The
   * "correct" change log entry names the field only — never the old or
   * new value — so the log proves a correction happened without
   * carrying content. Every failure is the one generic refusal: a
   * missing or forgotten item, another owner's item (also logged as
   * "refuse", item untouched), a field outside the allowlist, or a
   * non-string value for an allowed field.
   */
  async correct(
    requesterId: string,
    itemId: string,
    field: string,
    value: unknown,
  ): Promise<CorrectResult> {
    const raw = await this.store.get(ITEMS, itemId);
    if (raw === undefined || raw.forgotten === true) {
      return NOT_FOUND;
    }
    const { _id: _key, ...rest } = raw;
    const item = rest as unknown as MemoryItem & Record<string, unknown>;
    if (item.owner_salesperson_id !== requesterId) {
      await this.log.append(
        requesterId,
        "refuse",
        itemId,
        "Correct refused: not the owner.",
      );
      return NOT_FOUND;
    }
    if (!CORRECTABLE_FIELDS.has(field) || typeof value !== "string") {
      return NOT_FOUND;
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
    await this.store.put(ITEMS, itemId, { _id: itemId, ...corrected });
    await this.log.append(
      requesterId,
      "correct",
      itemId,
      `Field "${field}" corrected.`,
    );
    return { ok: true, item: corrected };
  }

  /**
   * Propose a change for `ownerSalespersonId`: stored as a pending
   * approval that changes nothing until `approve` is called on it.
   * Generates an id when the caller does not supply one.
   *
   * When the change names an account, the account must exist and
   * belong to the proposer — a salesperson cannot propose against an
   * account they don't own. A missing account gets the generic
   * refusal; someone else's account gets the generic refusal and a
   * "refuse" change log entry, and no approval is stored either way.
   */
  async propose(
    ownerSalespersonId: string,
    change: { id?: string; description: string; accountId?: string },
  ): Promise<ProposeResult> {
    if (change.accountId !== undefined) {
      const account = await this.store.get(ACCOUNTS, change.accountId);
      if (account === undefined) {
        return NOT_FOUND;
      }
      if (account.owner_salesperson_id !== ownerSalespersonId) {
        await this.log.append(
          ownerSalespersonId,
          "refuse",
          change.accountId,
          "Propose refused: not the owner.",
        );
        return NOT_FOUND;
      }
    }
    const approval: Approval = {
      id: change.id ?? globalThis.crypto.randomUUID(),
      owner_salesperson_id: ownerSalespersonId,
      description: change.description,
      status: "pending",
    };
    if (change.accountId !== undefined) {
      approval.accountId = change.accountId;
    }
    await this.store.put(APPROVALS, approval.id, {
      _id: approval.id,
      ...approval,
    });
    return { ok: true, approval };
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
   * Approve a pending change — for the approval's owner only — hand it
   * to the outbox, and append an "approve" change log entry naming who
   * decided.
   *
   * The outbox entry is written BEFORE the approval is marked
   * approved: if the write fails, the approval is left pending and the
   * result is "outbox write failed", so an approval can never end up
   * decided but never handed off, and approving again is safe — the
   * outbox write is idempotent, so the retry still produces exactly
   * one entry. Fails closed with the one generic refusal: an unknown
   * id and an approval that belongs to someone else are
   * indistinguishable, and the cross-owner attempt is logged as
   * "refuse". An approval that was already decided returns "already
   * decided", which only its owner can be told — one approval covers
   * one decision, once.
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
    try {
      await this.outbox.writeOnApprove({
        id: approval.id,
        owner_salesperson_id: approval.owner_salesperson_id,
        accountId: approval.accountId,
        description: approval.description,
      });
    } catch {
      return { ok: false, error: "outbox write failed" };
    }
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
