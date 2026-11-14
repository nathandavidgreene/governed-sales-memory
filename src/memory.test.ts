/**
 * Tests for the memory service: the read rule (owner reads, everyone
 * else is refused generically and the refusal is recorded), owner-only
 * forget, and the propose-then-approve flow. Plus the two Worker routes
 * that expose remember and recall.
 */

import { describe, expect, it } from "vitest";

import worker from "./index";
import { MemoryService } from "./memory";
import { RecordLog } from "./record";
import { MemoryStore } from "./store";

/**
 * Build a fresh service, log, and store that share one in-memory store,
 * so a test can assert on both behaviour and the recorded evidence.
 */
function freshService(): {
  service: MemoryService;
  log: RecordLog;
} {
  const store = new MemoryStore();
  const log = new RecordLog(store);
  return { service: new MemoryService(store, log), log };
}

describe("MemoryService recall (the read rule)", () => {
  /** An item remembered by its owner is recalled by that same owner. */
  it("returns the item to its owner", async () => {
    const { service } = freshService();
    const item = await service.remember("sp-1", {
      id: "item-1",
      kind: "note",
      text: "Sample note for the owner.",
    });
    await expect(service.recall("sp-1", item.id)).resolves.toEqual({
      ok: true,
      item,
    });
  });

  /**
   * A read by the other salesperson is refused with the generic answer
   * (no item content anywhere in the result), and a "refuse" entry
   * naming the requester appears in the record log.
   */
  it("refuses the other salesperson generically and records the refusal", async () => {
    const { service, log } = freshService();
    await service.remember("sp-1", {
      id: "item-1",
      kind: "note",
      text: "Sample note for the owner.",
    });
    const result = await service.recall("sp-2", "item-1");
    expect(result).toEqual({ ok: false, error: "not yours" });
    expect(JSON.stringify(result)).not.toContain("Sample note");
    const refusals = (await log.entries()).filter(
      (entry) => entry.action === "refuse",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].actor).toBe("sp-2");
    expect(refusals[0].subject).toBe("item-1");
    expect(refusals[0].detail).not.toContain("Sample note");
    await expect(log.verify()).resolves.toMatchObject({ ok: true });
  });

  /** Recalling an id that was never stored fails closed as not found. */
  it("fails closed on an unknown item id", async () => {
    const { service } = freshService();
    await expect(service.recall("sp-1", "missing")).resolves.toEqual({
      ok: false,
      error: "not found",
    });
  });
});

describe("MemoryService forget", () => {
  /**
   * After the owner forgets an item, recalling it fails (not found, the
   * content is gone) and the log shows a "forget" entry.
   */
  it("removes the item for the owner and records the forget", async () => {
    const { service, log } = freshService();
    await service.remember("sp-1", {
      id: "item-1",
      kind: "note",
      text: "Sample note for the owner.",
    });
    await expect(service.forget("sp-1", "item-1")).resolves.toEqual({
      ok: true,
    });
    await expect(service.recall("sp-1", "item-1")).resolves.toEqual({
      ok: false,
      error: "not found",
    });
    const actions = (await log.entries()).map((entry) => entry.action);
    expect(actions).toEqual(["remember", "forget"]);
  });

  /**
   * A forget attempt by the other salesperson is refused generically,
   * logged as "refuse", and the owner's item is still there afterwards.
   */
  it("refuses a non-owner forget and leaves the item in place", async () => {
    const { service, log } = freshService();
    await service.remember("sp-1", {
      id: "item-1",
      kind: "note",
      text: "Sample note for the owner.",
    });
    await expect(service.forget("sp-2", "item-1")).resolves.toEqual({
      ok: false,
      error: "not yours",
    });
    const recall = await service.recall("sp-1", "item-1");
    expect(recall.ok).toBe(true);
    const actions = (await log.entries()).map((entry) => entry.action);
    expect(actions).toEqual(["remember", "refuse"]);
  });
});

describe("MemoryService approve flow", () => {
  /**
   * A proposed change stays pending until approve is called; approving
   * marks it approved, names the approver, and appends an "approve"
   * record entry.
   */
  it("keeps a proposal pending until it is approved", async () => {
    const { service, log } = freshService();
    const proposal = await service.propose("sp-1", {
      id: "chg-1",
      description: "Update the sample account's lead contact.",
    });
    expect(proposal.status).toBe("pending");
    await expect(service.getApproval("chg-1")).resolves.toMatchObject({
      status: "pending",
    });
    const result = await service.approve("sp-1", "chg-1");
    expect(result).toEqual({
      ok: true,
      approval: { ...proposal, status: "approved", approvedBy: "sp-1" },
    });
    await expect(service.getApproval("chg-1")).resolves.toMatchObject({
      status: "approved",
    });
    const approvals = (await log.entries()).filter(
      (entry) => entry.action === "approve",
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0].actor).toBe("sp-1");
    expect(approvals[0].subject).toBe("chg-1");
  });

  /** Approving an id that does not exist fails closed. */
  it("fails closed on an unknown approval id", async () => {
    const { service } = freshService();
    await expect(service.approve("sp-1", "missing")).resolves.toEqual({
      ok: false,
      error: "unknown approval",
    });
  });
});

describe("memory routes", () => {
  /** POST /memory stores an item, and its owner can GET it back by id. */
  it("stores via POST and recalls via GET for the owner", async () => {
    const post = await worker.fetch(
      new Request("https://x.test/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerId: "sp-1",
          id: "route-item-1",
          kind: "note",
          text: "Sample route note.",
        }),
      }),
    );
    expect(post.status).toBe(201);
    const get = await worker.fetch(
      new Request("https://x.test/memory/route-item-1?as=sp-1"),
    );
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      ok: true,
      item: { id: "route-item-1", text: "Sample route note." },
    });
  });

  /** A cross-owner GET is answered 403 with the generic refusal JSON. */
  it("answers 403 with the generic refusal on a cross-owner GET", async () => {
    const get = await worker.fetch(
      new Request("https://x.test/memory/route-item-1?as=sp-2"),
    );
    expect(get.status).toBe(403);
    const body = (await get.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "not yours" });
    expect(JSON.stringify(body)).not.toContain("Sample route note");
  });
});
