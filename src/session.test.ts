/**
 * Tests for the session service: a session is opened for a known
 * salesperson, tied to no account, has its conversation history saved,
 * and is closed and resumed with that history intact — and only its
 * owner can do any of that. Anyone else, and anyone naming a session
 * that is not theirs (or does not exist), gets the one generic
 * refusal, the attempt is recorded as a refusal, and nothing changes.
 */

import { describe, expect, it } from "vitest";

import { ChangeLog } from "./change-log";
import { seededStore } from "./seed";
import { SessionService, type Session } from "./session";
import type { Store } from "./store";

/**
 * Build a fresh session service and log over a seeded store, so both
 * salesperson rows exist and a test can assert on behaviour, stored
 * state, and the recorded evidence together.
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
): Promise<Session> {
  const result = await service.open(ownerSalespersonId);
  if (!result.ok) {
    throw new Error(`expected open to succeed, got "${result.error}"`);
  }
  return result.session;
}

describe("SessionService open", () => {
  /**
   * An id that is not a salesperson row — a client account or an
   * unknown id — gets the generic refusal and no session is stored.
   */
  it("refuses an open for anyone who is not a known salesperson", async () => {
    const { service, store } = await freshSessions();
    const unknown = await service.open("acct-never-existed");
    const client = await service.open("acct_willow");
    expect(unknown).toEqual({ ok: false, error: "not found" });
    expect(client).toEqual(unknown);
    expect(await store.list("sessions")).toEqual([]);
  });
});

describe("SessionService close and resume", () => {
  /**
   * Open, save history and data, close, then resume: the resumed
   * session is open again with its history and data intact, and the
   * log shows open, close, and resume (saving history logs nothing).
   */
  it("resumes a closed session with its history and data", async () => {
    const { service, log } = await freshSessions();
    const opened = await mustOpen(service, "acct_salesperson");
    expect(opened.status).toBe("open");
    const history = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    const saved = await service.saveHistory(opened.id, "acct_salesperson", history, {
      leadContact: "Priya",
    });
    expect(saved.ok).toBe(true);
    const closed = await service.close(opened.id, "acct_salesperson");
    expect(closed.ok).toBe(true);
    const resumed = await service.resume(opened.id, "acct_salesperson");
    expect(resumed).toMatchObject({
      ok: true,
      session: {
        id: opened.id,
        history,
        status: "open",
        data: { leadContact: "Priya" },
      },
    });
    const actions = (await log.entries()).map((entry) => entry.action);
    expect(actions).toEqual([
      "session-open",
      "session-close",
      "session-resume",
    ]);
    await expect(log.verify()).resolves.toMatchObject({ ok: true });
  });

  /**
   * A resume attempt by the other salesperson is refused with the
   * generic answer — the result reveals nothing about the session — a
   * "refuse" entry is recorded, and the stored session stays closed
   * with its history.
   */
  it("refuses a resume by the other salesperson and stays closed", async () => {
    const { service, log, store } = await freshSessions();
    const opened = await mustOpen(service, "acct_salesperson");
    const history = [{ role: "user" as const, content: "secret plan" }];
    await service.saveHistory(opened.id, "acct_salesperson", history);
    await service.close(opened.id, "acct_salesperson");
    const result = await service.resume(opened.id, "acct_salesperson_2");
    expect(result).toEqual({ ok: false, error: "not found" });
    expect(JSON.stringify(result)).not.toContain("secret plan");
    const stored = await store.get("sessions", opened.id);
    expect(stored).toMatchObject({ status: "closed", history });
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
    const opened = await mustOpen(service, "acct_salesperson");
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
    const opened = await mustOpen(service, "acct_salesperson");
    const stored = await store.get("sessions", opened.id);
    expect(stored).toMatchObject({
      _id: opened.id,
      owner_salesperson_id: "acct_salesperson",
    });
    expect(stored).not.toHaveProperty("ownerId");
    expect(stored).not.toHaveProperty("accountId");
  });
});
