/**
 * The chat agent: a model with governed tools, working for one owner.
 *
 * Each `/chat` turn sends the session's saved conversation plus the new
 * message to the model, together with the governed tool definitions
 * below. The model answers with text or with tool calls; every call is
 * validated strictly and run here, through the memory service and the
 * store, as the session's owner — the `?as=` caller — and never as
 * anyone the model names. Tool arguments carry no owner field, and a
 * call with any unexpected argument is rejected before it runs.
 * Another owner's account or item gets the memory service's one
 * generic refusal, and the attempt is written to the change log. There
 * is no approve tool: approving stays the human `/approve` route and
 * the page's button. The conversation, tool calls and tool results
 * included, is saved on the session document so a later turn — or a
 * resumed session — continues from it.
 *
 * There are no scripted replies. When no model is configured, or the
 * model call fails, the turn fails closed with "model unavailable"
 * and the page shows that error.
 */

import type { Approval, MemoryService } from "./memory";
import type {
  ChatMessage,
  ModelClient,
  ToolCall,
  ToolDefinition,
} from "./model";
import type { MemoryHit } from "./search";
import type { SessionService } from "./session";
import type { JsonRecord, Store } from "./store";

/** Run one owner-scoped memory search; injected so tests need no database. */
export type SearchFn = (
  ownerId: string,
  query: string,
  k: number,
) => Promise<MemoryHit[]>;

/** The result of handling one chat message. */
export type ChatResult =
  | {
      ok: true;
      /** The model's reply to show the salesperson. */
      reply: string;
      /** The most recent proposal from this session still waiting, if any. */
      pendingApproval?: Approval;
    }
  | { ok: false; error: "not found" | "not open" | "model unavailable" };

/** How many memories `search_memories` returns. */
export const SEARCH_LIMIT = 5;

/** Most model calls one chat turn may make before failing closed. */
export const MAX_MODEL_CALLS = 6;

/** Most saved messages replayed to the model on one turn. */
const HISTORY_WINDOW = 40;

/** Longest text a remember, correct, or propose call may store. */
const MAX_TEXT_LENGTH = 4000;

/** The collection accounts live in; matches the governed services. */
const ACCOUNTS = "accounts";

/** The collection memories live in; matches the memory service. */
const MEMORIES = "memories";

/** The one generic refusal a tool returns for anything not the owner's. */
const NOT_FOUND = { ok: false, error: "not found" } as const;

/** The answer to a tool call whose arguments fail validation. */
const INVALID = { ok: false, error: "invalid arguments" } as const;

/**
 * The instructions sent ahead of every conversation. They describe the
 * job and the rules; they are not a reply and never reach the page.
 */
const SYSTEM_PROMPT =
  "You are a sales assistant working for one salesperson. You can only " +
  "see and change that salesperson's own accounts and memories, through " +
  "the tools you are given. Use list_my_accounts to find accounts and " +
  "search_memories before answering anything about an account, a person, " +
  "or past notes. Base every factual statement on tool results; if the " +
  "tools return nothing relevant, say you have no record of it. Use " +
  "remember to save new facts the salesperson tells you, correct to fix " +
  "a saved memory, and forget only when the salesperson asks for a " +
  "memory to be removed. Use propose to draft a change for approval; you " +
  "cannot approve anything — the salesperson approves with the Approve " +
  "button. A tool result of \"not found\" means the item or account is " +
  "not available to this salesperson; say so plainly and do not guess " +
  "at its contents. Keep replies short. All data here is sample data.";

/**
 * The governed tools, in chat-completions function format. None takes
 * an owner: every call runs as the session's owner.
 */
export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_my_accounts",
      description: "List the salesperson's own client accounts (id, name, status).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memories",
      description:
        "Search the salesperson's own saved memories by meaning. Returns up to 5 " +
        "matches with id, account_id, kind, and text.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to look for." } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Save a new memory about one of the salesperson's own accounts.",
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "The account id, from list_my_accounts." },
          text: { type: "string", description: "The fact to remember, in one or two sentences." },
          kind: {
            type: "string",
            description: 'A plain-word category, for example "stakeholder", "budget", or "note".',
          },
        },
        required: ["account_id", "text", "kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "correct",
      description:
        "Replace the text of one of the salesperson's saved memories. The old text " +
        "is kept in the memory's history.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string", description: "The memory id, from search_memories." },
          text: { type: "string", description: "The corrected text." },
        },
        required: ["item_id", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description:
        "Permanently remove the content of one of the salesperson's saved memories. " +
        "Only when the salesperson asks for it.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string", description: "The memory id, from search_memories." },
        },
        required: ["item_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose",
      description:
        "Draft a change for one of the salesperson's own accounts, such as a " +
        "campaign proposal. It is stored as pending and does nothing until the " +
        "salesperson approves it.",
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "The account id, from list_my_accounts." },
          summary: { type: "string", description: "Exactly what would change, in plain words." },
        },
        required: ["account_id", "summary"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Parse a tool call's JSON arguments and check them against an exact
 * list of string fields: every field must be present as a non-empty
 * string no longer than `MAX_TEXT_LENGTH`, and no other key may
 * appear — so an argument such as an owner id is rejected, not
 * ignored. Returns `undefined` on any mismatch.
 */
export function parseArgs(
  raw: string,
  fields: readonly string[],
): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === "" || trimmed.length > MAX_TEXT_LENGTH) {
      return undefined;
    }
    out[field] = trimmed;
  }
  return out;
}

