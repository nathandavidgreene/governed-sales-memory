/**
 * The session service: one salesperson's working session with the agent.
 *
 * A session belongs to one owner and nothing else: it is not tied to an
 * account and has no fixed steps. It holds the conversation history
 * the agent replays on every turn, plus free-form data such as the ids
 * of proposals raised in it, so closing it and resuming it later picks
 * the conversation up exactly where it stopped. Only the owner can
 * read, update, close, or resume a session. Every refusal is the one
 * generic refusal the memory service gives — the same for a session
 * owned by someone else and for one that does not exist at all — and a
 * cross-owner attempt is written to the change log as a "refuse" entry.
 */

import type { ChangeLog } from "./change-log";
import type { ChatMessage } from "./model";
import type { JsonRecord, Store } from "./store";

/** One working session, owned by one salesperson. */
export interface Session {
  id: string;
  owner_salesperson_id: string;
  /** The conversation so far, in chat-completions message form. */
  history: ChatMessage[];
  /** Free-form data gathered so far, as plain JSON; survives close and resume. */
  data: JsonRecord;
  status: "open" | "closed";
  /** ISO 8601 timestamp of the last change to this session. */
  updatedAt: string;
}

/**
 * The result of a session action: the session, the generic refusal
 * ("not found" — covering both a missing session and one owned by
 * someone else, or an unknown salesperson on open), or a state refusal
 * for the owner's own session.
 */
export type SessionResult =
  | { ok: true; session: Session }
  | { ok: false; error: "not found" | "not open" | "not closed" };

/** The collection sessions live in. */
const SESSIONS = "sessions";

/** The collection accounts live in; open checks the salesperson row here. */
const ACCOUNTS = "accounts";

/**
 * Governed sessions over a `Store`, with every action written to the
 * change log. Storage goes only through the `Store` interface, so the
 * backing store can be swapped without changing this service.
 */
export class SessionService {
  /** Wrap the given store and change log; the service holds no state. */
  constructor(
    private readonly store: Store,
    private readonly log: ChangeLog,
  ) {}

  /**
   * Open a new, empty session for `ownerSalespersonId` and append a
   * "session-open" change log entry. Generates the session id. The
   * session names no account and starts with no history.
   *
   * The owner must be a known salesperson: the accounts collection
   * holds a `kind: "salesperson"` row keyed by their id. Anyone else
   * gets the generic refusal and no session is stored, so an unknown
   * caller cannot create sessions.
   */
  async open(ownerSalespersonId: string): Promise<SessionResult> {
    const person = await this.store.get(ACCOUNTS, ownerSalespersonId);
    if (
      person === undefined ||
      person.kind !== "salesperson" ||
      person.owner_salesperson_id !== ownerSalespersonId
    ) {
      return { ok: false, error: "not found" };
    }
    const session: Session = {
      id: globalThis.crypto.randomUUID(),
      owner_salesperson_id: ownerSalespersonId,
      history: [],
      data: {},
      status: "open",
      updatedAt: new Date().toISOString(),
    };
    await this.store.put(SESSIONS, session.id, {
      _id: session.id,
      ...session,
    });
    await this.log.append(
      ownerSalespersonId,
      "session-open",
      session.id,
      "Session opened.",
    );
    return { ok: true, session };
  }

  /**
   * Read one session back — for its owner only.
   * Uses the same ownership check as every other action: a missing
   * session fails closed as "not found", and another owner's session
   * appends a "refuse" record entry and returns "not yours", revealing
   * nothing about the session. Reading never changes the session.
   */
  async get(sessionId: string, ownerId: string): Promise<SessionResult> {
    return this.loadOwned(sessionId, ownerId, "Read");
  }

