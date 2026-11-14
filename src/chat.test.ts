/**
 * Tests for the demo layer: the scripted chat service end to end
 * (intake, proposal, approve, exactly one outbox entry), close and
 * resume at the exact saved step, correct keeping the draft in
 * history, forget removing the budget note's content, and the generic
 * cross-owner refusal — plus the Worker routes the demo page calls.
 */

import { describe, expect, it } from "vitest";

import { ChatService } from "./chat";
import worker from "./index";
import { MemoryService } from "./memory";
import { Outbox } from "./outbox";
import { RecordLog } from "./record";
import { SessionService } from "./session";
import { MemoryStore, type Store } from "./store";

/**
 * Build a fresh chat service and the governed services under it, all
 * over one in-memory store, so a test can drive the conversation and
 * assert on memory, outbox, sessions, and the record log together.
 */
function freshChat(): {
  chat: ChatService;
  memory: MemoryService;
  sessions: SessionService;
  outbox: Outbox;
  log: RecordLog;
  store: Store;
} {
  const store = new MemoryStore();
  const log = new RecordLog(store);
  const memory = new MemoryService(store, log);
  const sessions = new SessionService(store, log);
  const outbox = new Outbox(store);
  const chat = new ChatService(memory, sessions, store);
  return { chat, memory, sessions, outbox, log, store };
}

describe("scripted chat demo path", () => {
  /**
   * The full path: open a session, run intake, confirm the
   * stakeholders, get a pending proposal with sample prices, approve
   * it, and find exactly one outbox entry — a second approve attempt
   * fails closed and adds no entry — then watch chat notice the
   * approval and advance to the approved step.
   */
  it("runs intake to proposal to approval with exactly one outbox entry", async () => {
    const { chat, memory, outbox } = freshChat();
    const opened = await chat.openSession("sp-1");
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }
    const sessionId = opened.session.id;
    expect(opened.session.accountId).toBe("acct-north-bakery");
    expect(opened.session.step).toBe("intake");

    const intake = await chat.handle("sp-1", sessionId, "hello");
    expect(intake.ok).toBe(true);
    if (!intake.ok) {
      return;
    }
    expect(intake.step).toBe("stakeholders");
    expect(intake.reply).toContain("North Bakery");
    expect(intake.reply).toContain("Dan — Marketing lead");

    const proposed = await chat.handle("sp-1", sessionId, "looks good");
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) {
      return;
    }
    expect(proposed.step).toBe("proposal");
    expect(proposed.pendingApproval).toBeDefined();
    expect(proposed.pendingApproval?.description).toContain("$5 CPC");
    expect(proposed.pendingApproval?.description).toContain("sample price");
    const approvalId = proposed.pendingApproval?.id as string;

    await expect(outbox.list()).resolves.toEqual([]);
    const approved = await memory.approve("sp-1", approvalId);
    expect(approved.ok).toBe(true);
    const entries = await outbox.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].approvalId).toBe(approvalId);

    await expect(memory.approve("sp-1", approvalId)).resolves.toEqual({
      ok: false,
      error: "already decided",
    });
    await expect(outbox.list()).resolves.toHaveLength(1);

    const after = await chat.handle("sp-1", sessionId, "thanks");
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
    const { chat } = freshChat();
    const opened = await chat.openSession("sp-2");
    if (!opened.ok) {
      throw new Error("open failed");
    }
    const sessionId = opened.session.id;
    await chat.handle("sp-2", sessionId, "start");
    const proposed = await chat.handle("sp-2", sessionId, "go ahead");
    if (!proposed.ok) {
      throw new Error("proposal failed");
    }
    const waiting = await chat.handle("sp-2", sessionId, "and then?");
    expect(waiting.ok).toBe(true);
    if (waiting.ok) {
      expect(waiting.step).toBe("proposal");
      expect(waiting.pendingApproval?.id).toBe(proposed.pendingApproval?.id);
      expect(waiting.reply).toContain("waiting for your approval");
    }
  });

  /**
   * Opening a session for an id that owns no seeded account fails
   * closed instead of inventing an account.
   */
  it("fails closed when the salesperson owns no account", async () => {
    const { chat } = freshChat();
    await expect(chat.openSession("sp-99")).resolves.toEqual({
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
    const { chat, sessions } = freshChat();
    const opened = await chat.openSession("sp-1");
    if (!opened.ok) {
      throw new Error("open failed");
    }
    const sessionId = opened.session.id;
    await chat.handle("sp-1", sessionId, "hello");

    const closed = await sessions.close(sessionId, "sp-1");
    expect(closed.ok).toBe(true);
    await expect(chat.handle("sp-1", sessionId, "hello again")).resolves.toEqual(
      { ok: false, error: "not open" },
    );

    const resumed = await sessions.resume(sessionId, "sp-1");
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
   * corrected, and the swapped draft survives as the previous value in
   * the note's history.
   */
  it("corrects the stakeholder note and keeps the draft in history", async () => {
    const { chat, memory } = freshChat();
    const opened = await chat.openSession("sp-1");
    if (!opened.ok) {
      throw new Error("open failed");
    }
    const sessionId = opened.session.id;
    await chat.handle("sp-1", sessionId, "hello");
    const itemId = `stakeholders-${sessionId}`;

    const before = await memory.recall("sp-1", itemId);
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.item.text).toContain("Dan — Marketing lead");
      expect(before.item.text).toContain("Priya — Owner");
    }

    const reply = await chat.handle(
      "sp-1",
      sessionId,
      "Correction: the marketing lead is Priya, not Dan",
    );
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.reply).toContain("Corrected");
    }

    const after = await memory.recall("sp-1", itemId);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.item.text).toContain("Priya — Marketing lead");
      expect(after.item.text).toContain("Dan — Owner");
      expect(after.item.history).toHaveLength(1);
      expect(after.item.history?.[0].field).toBe("text");
      expect(after.item.history?.[0].previous).toContain(
        "Dan — Marketing lead",
      );
    }
  });

  /**
   * Forgetting the budget note through chat removes its content: the
   * owner can no longer recall it, and the stored record is a
   * tombstone with no text left in it.
   */
  it("forgets the budget note so its content is gone", async () => {
    const { chat, memory, store } = freshChat();
    const opened = await chat.openSession("sp-1");
    if (!opened.ok) {
      throw new Error("open failed");
    }
    const sessionId = opened.session.id;
    await chat.handle("sp-1", sessionId, "hello");
    await chat.handle("sp-1", sessionId, "looks good");
    const budgetId = `budget-${sessionId}`;

    const before = await memory.recall("sp-1", budgetId);
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.item.text).toContain("$4,000");
    }

    const reply = await chat.handle("sp-1", sessionId, "forget the budget");
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.reply).toContain("forgotten");
    }

    await expect(memory.recall("sp-1", budgetId)).resolves.toEqual({
      ok: false,
      error: "not found",
    });
    const tombstone = await store.get("memory_items", budgetId);
    expect(tombstone?.forgotten).toBe(true);
    expect(tombstone?.text).toBeUndefined();
  });
});

