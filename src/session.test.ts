/**
 * Tests for the session service: a session can be opened on an account
 * the opener owns, advanced, closed, and resumed at exactly the step
 * and data where it was closed — and only its owner can do any of
 * that. Anyone else, and anyone naming an account or session that is
 * not theirs (or does not exist), gets the one generic refusal, the
 * attempt is recorded as a refusal, and nothing changes.
 */

import { describe, expect, it } from "vitest";

import { ChangeLog } from "./change-log";
import { seededStore } from "./seed";
import { SessionService, type Session } from "./session";
import type { Store } from "./store";

/**
 * Build a fresh session service and log over a seeded store, so the
 * seed accounts exist with their owners (acct_salesperson owns acct-willow-co,
 * acct_salesperson_2 owns acct-harbour-bikes) and a test can assert on behaviour,
 * stored state, and the recorded evidence together.
 */
async function freshSessions(): Promise<{
  service: SessionService;
  log: ChangeLog;
  store: Store;
}> {
  const store = await seededStore();
  const log = new ChangeLog(store);
  return { service: new SessionService(store, log), log, store };
}

/**
 * Open a session that is expected to succeed and return it.
 * Throws — failing the test — when the open is refused instead.
 */
async function mustOpen(
  service: SessionService,
  ownerSalespersonId: string,
  accountId: string,
): Promise<Session> {
  const result = await service.open(ownerSalespersonId, accountId);
  if (!result.ok) {
    throw new Error(`expected open to succeed, got "${result.error}"`);
  }
  return result.session;
}

describe("SessionService open (account ownership)", () => {
  /**
   * Opening a session on an account owned by the other salesperson is
   * refused with the generic answer, a "refuse" entry naming the
   * requester is recorded against the account, and no session is
   * stored.
   */
  it("refuses an open on the other salesperson's account and logs it", async () => {
    const { service, log, store } = await freshSessions();
    const result = await service.open("acct_salesperson_2", "acct-willow-co");
    expect(result).toEqual({ ok: false, error: "not found" });
    await expect(store.list("sessions")).resolves.toEqual([]);
    const refusals = (await log.entries()).filter(
      (entry) => entry.action === "refuse",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].actor).toBe("acct_salesperson_2");
    expect(refusals[0].subject).toBe("acct-willow-co");
  });

  /**
   * Opening a session on an account that does not exist returns the
   * same generic refusal as someone else's account — the two are
   * indistinguishable — and stores nothing.
   */
  it("refuses an open on a missing account with the same generic answer", async () => {
    const { service, store } = await freshSessions();
    const missing = await service.open("acct_salesperson", "acct-never-existed");
    const crossOwner = await service.open("acct_salesperson_2", "acct-willow-co");
    expect(missing).toEqual({ ok: false, error: "not found" });
    expect(missing).toEqual(crossOwner);
    await expect(store.list("sessions")).resolves.toEqual([]);
  });
});

describe("SessionService close and resume", () => {
  /**
   * Open, advance to "approval" with data, close, then resume: the
   * resumed session is open again at step "approval" with its data
   * intact, and the log shows the whole story including a
   * "session-resume" entry.
   */
  it("resumes a closed session at its exact step with its data", async () => {
    const { service, log } = await freshSessions();
    const opened = await mustOpen(service, "acct_salesperson", "acct-willow-co");
    expect(opened.step).toBe("intake");
    expect(opened.status).toBe("open");
    const advanced = await service.advance(opened.id, "acct_salesperson", "approval", {
      leadContact: "Priya",
    });
    expect(advanced.ok).toBe(true);
    const closed = await service.close(opened.id, "acct_salesperson");
    expect(closed.ok).toBe(true);
    const resumed = await service.resume(opened.id, "acct_salesperson");
    expect(resumed).toMatchObject({
      ok: true,
      session: {
        id: opened.id,
        step: "approval",
        status: "open",
        data: { leadContact: "Priya" },
      },
    });
    const actions = (await log.entries()).map((entry) => entry.action);
    expect(actions).toEqual([
      "session-open",
      "session-step",
      "session-close",
      "session-resume",
    ]);
    await expect(log.verify()).resolves.toMatchObject({ ok: true });
  });

  /**
   * A resume attempt by the other salesperson is refused with the
   * generic answer — the result reveals nothing about the session — a
   * "refuse" entry is recorded, and the stored session stays closed at
   * its saved step.
   */
  it("refuses a resume by the other salesperson and stays closed", async () => {
    const { service, log, store } = await freshSessions();
    const opened = await mustOpen(service, "acct_salesperson", "acct-willow-co");
    await service.advance(opened.id, "acct_salesperson", "stakeholders");
    await service.close(opened.id, "acct_salesperson");
    const result = await service.resume(opened.id, "acct_salesperson_2");
    expect(result).toEqual({ ok: false, error: "not found" });
    expect(JSON.stringify(result)).not.toContain("stakeholders");
    const stored = await store.get("sessions", opened.id);
    expect(stored).toMatchObject({ status: "closed", step: "stakeholders" });
    const refusals = (await log.entries()).filter(
      (entry) => entry.action === "refuse",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].actor).toBe("acct_salesperson_2");
  });

  /**
   * Resuming a session that was never closed fails closed: there is no
   * saved point to return to, so nothing is reopened or changed.
   */
  it("fails closed when resuming a session that is still open", async () => {
    const { service } = await freshSessions();
    const opened = await mustOpen(service, "acct_salesperson", "acct-willow-co");
    await expect(service.resume(opened.id, "acct_salesperson")).resolves.toEqual({
      ok: false,
      error: "not closed",
    });
  });

  /**
   * A stored session carries the seed vocabulary: keyed by `_id`, with
   * the owner named by `owner_salesperson_id`.
   */
  it("stores the session keyed by _id with owner_salesperson_id", async () => {
    const { service, store } = await freshSessions();
    const opened = await mustOpen(service, "acct_salesperson", "acct-willow-co");
    const stored = await store.get("sessions", opened.id);
    expect(stored).toMatchObject({
      _id: opened.id,
      owner_salesperson_id: "acct_salesperson",
      accountId: "acct-willow-co",
    });
    expect(stored).not.toHaveProperty("ownerId");
  });
});
