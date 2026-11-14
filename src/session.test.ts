/**
 * Tests for the session service: a session can be opened, advanced,
 * closed, and resumed at exactly the step and data where it was closed,
 * and only its owner can do any of that — anyone else is refused
 * generically, the attempt is recorded, and nothing changes.
 */

import { describe, expect, it } from "vitest";

import { RecordLog } from "./record";
import { SessionService } from "./session";
import { MemoryStore, type Store } from "./store";

/**
 * Build a fresh session service, log, and store over one in-memory
 * store, so a test can assert on behaviour, stored state, and the
 * recorded evidence together.
 */
function freshSessions(): {
  service: SessionService;
  log: RecordLog;
  store: Store;
} {
  const store = new MemoryStore();
  const log = new RecordLog(store);
  return { service: new SessionService(store, log), log, store };
}

describe("SessionService close and resume", () => {
  /**
   * Open, advance to "approval" with data, close, then resume: the
   * resumed session is open again at step "approval" with its data
   * intact, and the log shows the whole story including a
   * "session-resume" entry.
   */
  it("resumes a closed session at its exact step with its data", async () => {
    const { service, log } = freshSessions();
    const opened = await service.open("sp-1", "acct-north-bakery");
    expect(opened.step).toBe("intake");
    expect(opened.status).toBe("open");
    const advanced = await service.advance(opened.id, "sp-1", "approval", {
      leadContact: "Priya",
    });
    expect(advanced.ok).toBe(true);
    const closed = await service.close(opened.id, "sp-1");
    expect(closed.ok).toBe(true);
    const resumed = await service.resume(opened.id, "sp-1");
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
   * A resume attempt by the other salesperson is refused generically —
   * the result reveals nothing about the session — a "refuse" entry is
   * recorded, and the stored session stays closed at its saved step.
   */
  it("refuses a resume by the other salesperson and stays closed", async () => {
    const { service, log, store } = freshSessions();
    const opened = await service.open("sp-1", "acct-north-bakery");
    await service.advance(opened.id, "sp-1", "stakeholders");
    await service.close(opened.id, "sp-1");
    const result = await service.resume(opened.id, "sp-2");
    expect(result).toEqual({ ok: false, error: "not yours" });
    expect(JSON.stringify(result)).not.toContain("stakeholders");
    const stored = await store.get("sessions", opened.id);
    expect(stored).toMatchObject({ status: "closed", step: "stakeholders" });
    const refusals = (await log.entries()).filter(
      (entry) => entry.action === "refuse",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].actor).toBe("sp-2");
  });

  /**
   * Resuming a session that was never closed fails closed: there is no
   * saved point to return to, so nothing is reopened or changed.
   */
  it("fails closed when resuming a session that is still open", async () => {
    const { service } = freshSessions();
    const opened = await service.open("sp-1", "acct-north-bakery");
    await expect(service.resume(opened.id, "sp-1")).resolves.toEqual({
      ok: false,
      error: "not closed",
    });
  });
});
