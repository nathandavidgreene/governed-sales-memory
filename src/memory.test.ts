/**
 * Tests for the memory service: the read rule (owner reads; everyone
 * else gets one identical generic refusal whether the item is theirs
 * to see or does not exist at all, and refusals are written to the
 * change log), owner-only forget, and the propose-then-approve flow
 * with its owner check. Plus the Worker routes that expose remember
 * and recall.
 */

import { describe, expect, it } from "vitest";

import { ChangeLog } from "./change-log";
import worker from "./index";
import { MemoryService } from "./memory";
import { MemoryStore } from "./store";

/**
 * Build a fresh service, log, and store that share one in-memory store,
 * so a test can assert on both behaviour and the logged evidence.
 */
function freshService(): {
  service: MemoryService;
  log: ChangeLog;
} {
  const store = new MemoryStore();
  const log = new ChangeLog(store);
  return { service: new MemoryService(store, log), log };
}

/** The one generic refusal every failed recall, forget, or approve returns. */
const GENERIC_REFUSAL = { ok: false, error: "not found" };

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
   * naming the requester appears in the change log.
   */
  it("refuses the other salesperson generically and logs the refusal", async () => {
    const { service, log } = freshService();
    await service.remember("sp-1", {
      id: "item-1",
      kind: "note",
      text: "Sample note for the owner.",
    });
    const result = await service.recall("sp-2", "item-1");
    expect(result).toEqual(GENERIC_REFUSAL);
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

  /**
   * The refusal for someone else's item is exactly the refusal for an
   * id that never existed — same shape, same words — so a caller
   * cannot tell whether an item exists.
   */
  it("makes a cross-owner read indistinguishable from a missing item", async () => {
    const { service } = freshService();
    await service.remember("sp-1", {
      id: "item-1",
      kind: "note",
      text: "Sample note for the owner.",
    });
    const crossOwner = await service.recall("sp-2", "item-1");
    const missing = await service.recall("sp-2", "never-existed");
    expect(crossOwner).toEqual(GENERIC_REFUSAL);
    expect(missing).toEqual(GENERIC_REFUSAL);
    expect(crossOwner).toEqual(missing);
  });
});

describe("MemoryService forget", () => {
  /**
   * After the owner forgets an item, recalling it fails with the
   * generic refusal (the content is gone) and the log shows a
   * "forget" entry.
   */
  it("removes the item for the owner and logs the forget", async () => {
    const { service, log } = freshService();
    await service.remember("sp-1", {
      id: "item-1",
      kind: "note",
      text: "Sample note for the owner.",
    });
    await expect(service.forget("sp-1", "item-1")).resolves.toEqual({
      ok: true,
    });
    await expect(service.recall("sp-1", "item-1")).resolves.toEqual(
      GENERIC_REFUSAL,
    );
    const actions = (await log.entries()).map((entry) => entry.action);
    expect(actions).toEqual(["remember", "forget"]);
  });

  /**
   * A forget attempt by the other salesperson gets the same generic
   * refusal as a missing item, is logged as "refuse", and the owner's
   * item is still there afterwards.
   */
  it("refuses a non-owner forget like a missing item and keeps the item", async () => {
    const { service, log } = freshService();
    await service.remember("sp-1", {
      id: "item-1",
      kind: "note",
      text: "Sample note for the owner.",
    });
    const crossOwner = await service.forget("sp-2", "item-1");
    const missing = await service.forget("sp-2", "never-existed");
    expect(crossOwner).toEqual(GENERIC_REFUSAL);
    expect(crossOwner).toEqual(missing);
    const recall = await service.recall("sp-1", "item-1");
    expect(recall.ok).toBe(true);
    const actions = (await log.entries()).map((entry) => entry.action);
    expect(actions).toEqual(["remember", "refuse"]);
  });
});

describe("MemoryService remember storage", () => {
  /**
   * A remembered item is stored with forgotten false, so MongoDB
   * {forgotten: false} search filters match it instead of missing it.
   */
  it("stores forgotten false on the memory document", async () => {
    const store = new MemoryStore();
    const log = new ChangeLog(store);
    const service = new MemoryService(store, log);
    await service.remember("sp-1", {
      id: "item-unforgotten",
      kind: "note",
      text: "Sample note for the owner.",
    });
    const stored = await store.get("memories", "item-unforgotten");
    expect(stored?.forgotten).toBe(false);
  });
});

