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
 * hard-coded sample, and no memory is invented for an account — the
 * only items the chat writes are the session's own stakeholder and
 * budget notes. The script walks one working session through the demo
 * path — intake, a stakeholder note drafted with the first two roles
 * swapped, the correction that fixes it through the memory service
 * (the draft stays in the note's history), a campaign proposal at
 * sample prices that waits for approval, and the approval landing in
 * the outbox — and answers three governance intents at any step:
 * correct the note, forget the budget note (its content is removed,
 * not hidden), and ask for another salesperson's account (refused
 * generically through a governed read, so the refusal itself lands in
 * the change log).
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

/** The collection memory items live in; matches the memory service. */
const MEMORIES = "memories";

/** The collection products live in; the proposal prices from these. */
const PRODUCTS = "products";

/** The collection prices live in; shared, and always samples. */
const PRICING = "pricing";

/** One stakeholder on an account, as stored: a name and their role. */
interface StoredStakeholder {
  name: string;
  role: string;
}

/**
 * An account as the chat needs it, read from the store.
 * The store's document is the source; this is only the shape the chat
 * relies on, parsed tolerantly — a document without a stakeholder list
 * simply has none, instead of the chat guessing at one.
 */
interface StoredAccount {
  id: string;
  name: string;
  owner_salesperson_id: string;
  stakeholders: StoredStakeholder[];
}

/**
 * Read a stored document as an account, or return `undefined` when it
 * does not carry the fields an account must have (an id — its own or
 * its `_id` key — a name, and an owner).
 */
