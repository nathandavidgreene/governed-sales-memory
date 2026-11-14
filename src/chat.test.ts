/**
 * Tests for the chat agent: a model with governed tools, run with a
 * fake model client that plays back a fixed list of turns. They cover
 * the owner rule through every tool (the second salesperson can never
 * read, correct, or forget the first salesperson's Harbor memory), the
 * model never choosing the owner, propose creating only a pending
 * approval, the absence of any approve tool, history saved on the
 * session, and model failure answered with an error rather than a
 * canned line — plus the Worker routes the page calls.
 */

import { describe, expect, it } from "vitest";

import { ChangeLog } from "./change-log";
import { ChatService, parseArgs, storeSearch, type SearchFn } from "./chat";
import type { WorkerEnv } from "./factory";
import worker from "./index";
import { MemoryService } from "./memory";
import type {
  AssistantTurn,
  ChatMessage,
  ModelClient,
  ToolDefinition,
} from "./model";
import { Outbox } from "./outbox";
import { seededStore } from "./seed";
import { SessionService } from "./session";
import type { Store } from "./store";

/** The first salesperson, owner of the Harbor Street Media account. */
const SP1 = "acct_salesperson";

/** The second salesperson, who must never see SP1's memories. */
const SP2 = "acct_salesperson_2";

/** SP1's Harbor memory, the one SP2 must never reach. */
const HARBOR_ITEM = "mem_harbor_cmo";

/** The Harbor memory's text; must never appear in anything SP2 gets. */
const HARBOR_TEXT = "The CMO at Harbor Street Media is Jordan Hale.";

/** The environment the route tests run under: in-memory store allowed. */
const TEST_ENV: WorkerEnv = { ALLOW_IN_MEMORY_STORE: "true" };

/**
 * A fake model client that returns the given turns in order and
 * records every conversation it was sent, so a test can script the
 * model's tool calls and inspect what the model saw. Throws once the
 * turns run out, like a failing model.
 */
class FakeModel implements ModelClient {
  /** Every message list the agent sent, one per call. */
  readonly calls: ChatMessage[][] = [];

  /** The tool definitions sent with the most recent call. */
  lastTools: ToolDefinition[] = [];

  /** Hold the turns to play back. */
  constructor(private readonly turns: AssistantTurn[]) {}

  /** Record the call and return the next turn, or throw when none is left. */
  chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantTurn> {
    this.calls.push(structuredClone(messages));
    this.lastTools = tools;
    const next = this.turns.shift();
    if (next === undefined) {
      return Promise.reject(new Error("no more turns"));
    }
    return Promise.resolve(next);
  }
}