/**
 * Pick the messages to replay to the model: at most `HISTORY_WINDOW`
 * of the newest, starting at a user message so no tool result is sent
 * without the assistant call it answers.
 */
function historyWindow(history: ChatMessage[]): ChatMessage[] {
  if (history.length <= HISTORY_WINDOW) {
    return history;
  }
  const tail = history.slice(history.length - HISTORY_WINDOW);
  const firstUser = tail.findIndex((message) => message.role === "user");
  return firstUser === -1 ? tail : tail.slice(firstUser);
}

/**
 * A keyword search over the store's memories collection, for the
 * in-memory store used in local development, where no vector index
 * exists. Same owner rule as `searchMemories`: only the caller's own,
 * unforgotten memories, ranked by how many query words they contain.
 */
export function storeSearch(store: Store): SearchFn {
  return async (ownerId, query, k) => {
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9$]+/)
      .filter((word) => word.length >= 3);
    const hits: MemoryHit[] = [];
    for (const raw of await store.list(MEMORIES)) {
      if (
        raw.owner_salesperson_id !== ownerId ||
        raw.forgotten === true ||
        typeof raw.text !== "string"
      ) {
        continue;
      }
      const lower = raw.text.toLowerCase();
      const score = words.filter((word) => lower.includes(word)).length;
      if (score === 0) {
        continue;
      }
      hits.push({
        id: String(raw._id ?? raw.id),
        text: raw.text,
        owner_salesperson_id: ownerId,
        kind: typeof raw.kind === "string" ? raw.kind : undefined,
        account_id: typeof raw.account_id === "string" ? raw.account_id : undefined,
        score,
      });
    }
    hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return hits.slice(0, k);
  };
}

/**
 * The chat agent over the governed services.
 *
 * Holds no state of its own: sessions, memories, approvals, and the
 * change log live in the store behind the services it wraps, so a
 * fresh instance per request behaves exactly like a shared one.
 */
export class ChatService {
  /** Wrap the memory service, the session service, their store, and the model. */
  constructor(
    private readonly memory: MemoryService,
    private readonly sessions: SessionService,
    private readonly store: Store,
    private readonly model: ModelClient | undefined,
  ) {}