function asAccount(raw: JsonRecord): StoredAccount | undefined {
  const id = raw.id ?? raw._id;
  if (
    typeof id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.owner_salesperson_id !== "string"
  ) {
    return undefined;
  }
  const stakeholders: StoredStakeholder[] = [];
  if (Array.isArray(raw.stakeholders)) {
    for (const person of raw.stakeholders) {
      if (
        typeof person === "object" &&
        person !== null &&
        typeof (person as JsonRecord).name === "string" &&
        typeof (person as JsonRecord).role === "string"
      ) {
        stakeholders.push({
          name: (person as JsonRecord).name as string,
          role: (person as JsonRecord).role as string,
        });
      }
    }
  }
  return {
    id,
    name: raw.name,
    owner_salesperson_id: raw.owner_salesperson_id,
    stakeholders,
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
 * Render an account's stakeholder list as one sentence.
 * `roles` is parallel to the account's stakeholders, so the caller can
 * render the account's true roles or a draft with roles swapped.
 */
function stakeholderText(account: StoredAccount, roles: string[]): string {
  const parts = account.stakeholders.map(
    (person, index) => `${person.name} — ${roles[index]}`,
  );
  return `Stakeholders for ${account.name}: ${parts.join("; ")}.`;
}

/**
 * The draft stakeholder note written at intake.
 * The first two roles are deliberately swapped, the way a note drafted
 * from messy intake notes can be wrong — the demo's correction beat
 * fixes it through the memory service, which keeps this draft in the
 * note's history. Accounts with one stakeholder are drafted as-is.
 */
function draftStakeholderText(account: StoredAccount): string {
  const roles = account.stakeholders.map((person) => person.role);
  if (roles.length >= 2) {
    [roles[0], roles[1]] = [roles[1], roles[0]];
  }
  return stakeholderText(account, roles);
}

/**
 * The account's true stakeholder note, rendered from the account record.
 * This is what a correction writes, so a corrected note always matches
 * the account of record.
 */
function trueStakeholderText(account: StoredAccount): string {
  return stakeholderText(
    account,
    account.stakeholders.map((person) => person.role),
  );
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
 * no pricing rows: the demo's sample prices, labelled as samples.
 * Used only to render the proposal text; nothing is stored from here.
 */
const SAMPLE_PRICE_LINES: readonly string[] = [
  "Managed Native Advertising at $5 CPC (per click) — sample price",
  "Managed Display Advertising at $25 vCPM (per 1,000 viewable impressions) — sample price",
];

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
   * several, the first by id is used, so the choice is deterministic.
   * Fails closed with "no account" when the id owns no account in the
   * store. The session service makes the final ownership check.
   */
  async openSession(ownerId: string): Promise<OpenSessionResult> {
    const accounts = await this.accounts();
    const owned = accounts
      .filter((account) => account.owner_salesperson_id === ownerId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const account = owned[0];
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
      // A governed read decides: the attempt is refused by the read
      // rule or the ownership check and written to the change log.
      // The reply is the same whatever the read found, and carries
      // none of the other account's data.
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
      const corrected = await this.handleCorrect(ownerId, session, account);
      if (corrected !== null) {
        return corrected;
      }
    }
    const stepped = await this.handleStep(ownerId, session, account);
    if (stepped !== null) {
      return stepped;
    }
    return this.freeForm(ownerId, session, account, text);
  }

  /** Read every account in the store, in the shape the chat relies on. */
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
   * Make one governed read attempt against another salesperson's
   * account, purely so the refusal is decided by the governed services
   * and written to the change log. Prefers recalling one of the other
   * owner's memory items through the read rule; when the store holds
   * none, the session service's ownership check on the account itself
   * is the probe — it refuses and logs, and stores nothing either way.
   * The result is deliberately discarded: the caller answers generically.
   */
  private async refuseOtherAccountRead(
    ownerId: string,
    other: StoredAccount,
  ): Promise<void> {
    const memories = await this.store.list(MEMORIES);
    const theirs = memories.filter(
      (record) => record.owner_salesperson_id === other.owner_salesperson_id,
    );
    const item =
      theirs.find((record) => record.accountId === other.id) ?? theirs[0];
    const itemId = item === undefined ? undefined : (item.id ?? item._id);
    if (typeof itemId === "string") {
      await this.memory.recall(ownerId, itemId);
      return;
    }
    await this.sessions.open(ownerId, other.id);
  }

  /**
   * Find another salesperson's account a message is asking about.
   * Matches on the account's name words or its stakeholders' names, or
   * plain phrasing like "other account". The caller's own accounts are
   * never matched.
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
        if (word.length >= 4) {
          tokens.add(word);
        }
      }
      for (const person of account.stakeholders) {
        tokens.add(person.name.toLowerCase());
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
        "There's no budget note yet — one is written when the campaign " +
          "proposal is put together.",
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
   * note through the memory service, which keeps the draft in the
   * note's history. Returns null when the session has no stakeholder
   * note yet, so the caller can fall through to the step script.
   */
  private async handleCorrect(
    ownerId: string,
    session: Session,
    account: StoredAccount,
  ): Promise<ChatResult | null> {
    const itemId = stringField(session.data, "stakeholderItemId");
    if (itemId === undefined) {
      return null;
    }
    const corrected = trueStakeholderText(account);
    const result = await this.memory.correct(ownerId, itemId, "text", corrected);
    if (!result.ok) {
      return this.withPending(
        session,
        "I couldn't correct that note — it may already be forgotten.",
      );
    }
    return this.withPending(
      session,
      `Corrected. The stakeholder note now reads: "${corrected}" The ` +
        "earlier draft is kept in the note's own history, and the " +
        "correction is in the change log.",
    );
  }

  /**
   * Run the conversation's step script for a message that matched no
   * intent: intake writes the draft stakeholder note, confirmation
   * builds the proposal and its budget note, and the proposal step
   * watches for the approval the card performs. Any input advances the
   * script at the intake and confirmation steps — the intents have
   * already had their chance to intercept it. Returns null at the
   * final step, where the conversation is free-form.
   */
  private async handleStep(
    ownerId: string,
    session: Session,
    account: StoredAccount,
  ): Promise<ChatResult | null> {
    if (session.step === "intake") {
      const itemId = `stakeholders-${session.id}`;
      const draft = draftStakeholderText(account);
      await this.memory.remember(ownerId, {
        id: itemId,
        kind: "stakeholders",
        text: draft,
      });
      const advanced = await this.sessions.advance(
        session.id,
        ownerId,
        "stakeholders",
        { stakeholderItemId: itemId },
      );
      const next = advanced.ok ? advanced.session : session;
      return this.withPending(
        next,
        `Let's work on ${account.name}. From the intake notes I ` +
          `drafted this stakeholder note: "${draft}" If a role is ` +
          "wrong, tell me the correction — the draft stays in the " +
          'note\'s history. Or say "looks good" and I\'ll put together ' +
          "the campaign proposal. All prices today are sample prices.",
      );
    }
    if (session.step === "stakeholders") {
      const budgetItemId = `budget-${session.id}`;
      await this.memory.remember(ownerId, {
        id: budgetItemId,
        kind: "budget",
        text:
          `Budget note for ${account.name}: the monthly budget figure ` +
          "discussed is $40,000 (sample figure).",
      });
      const priced = await this.priceLines();
      const names = account.stakeholders
        .map((person) => `${person.name} (${person.role})`)
        .join(", ");
      const description =
        `Campaign proposal for ${account.name}: ${priced}. ` +
        `Prepared for stakeholders: ${names}.`;
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
        { budgetItemId, approvalId: proposal.approval.id },
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
   * Render the proposal's price lines from the store's pricing rows,
   * joined into one sentence. Rows whose product or amount cannot be
   * read are skipped; when no row renders, the demo's sample price
   * lines answer instead, so the proposal always carries labelled
   * sample prices.
   */
  private async priceLines(): Promise<string> {
    const pricing = await this.store.list(PRICING);
    const products = await this.store.list(PRODUCTS);
    const lines: string[] = [];
    for (const price of pricing) {
      const amount = price.amountUsd ?? price.amount;
      if (
        typeof price.productId !== "string" ||
        typeof price.model !== "string" ||
        typeof price.unit !== "string" ||
        typeof amount !== "number"
      ) {
        continue;
      }
      const product = products.find(
        (entry) => (entry.id ?? entry._id) === price.productId,
      );
      const name =
        product !== undefined && typeof product.name === "string"
          ? product.name
          : price.productId;
      lines.push(
        `${name} at $${amount} ${price.model} (${price.unit}) — sample price`,
      );
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