/** Build a model turn that calls one tool with the given arguments. */
function callTool(name: string, args: unknown, id = `call-${name}`): AssistantTurn {
  return {
    content: null,
    tool_calls: [
      { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

/** Build a model turn that answers with plain text. */
function say(text: string): AssistantTurn {
  return { content: text, tool_calls: [] };
}

/**
 * Build a fresh agent and the governed services under it over one
 * seeded store, with SP1's Harbor memory added, so a test can drive
 * the agent and assert on memory, approvals, outbox, sessions, and the
 * change log together.
 */
async function freshAgent(model?: ModelClient): Promise<{
  chat: ChatService;
  memory: MemoryService;
  sessions: SessionService;
  outbox: Outbox;
  log: ChangeLog;
  store: Store;
}> {
  const store = await seededStore();
  await store.put("memories", HARBOR_ITEM, {
    _id: HARBOR_ITEM,
    account_id: "acct_harbor",
    kind: "stakeholder",
    owner_salesperson_id: SP1,
    forgotten: false,
    text: HARBOR_TEXT,
  });
  const log = new ChangeLog(store);
  const memory = new MemoryService(store, log);
  const sessions = new SessionService(store, log);
  const chat = new ChatService(memory, sessions, store, model);
  return { chat, memory, sessions, outbox: new Outbox(store), log, store };
}

/** Open a session that must succeed and return its id. */
async function mustOpen(sessions: SessionService, owner: string): Promise<string> {
  const opened = await sessions.open(owner);
  if (!opened.ok) {
    throw new Error(`open failed: ${opened.error}`);
  }
  return opened.session.id;
}

/** Collect every tool result the agent fed back to the model, as text. */
function toolResults(model: FakeModel): string {
  return model.calls
    .flat()
    .filter((message) => message.role === "tool")
    .map((message) => message.content)
    .join("\n");
}

describe("sessions are tied only to their owner", () => {
  /**
   * A new session names no account and no step, starts with an empty
   * history, and records a session-open change log entry.
   */
  it("opens an empty session with no account or step", async () => {
    const { sessions, log } = await freshAgent();
    const opened = await sessions.open(SP1);
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }
    expect(opened.session.history).toEqual([]);
    expect(opened.session).not.toHaveProperty("accountId");
    expect(opened.session).not.toHaveProperty("step");
    const entries = await log.entries();
    expect(entries.at(-1)?.action).toBe("session-open");
  });

  /** An id that is not a known salesperson gets the generic refusal. */
  it("refuses to open a session for an unknown salesperson", async () => {
    const { sessions } = await freshAgent();
    await expect(sessions.open("acct_nobody")).resolves.toEqual({
      ok: false,
      error: "not found",
    });
    await expect(sessions.open("acct_harbor")).resolves.toEqual({
      ok: false,
      error: "not found",
    });
  });
});

describe("the owner rule through every tool", () => {
  /**
   * SP2 searches for the CMO: even with a search layer that leaks
   * Harbor's memory, the agent drops it, so neither the model nor the
   * reply ever sees the Harbor text.
   */
  it("never returns Harbor's memory to SP2 from search, even if search leaks", async () => {
    const model = new FakeModel([
      callTool("search_memories", { query: "who is the chief marketing officer" }),
      say("I have no record of that."),
    ]);
    const { chat, sessions } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP2);
    const leaky: SearchFn = () =>
      Promise.resolve([
        { id: HARBOR_ITEM, text: HARBOR_TEXT, owner_salesperson_id: SP1 },
      ]);
    const result = await chat.handle(SP2, sessionId, "Who is the CMO?", leaky);
    expect(result.ok).toBe(true);
    expect(toolResults(model)).not.toContain("Jordan Hale");
    expect(toolResults(model)).toContain('"memories":[]');
  });

  /**
   * With the real keyword search over the store, SP2 finds nothing of
   * SP1's, while SP1 asking the same question does find the Harbor
   * memory — the owner is the only thing that differs.
   */
  it("scopes the store search to the caller", async () => {
    const { store } = await freshAgent();
    const search = storeSearch(store);
    const forSp2 = await search(SP2, "CMO Harbor Street Media", 5);
    expect(forSp2.map((hit) => hit.id)).not.toContain(HARBOR_ITEM);
    const forSp1 = await search(SP1, "CMO Harbor Street Media", 5);
    expect(forSp1.map((hit) => hit.id)).toContain(HARBOR_ITEM);
  });

  /**
   * SP2's agent tries to correct Harbor's memory: the generic refusal
   * comes back, the memory is unchanged, and the attempt is logged.
   */
  it("refuses SP2 correcting Harbor's memory and logs it", async () => {
    const model = new FakeModel([
      callTool("correct", { item_id: HARBOR_ITEM, text: "The CMO is nobody." }),
      say("I can't change that."),
    ]);
    const { chat, sessions, memory, log } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP2);
    await chat.handle(SP2, sessionId, "Fix the Harbor CMO note.", () => Promise.resolve([]));
    expect(toolResults(model)).toBe(JSON.stringify({ ok: false, error: "not found" }));
    const recalled = await memory.recall(SP1, HARBOR_ITEM);
    expect(recalled.ok && recalled.item.text).toBe(HARBOR_TEXT);
    const entries = await log.entries();
    expect(
      entries.some(
        (entry) => entry.actor === SP2 && entry.action === "refuse" && entry.subject === HARBOR_ITEM,
      ),
    ).toBe(true);
  });

  /**
   * SP2's agent tries to forget Harbor's memory: the generic refusal
   * comes back, SP1 can still read it, and the attempt is logged.
   */
  it("refuses SP2 forgetting Harbor's memory and logs it", async () => {
    const model = new FakeModel([
      callTool("forget", { item_id: HARBOR_ITEM }),
      say("I can't remove that."),
    ]);
    const { chat, sessions, memory, log } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP2);
    await chat.handle(SP2, sessionId, "Forget the Harbor CMO.", () => Promise.resolve([]));
    expect(toolResults(model)).toBe(JSON.stringify({ ok: false, error: "not found" }));
    expect((await memory.recall(SP1, HARBOR_ITEM)).ok).toBe(true);
    const entries = await log.entries();
    expect(entries.filter((entry) => entry.action === "forget")).toEqual([]);
    expect(entries.at(-1)).toMatchObject({ actor: SP2, action: "refuse", subject: HARBOR_ITEM });
  });

  /**
   * SP2 remembering or proposing against SP1's Harbor account gets the
   * generic refusal; nothing is stored and both attempts are logged.
   */
  it("refuses remember and propose on another owner's account", async () => {
    const model = new FakeModel([
      {
        content: null,
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: {
              name: "remember",
              arguments: JSON.stringify({ account_id: "acct_harbor", text: "x", kind: "note" }),
            },
          },
          {
            id: "b",
            type: "function",
            function: {
              name: "propose",
              arguments: JSON.stringify({ account_id: "acct_harbor", summary: "x" }),
            },
          },
        ],
      },
      say("Not available."),
    ]);
    const { chat, sessions, store, log } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP2);
    const before = (await store.list("memories")).length;
    await chat.handle(SP2, sessionId, "Add a Harbor note.", () => Promise.resolve([]));
    expect((await store.list("memories")).length).toBe(before);
    expect(await store.list("approvals")).toEqual([]);
    const refusals = (await log.entries()).filter(
      (entry) => entry.action === "refuse" && entry.subject === "acct_harbor",
    );
    expect(refusals.length).toBe(2);
  });

  /** list_my_accounts returns only the caller's client accounts. */
  it("lists only the caller's own client accounts", async () => {
    const model = new FakeModel([callTool("list_my_accounts", {}), say("Here they are.")]);
    const { chat, sessions } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP2);
    await chat.handle(SP2, sessionId, "What are my accounts?", () => Promise.resolve([]));
    const results = toolResults(model);
    expect(results).toContain("acct_cabot_shore");
    expect(results).not.toContain("acct_harbor");
    expect(results).not.toContain("acct_willow");
    expect(results).not.toContain(SP2);
  });
});

