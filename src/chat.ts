/**
 * The scripted chat: the agent's voice for the demo, with no model in
 * the loop.
 *
 * Replies are chosen by plain keyword and intent matching, so the demo
 * behaves the same way on every run and never depends on a live model
 * call. A later layer can put a model behind this same surface; the
 * governance underneath would not change. The script walks one working
 * session through the demo path — intake, stakeholder confirmation, a
 * campaign proposal that waits for approval — and answers three
 * governance intents at any step: correct a remembered note (the old
 * value stays in the note's history), forget the budget note (its
 * content is removed, not hidden), and ask for another salesperson's
 * account (refused generically through the memory read rule, so the
 * refusal itself lands in the record log). Unknown input gets a
 * scripted reply that nudges back toward the demo path.
 */

import type { Approval, MemoryService } from "./memory";
import { seedState, type Account } from "./seed";
import type { Session, SessionService } from "./session";
import type { JsonRecord, Store } from "./store";

/** The result of handling one chat message. */
export type ChatResult =
  | {
      ok: true;
      /** The scripted reply to show the salesperson. */
      reply: string;
      /** The session's step after this message. */
      step: string;
      /** The proposal waiting for approval, when there is one. */
      pendingApproval?: Approval;
    }
  | { ok: false; error: "not yours" | "not found" | "not open" };

/** The result of opening a session through the chat service. */
export type OpenSessionResult =
  | { ok: true; session: Session }
  | { ok: false; error: "no account" };

/** The collection memory items live in; matches the memory service. */
const ITEMS = "memory_items";

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
 * The deterministic id of an account's profile memory item.
 * One naming rule, shared by the writer (session open) and the reader
 * (the cross-account refusal), so both sides always mean the same item.
 */
function profileItemId(account: Account): string {
  return `account-profile-${account.id}`;
}

/**
 * Render an account's stakeholder list as one sentence.
 * `roles` is parallel to the account's stakeholders, so the caller can
 * render the account's true roles or a draft with roles swapped.
 */
function stakeholderText(account: Account, roles: string[]): string {
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
function draftStakeholderText(account: Account): string {
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
function trueStakeholderText(account: Account): string {
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
 * The scripted chat service over the governed services.
 *
 * Holds no state of its own: sessions, memory items, approvals, and the
 * record log all live in the store behind the services it wraps, so a
 * fresh instance per request behaves exactly like a shared one.
 */
export class ChatService {
  /** Wrap the memory service, the session service, and their store. */
  constructor(
    private readonly memory: MemoryService,
    private readonly sessions: SessionService,
    private readonly store: Store,
  ) {}

  /**
   * Open a working session for one salesperson on their sample account.
   * Fails closed with "no account" when the id names no seeded
   * salesperson's account. Opening any session first makes sure every
   * seeded account has a profile memory item owned by its salesperson,
   * so a later cross-account ask can be refused through the read rule
   * (and logged) instead of merely missing.
   */
  async openSession(ownerId: string): Promise<OpenSessionResult> {
    const state = seedState();
    const account = state.accounts.find((entry) => entry.ownerId === ownerId);
    if (account === undefined) {
      return { ok: false, error: "no account" };
    }
    await this.ensureAccountProfiles();
    const session = await this.sessions.open(ownerId, account.id);
    return { ok: true, session };
  }

  /**
   * Handle one message from `ownerId` in one of their sessions.
   * The session is loaded through the session service, so another
   * owner's session is refused generically ("not yours") and a closed
   * session fails closed ("not open") before any intent is considered.
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
      // `get` fails only as "not yours" or "not found"; anything else
      // would be a programming error, so fail closed as "not found".
      return {
        ok: false,
        error: loaded.error === "not yours" ? "not yours" : "not found",
      };
    }
    const session = loaded.session;
    if (session.status !== "open") {
      return { ok: false, error: "not open" };
    }
    const account = seedState().accounts.find(
      (entry) => entry.id === session.accountId,
    );
    if (account === undefined) {
      return { ok: false, error: "not found" };
    }
    const lower = text.toLowerCase();

    const other = this.matchOtherAccount(ownerId, lower);
    if (other !== undefined) {
      // The read rule decides: a cross-owner recall is refused by the
      // memory service and the refusal is written to the record log.
      // The reply is the same whatever the recall found, and carries
      // none of the other account's data.
      await this.memory.recall(ownerId, profileItemId(other));
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
    return this.handleStep(ownerId, session, account);
  }

  /**
   * Make sure every seeded account has a profile memory item, owned by
   * that account's salesperson and holding the account's stakeholder
   * list — the data the read rule exists to protect. Items that already
   * exist are left untouched, so this adds no duplicate log entries.
   */
  private async ensureAccountProfiles(): Promise<void> {
    for (const account of seedState().accounts) {
      const id = profileItemId(account);
      if ((await this.store.get(ITEMS, id)) === undefined) {
        await this.memory.remember(account.ownerId, {
          id,
          kind: "account-profile",
          text:
            `Account profile for ${account.name}. ` +
            trueStakeholderText(account),
        });
      }
    }
  }

  /**
   * Find another salesperson's account a message is asking about.
   * Matches on the account's name words, its stakeholders' names, the
   * owning salesperson's name or id, or plain phrasing like "other
   * account". The caller's own accounts are never matched.
   */
  private matchOtherAccount(
    ownerId: string,
    lowerText: string,
  ): Account | undefined {
    const state = seedState();
    const others = state.accounts.filter(
      (account) => account.ownerId !== ownerId,
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
      const owner = state.salespeople.find(
        (person) => person.id === account.ownerId,
      );
      if (owner !== undefined) {
        tokens.add(owner.id);
        tokens.add(owner.displayName.toLowerCase().split(" ")[0]);
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
    account: Account,
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
   * already had their chance to intercept it.
   */
  private async handleStep(
    ownerId: string,
    session: Session,
    account: Account,
  ): Promise<ChatResult> {
    const state = seedState();
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
      const person = state.salespeople.find((entry) => entry.id === ownerId);
      const greeting =
        person === undefined ? "Hi." : `Hi ${person.displayName.split(" ")[0]}.`;
      return this.withPending(
        next,
        `${greeting} Let's work on ${account.name}. From the intake ` +
          `notes I drafted this stakeholder note: "${draft}" If a role ` +
          "is wrong, tell me the correction — the draft stays in the " +
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
          "discussed is $4,000 (sample figure).",
      });
      const priced = state.pricing
        .map((price) => {
          const product = state.products.find(
            (entry) => entry.id === price.productId,
          );
          const name = product === undefined ? price.productId : product.name;
          return (
            `${name} at $${price.amountUsd} ${price.model} ` +
            `(${price.unit}) — sample price`
          );
        })
        .join("; ");
      const names = account.stakeholders
        .map((person) => `${person.name} (${person.role})`)
        .join(", ");
      const description =
        `Campaign proposal for ${account.name}: ${priced}. ` +
        `Prepared for stakeholders: ${names}.`;
      const approval = await this.memory.propose(ownerId, {
        description,
        accountId: account.id,
      });
      const advanced = await this.sessions.advance(
        session.id,
        ownerId,
        "proposal",
        { budgetItemId, approvalId: approval.id },
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
