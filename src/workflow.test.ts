/**
 * Tests for the workflow layer on the memory service: correcting a
 * remembered fact (owner only, only `text` and `kind`, previous value
 * kept in the item's history, the log naming the field only), proposing
 * against an account (ownership checked, refusals generic), and the
 * outbox entry an approval writes — exactly one per approval, written
 * before the approval is marked decided so a failed write leaves the
 * approval pending, and readable only by its owner.
 */

import { describe, expect, it } from "vitest";

import { ChangeLog } from "./change-log";
import { MemoryService } from "./memory";
import { Outbox } from "./outbox";
import { seededStore } from "./seed";
import { MemoryStore, type Store } from "./store";

/**
 * Build a fresh memory service, log, outbox, and store over one seeded
 * store, so the seed accounts exist with their owners (acct_salesperson owns
 * acct_willow and acct_harbor, acct_salesperson_2 owns acct_cabot_shore) and a test can
 * assert on behaviour, stored state, outbox contents, and the recorded
 * evidence together.
 */
async function freshWorkflow(): Promise<{
  service: MemoryService;
  log: ChangeLog;
  outbox: Outbox;
  store: Store;
}> {
  const store = await seededStore();
  const log = new ChangeLog(store);
  return {
    service: new MemoryService(store, log),
    log,
    outbox: new Outbox(store),
    store,
  };
}

/** The one generic refusal every failed governed action returns. */
const GENERIC_REFUSAL = { ok: false, error: "not found" };

describe("MemoryService correct", () => {
  /**
   * Correcting the text changes it on the item, keeps the previous
   * value in the item's history, stamps the correction time, and
   * writes a "correct" log entry that names the field but neither
   * value.
   */
  it("changes the field and keeps the previous value in history", async () => {
    const { service, log } = await freshWorkflow();
    await service.remember("acct_salesperson", {
      id: "item-1",
      kind: "contact",
      text: "Dan is the lead contact.",
    });
    const result = await service.correct(
      "acct_salesperson",
      "item-1",
      "text",
      "Priya is the lead contact.",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.text).toBe("Priya is the lead contact.");
      expect(result.item.correctedAt).toBeDefined();
      expect(result.item.history).toHaveLength(1);
      expect(result.item.history?.[0]).toMatchObject({
        field: "text",
        previous: "Dan is the lead contact.",
      });
    }
    const recalled = await service.recall("acct_salesperson", "item-1");
    expect(recalled).toMatchObject({
      ok: true,
      item: { text: "Priya is the lead contact." },
    });
    const corrections = (await log.entries()).filter(
      (entry) => entry.action === "correct",
    );
    expect(corrections).toHaveLength(1);
    expect(corrections[0].detail).toContain('"text"');
    expect(corrections[0].detail).not.toContain("Dan");
    expect(corrections[0].detail).not.toContain("Priya");
  });

  /**
   * Correcting the kind is allowed too: `text` and `kind` are the
   * allowlist, and each correction lands in the history in order.
   */
  it("allows correcting the kind as well as the text", async () => {
    const { service } = await freshWorkflow();
    await service.remember("acct_salesperson", {
      id: "item-1",
      kind: "note",
      text: "Sample note.",
    });
    const result = await service.correct("acct_salesperson", "item-1", "kind", "preference");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.kind).toBe("preference");
      expect(result.item.history?.[0]).toMatchObject({
        field: "kind",
        previous: "note",
      });
    }
  });

  /**
   * Any field outside the allowlist — identity fields, the history
   * itself, the correction stamp — fails closed with the generic
   * refusal and leaves the item exactly as it was, with no history
   * added and nothing corrected.
   */
  it("refuses fields outside the text/kind allowlist and changes nothing", async () => {
    const { service } = await freshWorkflow();
    await service.remember("acct_salesperson", {
      id: "item-1",
      kind: "contact",
      text: "Dan is the lead contact.",
    });
    for (const field of [
      "owner_salesperson_id",
      "id",
      "history",
      "correctedAt",
      "forgotten",
    ]) {
      await expect(
        service.correct("acct_salesperson", "item-1", field, "tampered"),
      ).resolves.toEqual(GENERIC_REFUSAL);
    }
    const recalled = await service.recall("acct_salesperson", "item-1");
    expect(recalled.ok).toBe(true);
    if (recalled.ok) {
      expect(recalled.item).toMatchObject({
        owner_salesperson_id: "acct_salesperson",
        kind: "contact",
        text: "Dan is the lead contact.",
      });
      expect(recalled.item.history).toBeUndefined();
      expect(recalled.item.correctedAt).toBeUndefined();
    }
  });

  /**
   * A correct attempt by the other salesperson is refused with the
   * generic answer, logged as "refuse", and the item keeps its
   * original value with no history added.
   */
  it("refuses a correct by the other salesperson and changes nothing", async () => {
    const { service, log } = await freshWorkflow();
    await service.remember("acct_salesperson", {
      id: "item-1",
      kind: "contact",
      text: "Dan is the lead contact.",
    });
    await expect(
      service.correct("acct_salesperson_2", "item-1", "text", "Someone else."),
    ).resolves.toEqual(GENERIC_REFUSAL);
    const recalled = await service.recall("acct_salesperson", "item-1");
    expect(recalled.ok).toBe(true);
    if (recalled.ok) {
      expect(recalled.item.text).toBe("Dan is the lead contact.");
      expect(recalled.item.history).toBeUndefined();
    }
    const actions = (await log.entries()).map((entry) => entry.action);
    expect(actions).toEqual(["remember", "refuse"]);
  });
});