describe("the model cannot choose the owner", () => {
  /**
   * An owner field slipped into a tool call is rejected outright and
   * the search never runs; a clean call runs with the session's owner.
   */
  it("rejects an owner argument and always searches as the caller", async () => {
    const model = new FakeModel([
      callTool("search_memories", { query: "CMO", owner_salesperson_id: SP1 }),
      callTool("search_memories", { query: "CMO" }),
      say("Done."),
    ]);
    const { chat, sessions } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP2);
    const owners: string[] = [];
    const spy: SearchFn = (owner) => {
      owners.push(owner);
      return Promise.resolve([]);
    };
    await chat.handle(SP2, sessionId, "Who is the CMO?", spy);
    expect(owners).toEqual([SP2]);
    expect(toolResults(model)).toContain("invalid arguments");
  });

  /** No tool definition sent to the model offers an owner parameter. */
  it("offers no owner parameter on any tool", async () => {
    const model = new FakeModel([say("Hi.")]);
    const { chat, sessions } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP1);
    await chat.handle(SP1, sessionId, "Hello", () => Promise.resolve([]));
    expect(JSON.stringify(model.lastTools)).not.toContain("owner");
    expect(model.lastTools.map((tool) => tool.function.name)).not.toContain("approve");
  });

  /** parseArgs accepts exactly the named string fields and nothing else. */
  it("validates tool arguments strictly", () => {
    expect(parseArgs('{"query":"x"}', ["query"])).toEqual({ query: "x" });
    expect(parseArgs('{"query":"x","as":"y"}', ["query"])).toBeUndefined();
    expect(parseArgs('{"query":3}', ["query"])).toBeUndefined();
    expect(parseArgs('{"query":"  "}', ["query"])).toBeUndefined();
    expect(parseArgs("not json", ["query"])).toBeUndefined();
    expect(parseArgs("", [])).toEqual({});
  });
});

