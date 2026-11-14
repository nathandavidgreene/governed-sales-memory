/**
 * The chat: the agent's voice for the demo.
 *
 * The demo-critical intents — intake, correct, forget, propose, and
 * every refusal — are scripted and deterministic: replies are chosen
 * by plain keyword and intent matching, so the demo behaves the same
 * way on every run. Only free-form replies, after the demo path is
 * complete, may come from a model (see `model.ts`); when no model is
 * configured, or the model call fails, the scripted reply answers
 * instead, so a model can never break the demo.
 *
 * The chat works on whatever the store holds: accounts are read from
 * the store (the seeded database when one is connected), never from a
 * hard-coded sample. An account record carries no stakeholder map and
 * no budget — the stakeholders and the budget figure come from the
 * salesperson's intake conversation, are parsed out of what they say,
 * and are written as memory items through the memory service's
 * governed remember path. The correction and the forget then operate
 * on those same memories: a correction rewrites the stakeholder note
 * through the memory service (the earlier version stays in the note's
 * history), and forgetting removes the budget note's content. The
 * script walks one working session through the demo path — intake,
 * the stakeholder note, a campaign proposal priced from the products'
 * own sample rate labels that waits for approval, and the approval
 * landing in the outbox — and answers three governance intents at any
 * step: correct the note, forget the budget note, and ask for another
 * salesperson's account (refused generically; the session service's
 * ownership check makes the refusal and writes it to the change log).
 */

import type { Approval, MemoryService } from "./memory";
import type { ModelClient } from "./model";
import type { Session, SessionService } from "./session";
import type { JsonRecord, Store } from "./store";

/** The result of handling one chat message. */
export type ChatResult =
  | {
      ok: true;
      /** The reply to show the salesperson. */
      reply: string;
      /** The session's step after this message. */
      step: string;
      /** The proposal waiting for approval, when there is one. */
      pendingApproval?: Approval;
    }
  | { ok: false; error: "not found" | "not open" };

/** The result of opening a session through the chat service. */
export type OpenSessionResult =
  | { ok: true; session: Session }
  | { ok: false; error: "no account" };

/** The collection accounts live in; matches the governed services. */
const ACCOUNTS = "accounts";

/** The collection products live in; the proposal prices from these. */
const PRODUCTS = "products";

/**
 * One stakeholder, as gathered from the intake conversation: a name
 * and the role the salesperson says they hold. Stakeholders live in
 * the session's data and in the stakeholder note memory — never on
 * the account record.
 */
interface Stakeholder {
  name: string;
  role: string;
}

/**
 * An account as the chat needs it, read from the store.
 * The store's document is the source; this is only the shape the chat
 * relies on, parsed tolerantly. The account holds no stakeholders and
 * no budget; `readyForIntake` mirrors the seed's "ready_for_intake"
 * status, which marks the account a new working session starts on.
 */
interface StoredAccount {
  id: string;
  name: string;
  owner_salesperson_id: string;
  readyForIntake: boolean;
}

/**
 * Read a stored document as an account, or return `undefined` when it
 * is not a client account: the accounts collection also holds the
 * salespeople's own rows (`kind: "salesperson"`), which are skipped,
 * and a document without an id (its own or its `_id` key), a name,
 * and an owner is not an account either.
 */
function asAccount(raw: JsonRecord): StoredAccount | undefined {
  if (raw.kind === "salesperson") {
    return undefined;
  }
  const id = raw.id ?? raw._id;
  if (
    typeof id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.owner_salesperson_id !== "string"
  ) {
    return undefined;
  }
  return {
    id,
    name: raw.name,
    owner_salesperson_id: raw.owner_salesperson_id,
    readyForIntake:
      raw.status === "ready_for_intake" || raw.ready_for_intake === true,
  };
}

/**
 * Read a string field out of a session's saved data.
 * Saved data is plain JSON, so a field of any other shape reads as
 * absent rather than being guessed at.
 */
