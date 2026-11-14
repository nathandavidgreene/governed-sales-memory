/**
 * Tests for the workflow layer on the memory service: correcting a
 * remembered fact (owner only, previous value kept in the item's
 * history, the log naming the field only) and the outbox entry an
 * approval writes — exactly one per approval, however the approval is
 * retried.
 */

import { describe, expect, it } from "vitest";

import { MemoryService } from "./memory";
import { Outbox } from "./outbox";
import { RecordLog } from "./record";
import { MemoryStore, type Store } from "./store";

/**
 * Build a fresh memory service, log, outbox, and store over one
 * in-memory store, so a test can assert on behaviour, stored state,
 * outbox contents, and the recorded evidence together.
 */
function freshWorkflow(): {
  service: MemoryService;
  log: RecordLog;
  outbox: Outbox;
  store: Store;
} {
  const store = new MemoryStore();
  const log = new RecordLog(store);
  return {
    service: new MemoryService(store, log),
    log,
    outbox: new Outbox(store),
    store,
  };
}

describe("MemoryService correct", () => {
  /**
   * Correcting a field changes it on the item, keeps the previous value
   * in the item's history, stamps the correction time, and writes a
   * "correct" log entry that names the field but neither value.
   */
  it("changes the field and keeps the previous value in history", async () => {
    const { service, log } = freshWorkflow();
    await service.remember("sp-1", {
      id: "item-1",
      kind: "contact",
      text: "Dan is the lead contact.",
    });
    const result = await service.correct(
      "sp-1",
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
    const recalled = await service.recall("sp-1", "item-1");
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
   * A correct attempt by the other salesperson is refused generically,
   * logged as "refuse", and the item keeps its original value with no
   * history added.
   */
  it("refuses a correct by the other salesperson and changes nothing", async () => {
    const { service, log } = freshWorkflow();
    await service.remember("sp-1", {
      id: "item-1",
      kind: "contact",
      text: "Dan is the lead contact.",
    });
    await expect(
      service.correct("sp-2", "item-1", "text", "Someone else."),
    ).resolves.toEqual({ ok: false, error: "not yours" });
    const recalled = await service.recall("sp-1", "item-1");
    expect(recalled.ok).toBe(true);
    if (recalled.ok) {
      expect(recalled.item.text).toBe("Dan is the lead contact.");
      expect(recalled.item.history).toBeUndefined();
    }
    const actions = (await log.entries()).map((entry) => entry.action);
    expect(actions).toEqual(["remember", "refuse"]);
  });
});

describe("outbox on approve", () => {
  /**
   * Approving a proposal writes exactly one outbox entry tied to that
   * approval id, carrying the owner, the account the proposal named,
   * and the proposal's summary text.
   */
  it("writes one outbox entry when a proposal is approved", async () => {
    const { service, outbox } = freshWorkflow();
    await service.propose("sp-1", {
      id: "chg-1",
      description: "Send the sample proposal to the account.",
      accountId: "acct-north-bakery",
    });
    await expect(outbox.list()).resolves.toEqual([]);
    await service.approve("sp-1", "chg-1");
    const entries = await outbox.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      approvalId: "chg-1",
      ownerId: "sp-1",
      accountId: "acct-north-bakery",
      summary: "Send the sample proposal to the account.",
    });
  });

  /**
   * Approving the same proposal again fails closed ("already decided")
   * and does not write a second outbox entry: one approval, one
   * hand-off.
   */
  it("writes no second entry when approval is attempted twice", async () => {
    const { service, outbox } = freshWorkflow();
    await service.propose("sp-1", {
      id: "chg-1",
      description: "Send the sample proposal to the account.",
    });
    await service.approve("sp-1", "chg-1");
    await expect(service.approve("sp-1", "chg-1")).resolves.toEqual({
      ok: false,
      error: "already decided",
    });
    await expect(outbox.list()).resolves.toHaveLength(1);
  });
});