  /**
   * Handle one message from `ownerId` in one of their sessions.
   *
   * The session is loaded through the session service, so another
   * owner's session gets the generic refusal and a closed session
   * fails closed ("not open") before the model is called. The model
   * is then called in a loop: each tool call it makes is run as
   * `ownerId` and its result fed back, until it answers with text or
   * `MAX_MODEL_CALLS` is reached. No model, a failed call, or no final
   * answer returns "model unavailable" — never a canned reply. The
   * conversation is saved on the session whenever a tool ran or the
   * turn completed, so records and history stay in step.
   */
  async handle(
    ownerId: string,
    sessionId: string,
    text: string,
    search: SearchFn,
  ): Promise<ChatResult> {
    const loaded = await this.sessions.get(sessionId, ownerId);
    if (!loaded.ok) {
      return { ok: false, error: "not found" };
    }
    const session = loaded.session;
    if (session.status !== "open") {
      return { ok: false, error: "not open" };
    }
    if (this.model === undefined) {
      return { ok: false, error: "model unavailable" };
    }
    const history: ChatMessage[] = [
      ...session.history,
      { role: "user", content: text },
    ];
    const proposed: string[] = [];
    let toolRan = false;
    for (let call = 0; call < MAX_MODEL_CALLS; call++) {
      let turn;
      try {
        turn = await this.model.chat(
          [{ role: "system", content: SYSTEM_PROMPT }, ...historyWindow(history)],
          TOOLS,
        );
      } catch {
        break;
      }
      if (turn.tool_calls.length === 0) {
        const reply = (turn.content ?? "").trim();
        if (reply === "") {
          break;
        }
        history.push({ role: "assistant", content: reply });
        const saved = await this.save(session.id, ownerId, history, session.data, proposed);
        return { ok: true, reply, pendingApproval: await this.pending(saved) };
      }
      history.push({
        role: "assistant",
        content: turn.content,
        tool_calls: turn.tool_calls,
      });
      for (const toolCall of turn.tool_calls) {
        const result = await this.runTool(ownerId, toolCall, search, proposed);
        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
      toolRan = true;
    }
    if (toolRan) {
      await this.save(session.id, ownerId, history, session.data, proposed);
    }
    return { ok: false, error: "model unavailable" };
  }

  /**
   * Run one tool call as `ownerId` and return the JSON-ready result fed
   * back to the model. Unknown tools (including any attempt to
   * approve) and invalid arguments are answered with an error the
   * model can read; nothing runs for them. Ids of proposals created
   * are pushed onto `proposed` so the session can track them.
   */
  async runTool(
    ownerId: string,
    call: ToolCall,
    search: SearchFn,
    proposed: string[],
  ): Promise<JsonRecord> {
    const raw = call.function.arguments;
    switch (call.function.name) {
      case "list_my_accounts": {
        if (parseArgs(raw, []) === undefined) {
          return INVALID;
        }
        return { ok: true, accounts: await this.myAccounts(ownerId) };
      }
      case "search_memories": {
        const args = parseArgs(raw, ["query"]);
        if (args === undefined) {
          return INVALID;
        }
        const hits = await search(ownerId, args.query, SEARCH_LIMIT);
        const own = hits
          .filter((hit) => hit.owner_salesperson_id === ownerId)
          .slice(0, SEARCH_LIMIT)
          .map((hit) => ({
            id: hit.id,
            account_id: hit.account_id ?? null,
            kind: hit.kind ?? null,
            text: hit.text,
          }));
        return { ok: true, memories: own };
      }
      case "remember": {
        const args = parseArgs(raw, ["account_id", "text", "kind"]);
        if (args === undefined) {
          return INVALID;
        }
        const result = await this.memory.rememberOnAccount(ownerId, args.account_id, {
          kind: args.kind,
          text: args.text,
        });
        return result.ok ? { ok: true, item_id: result.item.id } : NOT_FOUND;
      }
      case "correct": {
        const args = parseArgs(raw, ["item_id", "text"]);
        if (args === undefined) {
          return INVALID;
        }
        const result = await this.memory.correct(ownerId, args.item_id, "text", args.text);
        return result.ok ? { ok: true, item_id: result.item.id } : NOT_FOUND;
      }
      case "forget": {
        const args = parseArgs(raw, ["item_id"]);
        if (args === undefined) {
          return INVALID;
        }
        const result = await this.memory.forget(ownerId, args.item_id);
        return result.ok ? { ok: true } : NOT_FOUND;
      }
      case "propose": {
        const args = parseArgs(raw, ["account_id", "summary"]);
        if (args === undefined) {
          return INVALID;
        }
        const account = await this.store.get(ACCOUNTS, args.account_id);
        if (account?.kind === "salesperson") {
          return NOT_FOUND;
        }
        const result = await this.memory.propose(ownerId, {
          description: args.summary,
          accountId: args.account_id,
        });
        if (!result.ok) {
          return NOT_FOUND;
        }
        proposed.push(result.approval.id);
        return { ok: true, approval_id: result.approval.id, status: "pending" };
      }
      default:
        return { ok: false, error: "unknown tool" };
    }
  }

  /**
   * List the owner's client accounts from the store: salesperson rows
   * and every other owner's accounts are left out.
   */
  private async myAccounts(ownerId: string): Promise<JsonRecord[]> {
    const accounts: JsonRecord[] = [];
    for (const raw of await this.store.list(ACCOUNTS)) {
      if (raw.kind === "salesperson" || raw.owner_salesperson_id !== ownerId) {
        continue;
      }
      accounts.push({
        id: raw._id ?? raw.id,
        name: typeof raw.name === "string" ? raw.name : null,
        status: typeof raw.status === "string" ? raw.status : null,
      });
    }
    return accounts;
  }

  /**
   * Save the turn's history on the session, adding any new proposal
   * ids to the session's `approvalIds`. Returns the session data as
   * saved (or as it was, if the save was refused).
   */
  private async save(
    sessionId: string,
    ownerId: string,
    history: ChatMessage[],
    data: JsonRecord,
    proposed: string[],
  ): Promise<JsonRecord> {
    const known = Array.isArray(data.approvalIds)
      ? data.approvalIds.filter((id): id is string => typeof id === "string")
      : [];
    const patch = proposed.length > 0 ? { approvalIds: [...known, ...proposed] } : undefined;
    const saved = await this.sessions.saveHistory(sessionId, ownerId, history, patch);
    return saved.ok ? saved.session.data : data;
  }

  /**
   * Return the newest proposal raised in this session that is still
   * pending, so the page can show its approval card.
   */
  private async pending(data: JsonRecord): Promise<Approval | undefined> {
    const ids = Array.isArray(data.approvalIds) ? [...data.approvalIds].reverse() : [];
    for (const id of ids) {
      if (typeof id !== "string") {
        continue;
      }
      const approval = await this.memory.getApproval(id);
      if (approval !== undefined && approval.status === "pending") {
        return approval;
      }
    }
    return undefined;
  }
}