describe("MemoryService approve flow", () => {
  /**
   * A proposed change stays pending until its owner approves it;
   * approving marks it approved, names the approver, and appends an
   * "approve" change log entry.
   */
  it("keeps a proposal pending until its owner approves it", async () => {
    const { service, log } = freshService();
    const proposed = await service.propose("sp-1", {
      id: "chg-1",
      description: "Update the sample account's lead contact.",
    });
    if (!proposed.ok) {
      throw new Error("expected the proposal to be stored");
    }
    const proposal = proposed.approval;
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

  /**
   * The other salesperson cannot approve someone else's proposal: the
   * answer is the generic refusal (identical to an unknown id), the
   * attempt is logged as "refuse", and the proposal stays pending.
   */
  it("refuses a cross-owner approve like an unknown id and logs it", async () => {
    const { service, log } = freshService();
    await service.propose("sp-1", {
      id: "chg-1",
      description: "Update the sample account's lead contact.",
    });
    const crossOwner = await service.approve("sp-2", "chg-1");
    const unknown = await service.approve("sp-2", "never-existed");
    expect(crossOwner).toEqual(GENERIC_REFUSAL);
    expect(crossOwner).toEqual(unknown);
    await expect(service.getApproval("chg-1")).resolves.toMatchObject({
      status: "pending",
    });
    const refusals = (await log.entries()).filter(
      (entry) => entry.action === "refuse",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].actor).toBe("sp-2");
    expect(refusals[0].subject).toBe("chg-1");
  });

  /**
   * Only the owner is ever told a decision already happened: a second
   * approve by the owner returns "already decided", while a
   * cross-owner attempt on the decided approval still gets the
   * generic refusal.
   */
  it("tells only the owner that an approval was already decided", async () => {
    const { service } = freshService();
    await service.propose("sp-1", {
      id: "chg-1",
      description: "Update the sample account's lead contact.",
    });
    await service.approve("sp-1", "chg-1");
    await expect(service.approve("sp-1", "chg-1")).resolves.toEqual({
      ok: false,
      error: "already decided",
    });
    await expect(service.approve("sp-2", "chg-1")).resolves.toEqual(
      GENERIC_REFUSAL,
    );
  });
});

describe("memory routes", () => {
  /**
   * The routes run on the store the environment selects; these tests
   * opt into the in-memory store with the explicit dev flag, the only
   * way the factory allows it without a connection string.
   */
  const devEnv = { ALLOW_IN_MEMORY_STORE: "true" };

  /**
   * POST /memory?as= stores an item for the `as` caller — an owner
   * field inside the body is never trusted — and the owner can GET it
   * back by id.
   */
  it("stores via POST for the ?as= caller and recalls via GET", async () => {
    const post = await worker.fetch(
      new Request("https://x.test/memory?as=sp-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerId: "sp-2",
          id: "route-item-1",
          kind: "note",
          text: "Sample route note.",
        }),
      }),
      devEnv,
    );
    expect(post.status).toBe(201);
    const get = await worker.fetch(
      new Request("https://x.test/memory/route-item-1?as=sp-1"),
      devEnv,
    );
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      ok: true,
      item: { id: "route-item-1", text: "Sample route note." },
    });
  });

  /**
   * A cross-owner GET and a GET for an item that does not exist return
   * the identical response — same status, same body — so the route
   * leaks nothing about whether an item exists.
   */
  it("answers cross-owner and missing GETs with one identical 404", async () => {
    const crossOwner = await worker.fetch(
      new Request("https://x.test/memory/route-item-1?as=sp-2"),
      devEnv,
    );
    const missing = await worker.fetch(
      new Request("https://x.test/memory/never-existed?as=sp-2"),
      devEnv,
    );
    expect(crossOwner.status).toBe(404);
    expect(missing.status).toBe(404);
    const crossBody = await crossOwner.json();
    const missingBody = await missing.json();
    expect(crossBody).toEqual({ ok: false, error: "not found" });
    expect(crossBody).toEqual(missingBody);
    expect(JSON.stringify(crossBody)).not.toContain("Sample route note");
  });

  /** POST /memory without an `as` caller is a JSON 400, not a guess. */
  it("answers 400 when POST /memory has no ?as= caller", async () => {
    const post = await worker.fetch(
      new Request("https://x.test/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "note", text: "No owner named." }),
      }),
      devEnv,
    );
    expect(post.status).toBe(400);
    await expect(post.json()).resolves.toMatchObject({ ok: false });
  });

  /**
   * A malformed percent escape in the item id is a JSON 400 rather
   * than a thrown 500 from the URL decoder.
   */
  it("answers 400 on a malformed percent escape in the URL", async () => {
    const get = await worker.fetch(
      new Request("https://x.test/memory/%E0%A4%A?as=sp-1"),
      devEnv,
    );
    expect(get.status).toBe(400);
    await expect(get.json()).resolves.toMatchObject({ ok: false });
  });
});
