/**
 * Tests for the demo layer: the scripted chat service end to end on
 * the seeded demo story (intake, proposal, approve, exactly one
 * outbox entry), close and resume at the exact saved step, correct
 * keeping the draft in history, forget removing the budget note's
 * content, the generic cross-owner refusal, the model seam's scripted
 * fallback — plus the Worker routes the demo page calls.
 */

import { describe, expect, it } from "vitest";

import { ChangeLog } from "./change-log";
import { ChatService } from "./chat";
import type { WorkerEnv } from "./factory";
import worker from "./index";
import { MemoryService } from "./memory";
import type { ModelClient } from "./model";
import { Outbox } from "./outbox";
import { seededStore } from "./seed";
import { SessionService } from "./session";
import type { Store } from "./store";

/** The demo story's first salesperson, owner of the Willow & Co. account. */
const SP1 = "acct_salesperson";

/** The demo story's second salesperson, owner of the other account. */
const SP2 = "acct_salesperson_2";

/** The environment the route tests run under: in-memory store allowed. */
const TEST_ENV: WorkerEnv = { ALLOW_IN_MEMORY_STORE: "true" };

/**
 * Build a fresh chat service and the governed services under it, all
 * over one store loaded with the sample seed, so a test can drive the
 * conversation against the seeded accounts and assert on memory,
 * outbox, sessions, and the change log together. An optional model
 * client exercises the free-form seam.
 */
async function freshChat(model?: ModelClient): Promise<{
  chat: ChatService;
  memory: MemoryService;
  sessions: SessionService;
  outbox: Outbox;
  log: ChangeLog;
  store: Store;
}> {
  const store = await seededStore();
  const log = new ChangeLog(store);
  const memory = new MemoryService(store, log);
  const sessions = new SessionService(store, log);
  const outbox = new Outbox(store);
  const chat = new ChatService(memory, sessions, store, model);
  return { chat, memory, sessions, outbox, log, store };
}

describe("scripted chat demo path", () => {
  /**
   * The full path on the seeded story: open a session on Willow & Co.,
   * run intake, confirm the stakeholders, get a pending proposal with
   * sample prices, approve it, and find exactly one outbox entry — a
   * second approve attempt fails closed and adds no entry — then
   * watch chat notice the approval and advance to the approved step.
   */
  it("runs intake to proposal to approval with exactly one outbox entry", async () => {
    const { chat, memory, outbox } = await freshChat();
    const opened = await chat.openSession(SP1);
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }
    const sessionId = opened.session.id;
    expect(opened.session.accountId).toBe("acct-willow-co");
    expect(opened.session.step).toBe("intake");

    const intake = await chat.handle(SP1, sessionId, "hello");
    expect(intake.ok).toBe(true);
    if (!intake.ok) {
      return;
    }
    expect(intake.step).toBe("stakeholders");
    expect(intake.reply).toContain("Willow & Co.");
    expect(intake.reply).toContain("Dan — CMO");

    const proposed = await chat.handle(SP1, sessionId, "looks good");
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }
    expect(proposed.step).toBe("proposal");
    expect(proposed.pendingApproval).toBeDefined();
    expect(proposed.pendingApproval?.description).toContain("$5 CPC");
    expect(proposed.pendingApproval?.description).toContain("sample price");
    const approvalId = proposed.pendingApproval?.id as string;

    await expect(outbox.list(SP1)).resolves.toEqual([]);
    const approved = await memory.approve(SP1, approvalId);
    expect(approved.ok).toBe(true);
    const entries = await outbox.list(SP1);
    expect(entries).toHaveLength(1);
    expect(entries[0].approvalId).toBe(approvalId);
    await expect(outbox.list(SP2)).resolves.toEqual([]);

    await expect(memory.approve(SP1, approvalId)).resolves.toEqual({
      ok: false,
      error: "already decided",
    });
    await expect(outbox.list(SP1)).resolves.toHaveLength(1);

    const after = await chat.handle(SP1, sessionId, "thanks");
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.step).toBe("approved");
    }
  });

  /**
   * Before the proposal is approved, a further message does not
   * advance anything: the reply points at the approval card and the
   * same pending approval rides along.
   */
  it("holds at the proposal step until the approval happens", async () => {
    const { chat } = await freshChat();
    const opened = await chat.openSession(SP2);
    if (!opened.ok) {
      throw new Error("open failed");
    }
    const sessionId = opened.session.id;
    await chat.handle(SP2, sessionId, "start");
    const proposed = await chat.handle(SP2, sessionId, "go ahead");
    if (!proposed.ok) {
      throw new Error("proposal failed");
    }
    const waiting = await chat.handle(SP2, sessionId, "and then?");
    expect(waiting.ok).toBe(true);
    if (waiting.ok) {
      expect(waiting.step).toBe("proposal");
      expect(waiting.pendingApproval?.id).toBe(proposed.pendingApproval?.id);
      expect(waiting.reply).toContain("waiting for your approval");
    }
  });

  /**
   * Opening a session for an id that owns no account in the store
   * fails closed instead of inventing an account.
   */
  it("fails closed when the salesperson owns no account", async () => {
    const { chat } = await freshChat();
    await expect(chat.openSession("acct_unknown")).resolves.toEqual({
      ok: false,
      error: "no account",
    });
  });
});