function stringField(data: JsonRecord, field: string): string | undefined {
  const value = data[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Read the stakeholder list out of a session's saved data.
 * Saved data is plain JSON; entries that are not a name/role pair are
 * dropped rather than guessed at, and a field of any other shape
 * reads as an empty list.
 */
function stakeholdersField(data: JsonRecord): Stakeholder[] {
  const value = data["stakeholders"];
  if (!Array.isArray(value)) {
    return [];
  }
  const stakeholders: Stakeholder[] = [];
  for (const entry of value) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as JsonRecord).name === "string" &&
      typeof (entry as JsonRecord).role === "string"
    ) {
      stakeholders.push({
        name: (entry as JsonRecord).name as string,
        role: (entry as JsonRecord).role as string,
      });
    }
  }
  return stakeholders;
}

/**
 * Render a stakeholder list as the stakeholder note's text: one
 * sentence naming the account and each person with their role.
 */
function stakeholderNoteText(
  account: StoredAccount,
  stakeholders: Stakeholder[],
): string {
  const parts = stakeholders.map((person) => `${person.name} — ${person.role}`);
  return `Stakeholders for ${account.name}: ${parts.join("; ")}.`;
}

/**
 * Clean up a role phrase lifted out of a sentence: collapse runs of
 * whitespace and drop a trailing full stop, keeping the words (and
 * their case) exactly as spoken otherwise.
 */
function cleanRole(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/\.$/, "").trim();
}

/**
 * Parse the stakeholder statements out of a conversation message.
 * Recognises the two plain ways the intake states them — "Dan is the
 * CMO" and "Priya runs operations" — in order of appearance. A person
 * named twice keeps their first position and their last-stated role.
 * Anything that does not match either shape is ignored: the parser
 * never invents a stakeholder the salesperson did not name.
 */
function parseStakeholders(text: string): Stakeholder[] {
  const found: { index: number; name: string; role: string }[] = [];
  const patterns = [
    /([A-Z][A-Za-z]+)\s+is\s+(?:the\s+)?([A-Za-z][A-Za-z ]*?)(?=\s*(?:,|;|\.|$|\band\b|\bbut\b))/g,
    /([A-Z][A-Za-z]+)\s+runs\s+([A-Za-z][A-Za-z ]*?)(?=\s*(?:,|;|\.|$|\band\b|\bbut\b))/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const role = cleanRole(match[2]);
      if (role !== "") {
        found.push({ index: match.index, name: match[1], role });
      }
    }
  }
  found.sort((a, b) => a.index - b.index);
  const stakeholders: Stakeholder[] = [];
  for (const entry of found) {
    const existing = stakeholders.find(
      (person) => person.name.toLowerCase() === entry.name.toLowerCase(),
    );
    if (existing === undefined) {
      stakeholders.push({ name: entry.name, role: entry.role });
    } else {
      existing.role = entry.role;
    }
  }
  return stakeholders;
}

/**
 * Parse the budget figure out of a conversation message: the first
 * dollar amount mentioned, rendered as it was given (for example
 * "$40,000"). Returns `undefined` when the message names no figure —
 * the chat never invents a budget.
 */
function parseBudgetFigure(text: string): string | undefined {
  const match = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/.exec(text);
  if (match === null) {
    return undefined;
  }
  const digits = match[1].endsWith(".00") ? match[1].slice(0, -3) : match[1];
  return `$${digits}`;
}

/** Role words that name the same job in plain speech. */
const ROLE_FAMILY: ReadonlySet<string> = new Set([
  "cmo",
  "marketing lead",
  "chief marketing officer",
]);

/**
 * Whether two role phrases name the same role: equal once case is
 * ignored, one containing the other, or both in the plain-speech
 * family that treats "CMO" and "marketing lead" as the same job.
 */
function roleMatches(a: string, b: string): boolean {
  const left = a.toLowerCase().trim();
  const right = b.toLowerCase().trim();
  if (left === right) {
    return true;
  }
  if (ROLE_FAMILY.has(left) && ROLE_FAMILY.has(right)) {
    return true;
  }
  return (
    (left.length >= 3 && right.includes(left)) ||
    (right.length >= 3 && left.includes(right))
  );
}