describe("MemoryService propose (account ownership)", () => {
  /**
   * Proposing against an account the proposer owns stores a pending
   * approval that carries the account id onward.
   */
  it("stores a proposal against the proposer's own account", async () => {
    const { service } = await freshWorkflow();
    const result = await service.propose("acct_salesperson", {
      id: "chg-1",
      description: "Send the sample proposal to the account.",
      accountId: "acct_willow",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approval).toMatchObject({
        status: "pending",
        accountId: "acct_willow",
        owner_salesperson_id: "acct_salesperson",
      });
    }
  });

  /**
   * Approval state lives in its own "approvals" collection — never
   * inside a session — keyed by `_id` and carrying
   * `owner_salesperson_id`, matching the seed vocabulary.
   */
  it("stores approval state in its own approvals collection", async () => {
    const { service, store } = await freshWorkflow();
    await service.propose("acct_salesperson", {
      id: "chg-1",
      description: "Send the sample proposal to the account.",
      accountId: "acct_willow",
    });
    const stored = await store.get("approvals", "chg-1");
    expect(stored).toMatchObject({
      _id: "chg-1",
      id: "chg-1",
      owner_salesperson_id: "acct_salesperson",
      accountId: "acct_willow",
      status: "pending",
    });
    expect(stored).not.toHaveProperty("ownerId");
    await expect(store.list("sessions")).resolves.toEqual([]);
  });

  /**
   * Proposing against the other salesperson's account is refused with
   * the generic answer, a "refuse" entry naming the proposer is
   * recorded against the account, and no approval is stored.
   */
  it("refuses a proposal against the other salesperson's account and logs it", async () => {
    const { service, log } = await freshWorkflow();
    const result = await service.propose("acct_salesperson_2", {
      id: "chg-1",
      description: "Send the sample proposal to the account.",
      accountId: "acct_willow",
    });
    expect(result).toEqual(GENERIC_REFUSAL);
    await expect(service.getApproval("chg-1")).resolves.toBeUndefined();
    const refusals = (await log.entries()).filter(
      (entry) => entry.action === "refuse",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].actor).toBe("acct_salesperson_2");
    expect(refusals[0].subject).toBe("acct_willow");
  });

  /**
   * Proposing against an account that does not exist returns the same
   * generic refusal as someone else's account, and stores nothing.
   */
  it("refuses a proposal against a missing account with the same generic answer", async () => {
    const { service } = await freshWorkflow();
    const missing = await service.propose("acct_salesperson", {
      id: "chg-1",
      description: "Send the sample proposal to the account.",
      accountId: "acct-never-existed",
    });
    const crossOwner = await service.propose("acct_salesperson_2", {
      id: "chg-2",
      description: "Send the sample proposal to the account.",
      accountId: "acct_willow",
    });
    expect(missing).toEqual(GENERIC_REFUSAL);
    expect(missing).toEqual(crossOwner);
    await expect(service.getApproval("chg-1")).resolves.toBeUndefined();
    await expect(service.getApproval("chg-2")).resolves.toBeUndefined();
  });
});