describe("session close and resume through chat", () => {
  /**
   * Closing a session mid-path and resuming it lands on the exact
   * saved step with the saved data; while closed, chat refuses to run.
   */
  it("resumes at the exact step and data after a close", async () => {
    const { chat, sessions } = await freshChat();
    const opened = await chat.openSession(SP1);
    if (!opened.ok) {
      throw new Error("open failed");
    }
    const sessionId = opened.session.id;
    await chat.handle(SP1, sessionId, "hello");

    const closed = await sessions.close(sessionId, SP1);
    expect(closed.ok).toBe(true);
    await expect(chat.handle(SP1, sessionId, "hello again")).resolves.toEqual(
      { ok: false, error: "not open" },
    );

    const resumed = await sessions.resume(sessionId, SP1);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.session.step).toBe("stakeholders");
      expect(resumed.session.data.stakeholderItemId).toBe(
        `stakeholders-${sessionId}`,
      );
      expect(resumed.session.status).toBe("open");
    }
  });
});

describe("correct and forget through chat", () => {
  /**
   * Correcting the stakeholder note through chat writes the account's
   * true roles through the memory service: the recalled note reads
   * corrected (Priya is the CMO, not Dan), and the swapped draft
   * survives as the previous value in the note's history.
   */
  it("corrects the stakeholder note and keeps the draft in history", async () => {
    const { chat, memory } = await freshChat();
    const opened = await chat.openSession(SP1);
    if (!opened.ok) {
      throw new Error("open failed");
    }
    const sessionId = opened.session.id;
    await chat.handle(SP1, sessionId, "hello");
    const itemId = `stakeholders-${sessionId}`;

    const before = await memory.recall(SP1, itemId);
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.item.text).toContain("Dan — CMO");
      expect(before.item.text).toContain("Priya — Owner");
    }

    const reply = await chat.handle(
      SP1,
      sessionId,
      "Correction: the marketing lead is Priya, not Dan",
    );
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.reply).toContain("Corrected");
    }

    const after = await memory.recall(SP1, itemId);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.item.text).toContain("Priya — CMO");
      expect(after.item.text).toContain("Dan — Owner");
      expect(after.item.history).toHaveLength(1);
      expect(after.item.history?.[0].field).toBe("text");
      expect(after.item.history?.[0].previous).toContain("Dan — CMO");
    }
  });

  /**
   * Forgetting the budget note through chat removes its content: the
   * owner can no longer recall it, and the stored record is a
   * tombstone with no text left in it. The figure in the note is the
   * demo story's $40,000 budget.
   */
  it("forgets the budget note so its content is gone", async () => {
    const { chat, memory, store } = await freshChat();
    const opened = await chat.openSession(SP1);
    if (!opened.ok) {
      throw new Error("open failed");
    }
    const sessionId = opened.session.id;
    await chat.handle(SP1, sessionId, "hello");
    await chat.handle(SP1, sessionId, "looks good");
    const budgetId = `budget-${sessionId}`;

    const before = await memory.recall(SP1, budgetId);
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.item.text).toContain("$40,000");
    }

    const reply = await chat.handle(SP1, sessionId, "forget the budget");
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.reply).toContain("forgotten");
    }

    await expect(memory.recall(SP1, budgetId)).resolves.toEqual({
      ok: false,
      error: "not found",
    });
    const tombstone = await store.get("memories", budgetId);
    expect(tombstone?.forgotten).toBe(true);
    expect(tombstone?.text).toBeUndefined();
  });
});