describe("propose and approve", () => {
  /**
   * propose on the caller's own account creates exactly one pending
   * approval and writes nothing to the outbox; a model attempt to call
   * an "approve" tool is answered "unknown tool" and changes nothing.
   * Only the human approve path decides it.
   */
  it("creates a pending approval only, and the model cannot approve it", async () => {
    const model = new FakeModel([
      callTool("propose", { account_id: "acct_cabot_shore", summary: "Run a spring campaign." }),
      callTool("approve", { approval_id: "anything" }),
      say("Drafted; approve it when ready."),
    ]);
    const { chat, sessions, memory, outbox, store } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP2);
    const result = await chat.handle(SP2, sessionId, "Draft a campaign for Cabot.", () =>
      Promise.resolve([]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.pendingApproval?.status).toBe("pending");
    expect(result.pendingApproval?.accountId).toBe("acct_cabot_shore");
    expect(await store.list("approvals")).toHaveLength(1);
    expect(await outbox.list(SP2)).toEqual([]);
    expect(toolResults(model)).toContain("unknown tool");
    const approvalId = result.pendingApproval?.id ?? "";
    expect((await memory.approve(SP2, approvalId)).ok).toBe(true);
    expect(await outbox.list(SP2)).toHaveLength(1);
  });

  /** remember on the caller's own account stores an item stamped with the account. */
  it("remembers a fact on the caller's own account", async () => {
    const model = new FakeModel([
      callTool("remember", { account_id: "acct_cabot_shore", text: "Sam owns the shop.", kind: "stakeholder" }),
      say("Saved."),
    ]);
    const { chat, sessions, store } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP2);
    await chat.handle(SP2, sessionId, "Sam owns Cabot Shore.", () => Promise.resolve([]));
    const saved = (await store.list("memories")).find((item) => item.text === "Sam owns the shop.");
    expect(saved).toMatchObject({ owner_salesperson_id: SP2, account_id: "acct_cabot_shore" });
  });
});

describe("list_products", () => {
  /**
   * list_products returns each product's name and sample rate label,
   * read-only, and the tool descriptions tell the model to price
   * proposals from it.
   */
  it("returns product names and rate labels without writing anything", async () => {
    const model = new FakeModel([callTool("list_products", {}), say("Two products.")]);
    const { chat, sessions, log } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP1);
    const before = (await log.entries()).length;
    await chat.handle(SP1, sessionId, "What can I sell?", () => Promise.resolve([]));
    const results = toolResults(model);
    expect(results).toContain("Managed Native Advertising");
    expect(results).toContain("$5 CPC (per click)");
    expect(results).toContain("sample price");
    expect((await log.entries()).length).toBe(before);
    const propose = model.lastTools.find((tool) => tool.function.name === "propose");
    expect(propose?.function.description).toContain("list_products");
  });

  /** A product with no name falls back to its channel; one with no rate label is left out. */
  it("names a product by its channel and skips unpriced products", async () => {
    const model = new FakeModel([callTool("list_products", {}), say("Ok.")]);
    const { chat, sessions, store } = await freshAgent(model);
    await store.put("products", "prod_x", { _id: "prod_x", channel: "audio", rate_label: "$9 CPM" });
    await store.put("products", "prod_y", { _id: "prod_y", name: "Unpriced" });
    const sessionId = await mustOpen(sessions, SP1);
    await chat.handle(SP1, sessionId, "Products?", () => Promise.resolve([]));
    const results = toolResults(model);
    expect(results).toContain('"name":"audio"');
    expect(results).not.toContain("Unpriced");
  });
});