/**
 * Apply a correction message to a stakeholder list.
 * The correction restates who holds a role — "Priya is the CMO, not
 * Dan", or "the marketing lead is Priya" — and the person who held
 * that role takes the corrected person's old role in exchange: a
 * swap, which is what the demo's intake got wrong. People the
 * correction does not name keep their roles, and a correction naming
 * nobody on the list changes nothing.
 */
function applyCorrection(
  stakeholders: Stakeholder[],
  text: string,
): { stakeholders: Stakeholder[]; changed: boolean } {
  const statements: { name: string; role: string }[] = [
    ...parseStakeholders(text),
  ];
  for (const match of text.matchAll(
    /(marketing lead|chief marketing officer|cmo)\s+is\s+([A-Z][A-Za-z]+)/gi,
  )) {
    const holder = stakeholders.find((person) =>
      roleMatches(person.role, match[1]),
    );
    if (holder !== undefined) {
      statements.push({ name: match[2], role: holder.role });
    }
  }
  const next = stakeholders.map((person) => ({ ...person }));
  let changed = false;
  for (const statement of statements) {
    const person = next.find(
      (entry) => entry.name.toLowerCase() === statement.name.toLowerCase(),
    );
    if (person === undefined || roleMatches(person.role, statement.role)) {
      continue;
    }
    const holder = next.find(
      (entry) => entry !== person && roleMatches(entry.role, statement.role),
    );
    if (holder !== undefined) {
      holder.role = person.role;
    }
    person.role = statement.role;
    changed = true;
  }
  return { stakeholders: next, changed };
}

/**
 * Whether a message is asking to correct the stakeholder note.
 * Matches an explicit "correct"/"correction", or a restatement of who
 * holds the marketing lead role ("the marketing lead is Priya, not
 * Dan"); "CMO" is accepted as the same role in plain speech.
 */
function isCorrection(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("correct") ||
    /(marketing lead|cmo)\s+is\s+\w+/.test(lower) ||
    /\bis\s+(the\s+)?(marketing lead|cmo)\b/.test(lower)
  );
}

/**
 * The scripted lines the proposal falls back to when the store holds
 * no products with rate labels: the demo's sample prices, labelled as
 * samples. Used only to render the proposal text; nothing is stored
 * from here.
 */
const SAMPLE_PRICE_LINES: readonly string[] = [
  "Managed Native Advertising at $5 CPC (per click) — sample price",
  "Managed Display Advertising at $25 vCPM (per 1,000 viewable impressions) — sample price",
];

/**
 * Words in an account's stored name that carry no identifying signal
 * (every sample account's name contains them), excluded from the name
 * matching that spots a request about another salesperson's account.
 */
const NAME_STOPWORDS: ReadonlySet<string> = new Set(["sample", "account"]);

/**
 * The chat service over the governed services.
 *
 * Holds no state of its own: sessions, memory items, approvals, and the
 * change log all live in the store behind the services it wraps, so a
 * fresh instance per request behaves exactly like a shared one. The
 * model client is optional and is consulted only for free-form replies.
 */
export class ChatService {
  /** Wrap the memory service, the session service, and their store. */
  constructor(
    private readonly memory: MemoryService,
    private readonly sessions: SessionService,
    private readonly store: Store,
    private readonly model?: ModelClient,
  ) {}