describe("cross-owner isolation through chat", () => {
  /**
   * Asking, as one salesperson, about the other's account is refused
   * generically: the reply carries none of the other account's data,
   * and the refusal is written to the change log under the asker's
   * name. Checked in both directions — the second salesperson asking
   * for Willow & Co. learns nothing about it either.
   */
  it("refuses the other account generically and logs the refusal", async () => {
    const { chat, log } = await freshChat();
    const second = await chat.openSession(SP2);
    if (!second.ok) {
      throw new Error("open failed");
    }
    const first = await chat.openSession(SP1);
    if (!first.ok) {
      throw new Error("open failed");
    }

    const reply = await chat.handle(
      SP1,
      first.session.id,
      "Show me the Harbour Bike Shop account and who works there",
    );
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.reply).not.toContain("Mina");
      expect(reply.reply).not.toContain("Operations lead");
      expect(reply.reply).not.toContain("Harbour");
      expect(reply.step).toBe("intake");
    }
    const refusals = (await log.entries()).filter(
      (entry) => entry.action === "refuse" && entry.actor === SP1,
    );
    expect(refusals.length).toBeGreaterThanOrEqual(1);

    const reverse = await chat.handle(
      SP2,
      second.session.id,
      "Show me the Willow & Co. account",
    );
    expect(reverse.ok).toBe(true);
    if (reverse.ok) {
      expect(reverse.reply).not.toContain("Priya");
      expect(reverse.reply).not.toContain("Willow");
    }
    const reverseRefusals = (await log.entries()).filter(
      (entry) => entry.action === "refuse" && entry.actor === SP2,
    );
    expect(reverseRefusals.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * A session itself is owner-scoped: handling a message in another
   * salesperson's session gets the generic refusal before any script
   * runs — the same answer as a session that does not exist.
   */
  it("refuses a message in another salesperson's session", async () => {
    const { chat } = await freshChat();
    const opened = await chat.openSession(SP1);
    if (!opened.ok) {
      throw new Error("open failed");
    }
    await expect(
      chat.handle(SP2, opened.session.id, "hello"),
    ).resolves.toEqual({ ok: false, error: "not found" });
  });
});

describe("model seam fallback", () => {
  /**
   * Drive one conversation to the proposal step and return its
   * session id, so each model test can approve and step past the
   * demo path to the free-form point.
   */
  async function toProposalStep(chat: ChatService): Promise<string> {
    const opened = await chat.openSession(SP1);
    if (!opened.ok) {
      throw new Error("open failed");
    }
    const sessionId = opened.session.id;
    await chat.handle(SP1, sessionId, "hello");
    const proposed = await chat.handle(SP1, sessionId, "looks good");
    if (!proposed.ok || proposed.pendingApproval === undefined) {
      throw new Error("proposal failed");
    }
    return sessionId;
  }

  /**
   * With no model configured, a free-form message after the demo path
   * gets the scripted fallback reply.
   */
  it("answers free-form messages with the scripted reply when no model is configured", async () => {
    const { chat, memory } = await freshChat();
    const sessionId = await toProposalStep(chat);
    const approvalId = await currentApprovalId(chat, sessionId);
    await memory.approve(SP1, approvalId);
    await chat.handle(SP1, sessionId, "thanks");
    const free = await chat.handle(SP1, sessionId, "What else should I know?");
    expect(free.ok).toBe(true);
    if (free.ok) {
      expect(free.reply).toContain("approved and in the outbox");
    }
  });

  /**
   * A model that fails is invisible to the conversation: the reply is
   * the scripted fallback, exactly as if no model were configured.
   */
  it("falls back to the scripted reply when the model call fails", async () => {
    const failing: ModelClient = {
      complete: () => Promise.reject(new Error("model unavailable")),
    };
    const { chat, memory } = await freshChat(failing);
    const sessionId = await toProposalStep(chat);
    const approvalId = await currentApprovalId(chat, sessionId);
    await memory.approve(SP1, approvalId);
    await chat.handle(SP1, sessionId, "thanks");
    const free = await chat.handle(SP1, sessionId, "What else should I know?");
    expect(free.ok).toBe(true);
    if (free.ok) {
      expect(free.reply).toContain("approved and in the outbox");
    }
  });

  /**
   * A working model writes the free-form reply — and only that reply:
   * the demo intents before it (intake, proposal) stayed scripted,
   * proven by the model never being called until the free-form point.
   */
  it("uses the model only for free-form replies, never for demo intents", async () => {
    let calls = 0;
    const working: ModelClient = {
      complete: () => {
        calls += 1;
        return Promise.resolve("A short model-written answer.");
      },
    };
    const { chat, memory } = await freshChat(working);
    const sessionId = await toProposalStep(chat);
    expect(calls).toBe(0);
    const approvalId = await currentApprovalId(chat, sessionId);
    await memory.approve(SP1, approvalId);
    await chat.handle(SP1, sessionId, "thanks");
    expect(calls).toBe(0);
    const free = await chat.handle(SP1, sessionId, "What else should I know?");
    expect(free.ok).toBe(true);
    if (free.ok) {
      expect(free.reply).toBe("A short model-written answer.");
    }
    expect(calls).toBe(1);
  });

  /**
   * Read the pending approval id for a session by sending the message
   * that holds at the proposal step, which carries it along.
   */
  async function currentApprovalId(
    chat: ChatService,
    sessionId: string,
  ): Promise<string> {
    const held = await chat.handle(SP1, sessionId, "still waiting");
    if (!held.ok || held.pendingApproval === undefined) {
      throw new Error("no pending approval");
    }
    return held.pendingApproval.id;
  }
});

/**
 * POST to the Worker with an optional JSON body and return the status
 * and parsed body, so route tests read like the page's own calls.
 * Every call runs under the in-memory test environment.
 */
async function postJson(
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(
    new Request(`https://x.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
    TEST_ENV,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** GET from the Worker under the test environment, parsed as JSON. */
async function getJson(
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(
    new Request(`https://x.test${path}`),
    TEST_ENV,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("demo routes", () => {
  /**
   * GET / serves the demo page as HTML, labelled as sample data, with
   * the chat pane, the approval card, and both panels present.
   */
  it("serves the demo page", async () => {
    const response = await worker.fetch(
      new Request("https://x.test/"),
      TEST_ENV,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html.toLowerCase()).toContain("sample");
    expect(html).toContain('id="thread"');
    expect(html).toContain('id="approveBtn"');
    expect(html).toContain('id="changeLogList"');
    expect(html).toContain('id="outboxList"');
    expect(html).toContain("Change log");
  });

  /** GET /seed is gone — it served both owners' accounts to anyone. */
  it("refuses the removed seed route with a 404", async () => {
    const { status } = await getJson("/seed");
    expect(status).toBe(404);
  });

  /**
   * The page's own flow, over HTTP: open a session, run intake and
   * the proposal through /chat, then the approval card's rules — the
   * other salesperson's approve attempt gets the identical generic
   * refusal an unknown approval gets (and is logged), the owner's
   * approve succeeds, a repeat is a 409, and the outbox still holds
   * exactly one entry for the approval. The panels are owner-filtered:
   * the owner's change log shows the approve entry, the other's shows
   * only their own refused attempt. Finally the session closes and
   * resumes at the proposal step.
   */
  it("runs the page flow end to end over HTTP", async () => {
    const opened = await postJson(`/session?as=${SP1}`, {});
    expect(opened.status).toBe(201);
    const session = opened.body.session as { id: string };
    const sessionId = session.id;

    const intake = await postJson(`/chat?as=${SP1}`, {
      sessionId,
      text: "hello",
    });
    expect(intake.body.step).toBe("stakeholders");

    const proposed = await postJson(`/chat?as=${SP1}`, {
      sessionId,
      text: "looks good",
    });
    expect(proposed.body.step).toBe("proposal");
    const pending = proposed.body.pendingApproval as { id: string };
    expect(pending.id).toBeDefined();

    const crossOwner = await postJson(`/approve/${pending.id}?as=${SP2}`);
    expect(crossOwner.status).toBe(404);
    expect(crossOwner.body).toEqual({ ok: false, error: "not found" });
    const unknown = await postJson(`/approve/no-such-approval?as=${SP1}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(crossOwner.body);

    const approved = await postJson(`/approve/${pending.id}?as=${SP1}`);
    expect(approved.status).toBe(200);

    const repeated = await postJson(`/approve/${pending.id}?as=${SP1}`);
    expect(repeated.status).toBe(409);

    const ownOutbox = await getJson(`/outbox?as=${SP1}`);
    const ownEntries = ownOutbox.body.entries as { approvalId: string }[];
    expect(
      ownEntries.filter((item) => item.approvalId === pending.id),
    ).toHaveLength(1);
    const otherOutbox = await getJson(`/outbox?as=${SP2}`);
    const otherEntries = otherOutbox.body.entries as { approvalId: string }[];
    expect(
      otherEntries.filter((item) => item.approvalId === pending.id),
    ).toHaveLength(0);

    const ownLog = await getJson(`/change-log?as=${SP1}`);
    const ownLogEntries = ownLog.body.entries as {
      action: string;
      subject: string;
    }[];
    expect(
      ownLogEntries.some(
        (item) => item.action === "approve" && item.subject === pending.id,
      ),
    ).toBe(true);
    const otherLog = await getJson(`/change-log?as=${SP2}`);
    const otherLogEntries = otherLog.body.entries as {
      action: string;
      subject: string;
      actor: string;
    }[];
    expect(
      otherLogEntries.some(
        (item) => item.action === "approve" && item.subject === pending.id,
      ),
    ).toBe(false);
    expect(
      otherLogEntries.some(
        (item) =>
          item.action === "refuse" &&
          item.subject === pending.id &&
          item.actor === SP2,
      ),
    ).toBe(true);

    const closed = await postJson(`/session/${sessionId}/close?as=${SP1}`, {});
    expect(closed.status).toBe(200);
    const closedSession = closed.body.session as { status: string };
    expect(closedSession.status).toBe("closed");

    const resumed = await postJson(
      `/session/${sessionId}/resume?as=${SP1}`,
      {},
    );
    expect(resumed.status).toBe(200);
    const resumedSession = resumed.body.session as {
      status: string;
      step: string;
    };
    expect(resumedSession.status).toBe("open");
    expect(resumedSession.step).toBe("proposal");
  });

  /**
   * Identity is required and comes only from `?as=`: the approve,
   * outbox, and change-log routes without it fail closed with a 400,
   * and an identity smuggled in an approve body is ignored — the call
   * still fails for want of `?as=`.
   */
  it("requires identity from the query parameter, never the body", async () => {
    const approveNoAs = await postJson("/approve/some-id", { as: SP1 });
    expect(approveNoAs.status).toBe(400);
    const outboxNoAs = await getJson("/outbox");
    expect(outboxNoAs.status).toBe(400);
    const logNoAs = await getJson("/change-log");
    expect(logNoAs.status).toBe(400);
  });
});