describe("outbox on approve", () => {
  /**
   * Approving a proposal writes exactly one outbox entry tied to that
   * approval id, carrying the owner, the account the proposal named,
   * and the proposal's summary text.
   */
  it("writes one outbox entry when a proposal is approved", async () => {
    const { service, outbox } = await freshWorkflow();
    await service.propose("acct_salesperson", {
      id: "chg-1",
      description: "Send the sample proposal to the account.",
      accountId: "acct_willow",
    });
    await expect(outbox.list("acct_salesperson")).resolves.toEqual([]);
    await service.approve("acct_salesperson", "chg-1");
    const entries = await outbox.list("acct_salesperson");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      approvalId: "chg-1",
      owner_salesperson_id: "acct_salesperson",
      accountId: "acct_willow",
      summary: "Send the sample proposal to the account.",
    });
  });

  /**
   * Approving the same proposal again fails closed ("already decided")
   * and does not write a second outbox entry: one approval, one
   * hand-off.
   */
  it("writes no second entry when approval is attempted twice", async () => {
    const { service, outbox } = await freshWorkflow();
    await service.propose("acct_salesperson", {
      id: "chg-1",
      description: "Send the sample proposal to the account.",
    });
    await service.approve("acct_salesperson", "chg-1");
    await expect(service.approve("acct_salesperson", "chg-1")).resolves.toEqual({
      ok: false,
      error: "already decided",
    });
    await expect(outbox.list("acct_salesperson")).resolves.toHaveLength(1);
  });

  /**
   * The outbox's list is owner-filtered: after both salespeople have
   * approved proposals, each list shows only that salesperson's
   * entries — one salesperson's hand-offs never appear in the other's
   * view.
   */
  it("lists each salesperson only their own entries", async () => {
    const { service, outbox } = await freshWorkflow();
    await service.propose("acct_salesperson", {
      id: "chg-1",
      description: "First salesperson's change.",
    });
    await service.propose("acct_salesperson_2", {
      id: "chg-2",
      description: "Second salesperson's change.",
    });
    await service.approve("acct_salesperson", "chg-1");
    await service.approve("acct_salesperson_2", "chg-2");
    const first = await outbox.list("acct_salesperson");
    const second = await outbox.list("acct_salesperson_2");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      approvalId: "chg-1",
      owner_salesperson_id: "acct_salesperson",
    });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      approvalId: "chg-2",
      owner_salesperson_id: "acct_salesperson_2",
    });
    await expect(outbox.list("sp-3")).resolves.toEqual([]);
  });

  /**
   * A stored outbox entry carries the seed vocabulary: keyed by `_id`,
   * with the owner named by `owner_salesperson_id`.
   */
  it("stores entries keyed by _id with owner_salesperson_id", async () => {
    const { service, store } = await freshWorkflow();
    await service.propose("acct_salesperson", {
      id: "chg-1",
      description: "Send the sample proposal to the account.",
    });
    await service.approve("acct_salesperson", "chg-1");
    const stored = await store.list("crm_outbox");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      owner_salesperson_id: "acct_salesperson",
      approvalId: "chg-1",
    });
    expect(stored[0]._id).toBe(stored[0].id);
    expect(stored[0]).not.toHaveProperty("ownerId");
  });
});

/**
 * A store whose outbox writes fail while `failOutboxWrites` is set,
 * so a test can watch an approval survive a failed hand-off and then
 * succeed once writes recover. Every other collection behaves normally.
 */
class FlakyOutboxStore extends MemoryStore {
  /** While true, every write to the outbox collection throws. */
  failOutboxWrites = true;

  /** See `Store.put`. Throws for the outbox collection while flagged. */
  override async put(
    collection: string,
    id: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    if (this.failOutboxWrites && collection === "crm_outbox") {
      throw new Error("outbox store unavailable");
    }
    return super.put(collection, id, record);
  }
}

describe("approve when the outbox write fails", () => {
  /**
   * Approving while the outbox write fails returns "outbox write
   * failed" and — the fail-closed point — leaves the approval pending,
   * never decided. Once writes recover, approving again succeeds and
   * still produces exactly one outbox entry.
   */
  it("leaves the approval pending and recovers with exactly one entry", async () => {
    const store = new FlakyOutboxStore();
    const log = new ChangeLog(store);
    const service = new MemoryService(store, log);
    const outbox = new Outbox(store);
    await service.propose("acct_salesperson", {
      id: "chg-1",
      description: "Send the sample proposal to the account.",
    });
    await expect(service.approve("acct_salesperson", "chg-1")).resolves.toEqual({
      ok: false,
      error: "outbox write failed",
    });
    await expect(service.getApproval("chg-1")).resolves.toMatchObject({
      status: "pending",
    });
    await expect(outbox.list("acct_salesperson")).resolves.toEqual([]);
    store.failOutboxWrites = false;
    const retry = await service.approve("acct_salesperson", "chg-1");
    expect(retry.ok).toBe(true);
    await expect(service.getApproval("chg-1")).resolves.toMatchObject({
      status: "approved",
    });
    await expect(outbox.list("acct_salesperson")).resolves.toHaveLength(1);
  });
});