describe("cross-owner isolation through chat", () => {
  /**
   * Asking, as one salesperson, about the other's account goes through
   * the memory read rule: the reply is generic and carries none of the
   * other account's data, and the refusal is written to the record log
   * under the asker's name.
   */
  it("refuses the other account generically and logs the refusal", async () => {
    const { chat, log } = freshChat();
    const second = await chat.openSession("sp-2");
    if (!second.ok) {
      throw new Error("open failed");
    }
    const first = await chat.openSession("sp-1");
    if (!first.ok) {
      throw new Error("open failed");
    }

    const reply = await chat.handle(
      "sp-1",
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
      (entry) => entry.action === "refuse" && entry.actor === "sp-1",
    );
    expect(refusals.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * A session itself is owner-scoped: handling a message in another
   * salesperson's session is refused before any script runs.
   */
  it("refuses a message in another salesperson's session", async () => {
    const { chat } = freshChat();
    const opened = await chat.openSession("sp-1");
    if (!opened.ok) {
      throw new Error("open failed");
    }
    await expect(
      chat.handle("sp-2", opened.session.id, "hello"),
    ).resolves.toEqual({ ok: false, error: "not yours" });
  });
});

/**
 * POST a JSON body to the Worker and return the status and parsed
 * body, so route tests read like the page's own calls.
 */
async function postJson(
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(
    new Request(`https://x.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("demo routes", () => {
  /**
   * GET / serves the demo page as HTML, labelled as sample data, with
   * the chat pane and the approval card present.
   */
  it("serves the demo page", async () => {
    const response = await worker.fetch(new Request("https://x.test/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html.toLowerCase()).toContain("sample");
    expect(html).toContain('id="thread"');
    expect(html).toContain('id="approveBtn"');
    expect(html).toContain('id="recordsList"');
    expect(html).toContain('id="outboxList"');
  });

  /**
   * The page's own flow, over HTTP: open a session, run intake and the
   * proposal through /chat, approve through /approve (a repeat approve
   * is a 409 and the outbox still holds exactly one entry for the
   * approval), see the approve entry in /records, then close and
   * resume the session at the proposal step through the session routes.
   */
  it("runs the page flow end to end over HTTP", async () => {
    const opened = await postJson("/session", { ownerId: "sp-1" });
    expect(opened.status).toBe(201);
    const session = opened.body.session as { id: string };
    const sessionId = session.id;

    const intake = await postJson("/chat", {
      sessionId,
      as: "sp-1",
      text: "hello",
    });
    expect(intake.body.step).toBe("stakeholders");

    const proposed = await postJson("/chat", {
      sessionId,
      as: "sp-1",
      text: "looks good",
    });
    expect(proposed.body.step).toBe("proposal");
    const pending = proposed.body.pendingApproval as { id: string };
    expect(pending.id).toBeDefined();

    const approved = await postJson(`/approve/${pending.id}`, { as: "sp-1" });
    expect(approved.status).toBe(200);
    const entry = approved.body.entry as { approvalId: string };
    expect(entry.approvalId).toBe(pending.id);

    const repeated = await postJson(`/approve/${pending.id}`, { as: "sp-1" });
    expect(repeated.status).toBe(409);

    const outboxResponse = await worker.fetch(
      new Request("https://x.test/outbox"),
    );
    const outboxBody = (await outboxResponse.json()) as {
      entries: { approvalId: string }[];
    };
    expect(
      outboxBody.entries.filter((item) => item.approvalId === pending.id),
    ).toHaveLength(1);

    const recordsResponse = await worker.fetch(
      new Request("https://x.test/records"),
    );
    const recordsBody = (await recordsResponse.json()) as {
      entries: { action: string; subject: string }[];
    };
    expect(
      recordsBody.entries.some(
        (item) => item.action === "approve" && item.subject === pending.id,
      ),
    ).toBe(true);

    const closed = await postJson(`/session/${sessionId}/close?as=sp-1`, {});
    expect(closed.status).toBe(200);
    const closedSession = closed.body.session as { status: string };
    expect(closedSession.status).toBe("closed");

    const resumed = await postJson(`/session/${sessionId}/resume?as=sp-1`, {});
    expect(resumed.status).toBe(200);
    const resumedSession = resumed.body.session as {
      status: string;
      step: string;
    };
    expect(resumedSession.status).toBe("open");
    expect(resumedSession.step).toBe("proposal");
  });
});