  /**
   * Open a working session for one salesperson on their account.
   * The account is read from the store; when the salesperson owns
   * several, the one marked ready for intake is used (accounts are
   * otherwise taken first by id, so the choice is deterministic).
   * Fails closed with "no account" when the id owns no account in the
   * store. The session service makes the final ownership check.
   */
  async openSession(ownerId: string): Promise<OpenSessionResult> {
    const accounts = await this.accounts();
    const owned = accounts
      .filter((account) => account.owner_salesperson_id === ownerId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const account =
      owned.find((candidate) => candidate.readyForIntake) ?? owned[0];
    if (account === undefined) {
      return { ok: false, error: "no account" };
    }
    const opened = await this.sessions.open(ownerId, account.id);
    if (!opened.ok) {
      return { ok: false, error: "no account" };
    }
    return { ok: true, session: opened.session };
  }

  /**
   * Handle one message from `ownerId` in one of their sessions.
   * The session is loaded through the session service, so another
   * owner's session gets the generic refusal and a closed session
   * fails closed ("not open") before any intent is considered.
   * Intents (another account, forget, correct) are checked before the
   * step script, so they work at any point in the conversation.
   */
  async handle(
    ownerId: string,
    sessionId: string,
    text: string,
  ): Promise<ChatResult> {
    const loaded = await this.sessions.get(sessionId, ownerId);
    if (!loaded.ok) {
      return { ok: false, error: "not found" };
    }
    const session = loaded.session;
    if (session.status !== "open") {
      return { ok: false, error: "not open" };
    }
    const account = await this.accountById(session.accountId);
    if (account === undefined) {
      return { ok: false, error: "not found" };
    }
    const lower = text.toLowerCase();

    const other = await this.matchOtherAccount(ownerId, lower);
    if (other !== undefined) {
      // The session service's ownership check decides: the attempt is
      // refused and written to the change log. The reply is the same
      // whatever the check found, and carries none of the other
      // account's data.
      await this.refuseOtherAccountRead(ownerId, other);
      return this.withPending(
        session,
        "I can't show you that. Accounts and their memory belong to the " +
          "salesperson who owns them, and I can only work with your own. " +
          "The refusal has been written to the change log.",
      );
    }
    if (lower.includes("forget")) {
      return this.handleForget(ownerId, session, lower);
    }
    if (isCorrection(text)) {
      const corrected = await this.handleCorrect(ownerId, session, account, text);
      if (corrected !== null) {
        return corrected;
      }
    }
    const stepped = await this.handleStep(ownerId, session, account, text);
    if (stepped !== null) {
      return stepped;
    }
    return this.freeForm(ownerId, session, account, text);
  }

  /** Read every client account in the store, in the shape the chat relies on. */
  private async accounts(): Promise<StoredAccount[]> {
    const raw = await this.store.list(ACCOUNTS);
    const accounts: StoredAccount[] = [];
    for (const record of raw) {
      const account = asAccount(record);
      if (account !== undefined) {
        accounts.push(account);
      }
    }
    return accounts;
  }

  /** Read one account from the store by id, in the chat's shape. */
  private async accountById(accountId: string): Promise<StoredAccount | undefined> {
    const raw = await this.store.get(ACCOUNTS, accountId);
    return raw === undefined ? undefined : asAccount(raw);
  }

  /**
   * Make one ownership probe against another salesperson's account,
   * purely so the refusal is decided by the governed services and
   * written to the change log: opening a session on the account runs
   * the session service's ownership check, which refuses a non-owner
   * and logs the refusal, and stores nothing either way. No memory is
   * listed or read to make the attempt. The result is deliberately
   * discarded: the caller answers generically.
   */
  private async refuseOtherAccountRead(
    ownerId: string,
    other: StoredAccount,
  ): Promise<void> {
    await this.sessions.open(ownerId, other.id);
  }

  /**
   * Find another salesperson's account a message is asking about.
   * Matches on the account's name words, or plain phrasing like
   * "other account". The caller's own accounts are never matched.
   */
  private async matchOtherAccount(
    ownerId: string,
    lowerText: string,
  ): Promise<StoredAccount | undefined> {
    const accounts = await this.accounts();
    const others = accounts.filter(
      (account) => account.owner_salesperson_id !== ownerId,
    );
    for (const account of others) {
      const tokens = new Set<string>();
      for (const word of account.name.toLowerCase().split(/[^a-z]+/)) {
        if (word.length >= 4 && !NAME_STOPWORDS.has(word)) {
          tokens.add(word);
        }
      }
      for (const token of tokens) {
        if (token !== "" && lowerText.includes(token)) {
          return account;
        }
      }
    }
    if (
      lowerText.includes("other account") ||
      lowerText.includes("another account") ||
      lowerText.includes("other salesperson") ||
      lowerText.includes("not mine")
    ) {
      return others[0];
    }
    return undefined;
  }

  /**
   * Answer a forget request. Only the session's budget note can be
   * forgotten from chat; forgetting goes through the memory service,
   * which removes the content, leaves a tombstone, and logs the forget.
   * A request naming anything else gets a scripted nudge, not a guess.
   */
  private async handleForget(
    ownerId: string,
    session: Session,
    lowerText: string,
  ): Promise<ChatResult> {
    if (!lowerText.includes("budget")) {
      return this.withPending(
        session,
        'The note I can forget from here is the budget note — say ' +
          '"forget the budget" and I\'ll remove it. Forgetting is ' +
          "written to the change log.",
      );
    }
    const budgetItemId = stringField(session.data, "budgetItemId");
    if (budgetItemId === undefined) {
      return this.withPending(
        session,
        "There's no budget note yet — one is written when a budget " +
          "figure comes up in the intake conversation.",
      );
    }
    const result = await this.memory.forget(ownerId, budgetItemId);
    if (!result.ok) {
      return this.withPending(
        session,
        "That budget note is already gone — there's nothing left to forget.",
      );
    }
    return this.withPending(
      session,
      "Done — the budget note is forgotten. Its content is removed, " +
        "not just hidden, and the change log keeps the fact that a " +
        "forget happened.",
    );
  }

  /**
   * Answer a correction request by correcting the session's stakeholder
   * note through the memory service, which keeps the earlier version in
   * the note's history. The correction is parsed out of the message —
   * who should hold which role — and applied to the stakeholder list
   * the intake gathered; the corrected list is saved back into the
   * session's data so the conversation and the note stay in step.
   * Returns null when the session has no stakeholder note yet, so the
   * caller can fall through to the step script.
   */
  private async handleCorrect(
    ownerId: string,
    session: Session,
    account: StoredAccount,
    text: string,
  ): Promise<ChatResult | null> {
    const itemId = stringField(session.data, "stakeholderItemId");
    if (itemId === undefined) {
      return null;
    }
    const applied = applyCorrection(stakeholdersField(session.data), text);
    if (!applied.changed) {
      return this.withPending(
        session,
        "I couldn't pick the correction out of that — tell me who " +
          'holds which role, for example "Priya is the CMO", and ' +
          "I'll correct the note.",
      );
    }
    const corrected = stakeholderNoteText(account, applied.stakeholders);
    const result = await this.memory.correct(ownerId, itemId, "text", corrected);
    if (!result.ok) {
      return this.withPending(
        session,
        "I couldn't correct that note — it may already be forgotten.",
      );
    }
    await this.sessions.advance(session.id, ownerId, session.step, {
      stakeholders: applied.stakeholders.map((person) => ({ ...person })),
    });
    return this.withPending(
      session,
      `Corrected. The stakeholder note now reads: "${corrected}" The ` +
        "earlier draft is kept in the note's own history, and the " +
        "correction is in the change log.",
    );
  }

  /**
   * Write the session's budget note through the memory service, when
   * a budget figure is known and no note exists yet. The note carries
   * the figure exactly as the salesperson gave it, labelled a sample
   * figure. Returns the session-data patch recording the note's id
   * (and the figure), or an empty patch when there is nothing to do.
   */
  private async rememberBudget(
    ownerId: string,
    session: Session,
    account: StoredAccount,
    figure: string | undefined,
  ): Promise<JsonRecord> {
    if (figure === undefined) {
      return {};
    }
    const known = stringField(session.data, "budgetFigure") ?? figure;
    if (stringField(session.data, "budgetItemId") !== undefined) {
      return known === figure ? {} : { budgetFigure: known };
    }
    const budgetItemId = `budget-${session.id}`;
    await this.memory.remember(ownerId, {
      id: budgetItemId,
      kind: "budget",
      text:
        `Budget note for ${account.name}: the budget figure from the ` +
        `intake conversation is ${known} (sample figure).`,
    });
    return { budgetItemId, budgetFigure: known };
  }

  /**
   * Run the conversation's step script for a message that matched no
   * intent: intake parses the stakeholders (and any budget figure)
   * out of the message and writes them as memories, confirmation
   * builds the proposal from the stakeholder note on record, and the
   * proposal step watches for the approval the card performs. Returns
   * null at the final step, where the conversation is free-form.
   */
  private async handleStep(
    ownerId: string,
    session: Session,
    account: StoredAccount,
    text: string,
  ): Promise<ChatResult | null> {
    if (session.step === "intake") {
      const stakeholders = parseStakeholders(text);
      if (stakeholders.length === 0) {
        return this.withPending(
          session,
          `Let's work on ${account.name}. To draft the stakeholder ` +
            "note I need the intake details from you: who the " +
            'stakeholders are and the roles they hold — for example ' +
            '"Dan is the CMO, Priya runs operations" — and the budget ' +
            "figure, if there is one. Nothing is written to memory " +
            "until you tell me.",
        );
      }
      const itemId = `stakeholders-${session.id}`;
      const note = stakeholderNoteText(account, stakeholders);
      await this.memory.remember(ownerId, {
        id: itemId,
        kind: "stakeholders",
        text: note,
      });
      const budgetPatch = await this.rememberBudget(
        ownerId,
        session,
        account,
        parseBudgetFigure(text),
      );
      const advanced = await this.sessions.advance(
        session.id,
        ownerId,
        "stakeholders",
        {
          stakeholderItemId: itemId,
          stakeholders: stakeholders.map((person) => ({ ...person })),
          ...budgetPatch,
        },
      );
      const next = advanced.ok ? advanced.session : session;
      const budgetLine =
        typeof budgetPatch.budgetFigure === "string"
          ? ` I also stored the budget figure you gave — ` +
            `${budgetPatch.budgetFigure} (sample figure) — as its own ` +
            `memory; say "forget the budget" whenever it should go.`
          : "";
      return this.withPending(
        next,
        `Let's work on ${account.name}. From what you told me I ` +
          `drafted this stakeholder note: "${note}" If a role is ` +
          "wrong, tell me the correction — the draft stays in the " +
          'note\'s history. Or say "looks good" and I\'ll put together ' +
          `the campaign proposal. All prices today are sample prices.${budgetLine}`,
      );
    }
    if (session.step === "stakeholders") {
      const budgetPatch = await this.rememberBudget(
        ownerId,
        session,
        account,
        parseBudgetFigure(text) ?? stringField(session.data, "budgetFigure"),
      );
      const priced = await this.priceLines();
      const noteText = await this.stakeholderNoteOnRecord(ownerId, session, account);
      const description =
        `Campaign proposal for ${account.name}: ${priced}.` +
        (noteText === undefined
          ? ""
          : ` Stakeholder note on record: ${noteText}`);
      const proposal = await this.memory.propose(ownerId, {
        description,
        accountId: account.id,
      });
      if (!proposal.ok) {
        return this.withPending(
          session,
          "I couldn't put that proposal together — the account check " +
            "refused it. Nothing was proposed or sent onward.",
        );
      }
      const advanced = await this.sessions.advance(
        session.id,
        ownerId,
        "proposal",
        { ...budgetPatch, approvalId: proposal.approval.id },
      );
      const next = advanced.ok ? advanced.session : session;
      return this.withPending(
        next,
        `Here's the proposal: ${description} It's a change to governed ` +
          "memory, so it waits for your approval — approve it in the " +
          "card on the right and it will be written to the outbox (the " +
          "stand-in for a CRM) and recorded in the change log.",
      );
    }
    if (session.step === "proposal") {
      const approvalId = stringField(session.data, "approvalId");
      const approval =
        approvalId === undefined
          ? undefined
          : await this.memory.getApproval(approvalId);
      if (approval !== undefined && approval.status === "approved") {
        const advanced = await this.sessions.advance(
          session.id,
          ownerId,
          "approved",
        );
        const next = advanced.ok ? advanced.session : session;
        return this.withPending(
          next,
          "Approved and handed onward — the outbox now holds this " +
            "change, and the change log has the approve entry. You can " +
            "close this session and resume it later; we land right " +
            "back here, with the same data.",
        );
      }
      return this.withPending(
        session,
        "That proposal is still waiting for your approval — use the " +
          "Approve button in the card on the right. Nothing is sent " +
          "onward until you approve it.",
      );
    }
    return null;
  }

  /**
   * Read the session's stakeholder note back through the memory
   * service, so the proposal is built from the governed memory on
   * record — corrections included — rather than from anything the
   * account record holds. Falls back to rendering the stakeholder
   * list kept in the session's data when the note cannot be recalled.
   */
  private async stakeholderNoteOnRecord(
    ownerId: string,
    session: Session,
    account: StoredAccount,
  ): Promise<string | undefined> {
    const itemId = stringField(session.data, "stakeholderItemId");
    if (itemId !== undefined) {
      const recalled = await this.memory.recall(ownerId, itemId);
      if (recalled.ok) {
        return recalled.item.text;
      }
    }
    const stakeholders = stakeholdersField(session.data);
    return stakeholders.length === 0
      ? undefined
      : stakeholderNoteText(account, stakeholders);
  }

  /**
   * Render the proposal's price lines from the products in the store,
   * joined into one sentence. Each product's own `rate_label` is the
   * price wording and its `sample_label` the sample marking, so prices
   * stay labelled as samples. Products whose labels cannot be read
   * are skipped; when no product renders, the demo's sample price
   * lines answer instead, so the proposal always carries labelled
   * sample prices.
   */
  private async priceLines(): Promise<string> {
    const products = await this.store.list(PRODUCTS);
    const lines: string[] = [];
    for (const product of products) {
      if (
        typeof product.name !== "string" ||
        typeof product.rate_label !== "string"
      ) {
        continue;
      }
      const label =
        typeof product.sample_label === "string"
          ? product.sample_label
          : "sample price";
      lines.push(`${product.name} at ${product.rate_label} — ${label}`);
    }
    return (lines.length > 0 ? lines : [...SAMPLE_PRICE_LINES]).join("; ");
  }

  /**
   * Answer a free-form message once the demo path is complete.
   * When a model is configured it may write this reply; any failure —
   * or no model at all — falls back to the scripted line, so the
   * conversation never depends on the model working.
   */
  private async freeForm(
    ownerId: string,
    session: Session,
    account: StoredAccount,
    text: string,
  ): Promise<ChatResult> {
    if (this.model !== undefined) {
      try {
        const reply = await this.model.complete(
          `You are the assistant in a governed sales-memory demo. The ` +
            `salesperson is working on the account "${account.name}" ` +
            `and the campaign proposal for it is approved and in the ` +
            `outbox. Answer briefly and helpfully. Prices are sample ` +
            `prices. The salesperson says: ${text}`,
        );
        return this.withPending(session, reply);
      } catch {
        // Fall through to the scripted reply: a model failure must
        // never break the conversation.
      }
    }
    return this.withPending(
      session,
      "This proposal is approved and in the outbox. From here you can " +
        "ask me to correct the stakeholder note, forget the budget " +
        "note, or close the session and resume it to pick up exactly " +
        "where we left off.",
    );
  }

  /**
   * Build a successful chat result for a session, attaching the
   * session's pending approval when one is still waiting, so the page
   * can render the approval card from any reply.
   */
  private async withPending(
    session: Session,
    reply: string,
  ): Promise<ChatResult> {
    const result: ChatResult = { ok: true, reply, step: session.step };
    const approvalId = stringField(session.data, "approvalId");
    if (approvalId !== undefined) {
      const approval = await this.memory.getApproval(approvalId);
      if (approval !== undefined && approval.status === "pending") {
        result.pendingApproval = approval;
      }
    }
    return result;
  }
}