  /**
   * Save a session's conversation history, merging any given data
   * into the data already gathered. Owner only, and only while the
   * session is open: anyone else gets the generic refusal with a
   * "refuse" log entry, and a closed session fails closed as "not
   * open" with nothing changed. Saving history is bookkeeping, not a
   * governed memory change, so it writes no change log entry of its
   * own; every tool action in the turn logs itself.
   */
  async saveHistory(
    sessionId: string,
    ownerSalespersonId: string,
    history: ChatMessage[],
    data?: JsonRecord,
  ): Promise<SessionResult> {
    const loaded = await this.loadOwned(sessionId, ownerSalespersonId, "Update");
    if (!loaded.ok) {
      return loaded;
    }
    const session = loaded.session;
    if (session.status !== "open") {
      return { ok: false, error: "not open" };
    }
    const next: Session = {
      ...session,
      history,
      data: data === undefined ? session.data : { ...session.data, ...data },
      updatedAt: new Date().toISOString(),
    };
    await this.store.put(SESSIONS, sessionId, { _id: sessionId, ...next });
    return { ok: true, session: next };
  }

  /**
   * Close a session, keeping its history and data exactly as they are,
   * and append a "session-close" change log entry. Owner only, and
   * only while the session is open; anyone else gets the generic
   * refusal with a "refuse" log entry and the session is left
   * untouched.
   */
  async close(
    sessionId: string,
    ownerSalespersonId: string,
  ): Promise<SessionResult> {
    const loaded = await this.loadOwned(sessionId, ownerSalespersonId, "Close");
    if (!loaded.ok) {
      return loaded;
    }
    const session = loaded.session;
    if (session.status !== "open") {
      return { ok: false, error: "not open" };
    }
    const next: Session = {
      ...session,
      status: "closed",
      updatedAt: new Date().toISOString(),
    };
    await this.store.put(SESSIONS, sessionId, { _id: sessionId, ...next });
    await this.log.append(
      ownerSalespersonId,
      "session-close",
      sessionId,
      "Session closed.",
    );
    return { ok: true, session: next };
  }

  /**
   * Resume a closed session with its saved history and data intact,
   * status back to "open", and append a "session-resume" change
   * log entry. Owner only, and only from closed: a session that was
   * never closed fails closed as "not closed", and another owner's
   * session gets the generic refusal with a "refuse" log entry — it
   * stays closed and nothing about it is revealed.
   */
  async resume(
    sessionId: string,
    ownerSalespersonId: string,
  ): Promise<SessionResult> {
    const loaded = await this.loadOwned(sessionId, ownerSalespersonId, "Resume");
    if (!loaded.ok) {
      return loaded;
    }
    const session = loaded.session;
    if (session.status !== "closed") {
      return { ok: false, error: "not closed" };
    }
    const next: Session = {
      ...session,
      status: "open",
      updatedAt: new Date().toISOString(),
    };
    await this.store.put(SESSIONS, sessionId, { _id: sessionId, ...next });
    await this.log.append(
      ownerSalespersonId,
      "session-resume",
      sessionId,
      "Session resumed.",
    );
    return { ok: true, session: next };
  }

  /**
   * Load a session and check that `ownerSalespersonId` owns it.
   * A missing session fails closed with the generic refusal. A session
   * owned by someone else appends a "refuse" change log entry — `verb`
   * names the attempted action in the entry's detail — and returns the
   * same generic refusal, revealing nothing about the session.
   */
  private async loadOwned(
    sessionId: string,
    ownerSalespersonId: string,
    verb: string,
  ): Promise<SessionResult> {
    const raw = await this.store.get(SESSIONS, sessionId);
    if (raw === undefined) {
      return { ok: false, error: "not found" };
    }
    const { _id: _key, ...rest } = raw;
    const session = rest as unknown as Session;
    if (!Array.isArray(session.history)) {
      session.history = [];
    }
    if (session.owner_salesperson_id !== ownerSalespersonId) {
      await this.log.append(
        ownerSalespersonId,
        "refuse",
        sessionId,
        `${verb} refused: not the owner.`,
      );
      return { ok: false, error: "not found" };
    }
    return { ok: true, session };
  }
}