describe("history and failure", () => {
  /**
   * The conversation, tool calls and results included, is saved on the
   * session and replayed on the next turn, and survives close/resume.
   */
  it("saves history on the session and replays it", async () => {
    const model = new FakeModel([
      callTool("list_my_accounts", {}),
      say("You have Cabot Shore."),
      say("Still Cabot Shore."),
    ]);
    const { chat, sessions } = await freshAgent(model);
    const sessionId = await mustOpen(sessions, SP2);
    await chat.handle(SP2, sessionId, "My accounts?", () => Promise.resolve([]));
    await sessions.close(sessionId, SP2);
    await sessions.resume(sessionId, SP2);
    const second = await chat.handle(SP2, sessionId, "And now?", () => Promise.resolve([]));
    expect(second).toMatchObject({ ok: true, reply: "Still Cabot Shore." });
    const replayed = model.calls.at(-1) ?? [];
    expect(replayed.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    const stored = await sessions.get(sessionId, SP2);
    expect(stored.ok && stored.session.history).toHaveLength(6);
  });

  /** A failing model returns the plain error, never a canned reply, and saves nothing. */
  it("returns model unavailable when the model call fails", async () => {
    const { chat, sessions } = await freshAgent(new FakeModel([]));
    const sessionId = await mustOpen(sessions, SP1);
    await expect(
      chat.handle(SP1, sessionId, "Hello", () => Promise.resolve([])),
    ).resolves.toEqual({ ok: false, error: "model unavailable" });
    const stored = await sessions.get(sessionId, SP1);
    expect(stored.ok && stored.session.history).toEqual([]);
  });

  /** With no model configured the agent fails closed with the same error. */
  it("returns model unavailable when no model is configured", async () => {
    const { chat, sessions } = await freshAgent();
    const sessionId = await mustOpen(sessions, SP1);
    await expect(
      chat.handle(SP1, sessionId, "Hello", () => Promise.resolve([])),
    ).resolves.toEqual({ ok: false, error: "model unavailable" });
  });

  /** A model that never stops calling tools is cut off and fails closed. */
  it("fails closed when the model never gives a final answer", async () => {
    const turns = Array.from({ length: 10 }, (_, i) => callTool("list_my_accounts", {}, `c${i}`));
    const { chat, sessions } = await freshAgent(new FakeModel(turns));
    const sessionId = await mustOpen(sessions, SP1);
    await expect(
      chat.handle(SP1, sessionId, "Loop", () => Promise.resolve([])),
    ).resolves.toEqual({ ok: false, error: "model unavailable" });
  });

  /** Another owner's session gets the generic refusal; a closed one is "not open". */
  it("refuses another owner's session and a closed session", async () => {
    const { chat, sessions } = await freshAgent(new FakeModel([say("x")]));
    const sessionId = await mustOpen(sessions, SP1);
    await expect(
      chat.handle(SP2, sessionId, "Hello", () => Promise.resolve([])),
    ).resolves.toEqual({ ok: false, error: "not found" });
    await sessions.close(sessionId, SP1);
    await expect(
      chat.handle(SP1, sessionId, "Hello", () => Promise.resolve([])),
    ).resolves.toEqual({ ok: false, error: "not open" });
  });
});

/**
 * Send a request to the Worker under the in-memory test environment
 * and return the status and parsed JSON body.
 */
async function call(
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(
    new Request(`https://x.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
    TEST_ENV,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("agent routes", () => {
  /**
   * The page opens on a blank chat: no starter message, no step label,
   * no canned account copy, and no innerHTML use.
   */
  it("serves a page with no scripted content", async () => {
    const response = await worker.fetch(new Request("https://x.test/"), TEST_ENV);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain("Let's start");
    expect(html).not.toContain("step");
    expect(html).not.toContain("Willow");
    expect(html).not.toContain("innerHTML");
    expect(html).toContain("Pending approval");
    expect(html).toContain("Change log");
  });

  /**
   * POST /session opens an owner-only session; POST /chat without a
   * model configured answers 503 "model unavailable", not a reply.
   */
  it("opens a session and fails closed on chat without a model", async () => {
    const opened = await call("POST", `/session?as=${SP1}`, {});
    expect(opened.status).toBe(201);
    const session = opened.body.session as Record<string, unknown>;
    expect(session.history).toEqual([]);
    expect(session).not.toHaveProperty("accountId");
    const chatted = await call("POST", `/chat?as=${SP1}`, { sessionId: session.id, text: "Hello" });
    expect(chatted.status).toBe(503);
    expect(chatted.body).toEqual({ ok: false, error: "model unavailable" });
  });

  /** Identity comes from the query parameter only, never the body. */
  it("requires identity from the query parameter", async () => {
    const noAs = await call("POST", "/session", { as: SP1 });
    expect(noAs.status).toBe(400);
    const unknown = await call("POST", "/session?as=acct_nobody", {});
    expect(unknown.status).toBe(404);
  });
});
