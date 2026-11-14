/**
 * The session service: one salesperson's working session on one account.
 *
 * A session remembers where the work got to — its current step and the
 * data gathered so far — so closing it and resuming it later lands on
 * exactly the same step with the same data, instead of starting over.
 * Sessions are owner-scoped like memory items: only the owner can move,
 * close, or resume one. Anyone else gets the same generic refusal the
 * memory service gives, and the attempt is written to the record log.
 * Steps are plain strings chosen by the caller; this service stores
 * whatever step it is given and never assumes a fixed script.
 */

import type { RecordLog } from "./record";
import type { JsonRecord, Store } from "./store";

/** One working session on one account, owned by one salesperson. */
export interface Session {
  id: string;
  ownerId: string;
  accountId: string;
  /** Where the work currently stands; a plain word set by the caller. */
  step: string;
  /** Data gathered so far, as plain JSON; survives close and resume. */
  data: JsonRecord;
  status: "open" | "closed";
  /** ISO 8601 timestamp of the last change to this session. */
  updatedAt: string;
}

/** The result of a session action: the session, or a fail-closed error. */
export type SessionResult =
  | { ok: true; session: Session }
  | { ok: false; error: "not yours" | "not found" | "not open" | "not closed" };

/** The collection sessions live in. */
const SESSIONS = "sessions";

/**
 * Governed sessions over a `Store`, with every action written to the
 * record log. Storage goes only through the `Store` interface, so the
 * backing store can be swapped without changing this service.
 */
export class SessionService {
  /** Wrap the given store and record log; the service holds no state. */
  constructor(
    private readonly store: Store,
    private readonly log: RecordLog,
  ) {}

  /**
   * Open a new session for `ownerId` on `accountId`, at step "intake"
   * with no data yet, and append a "session-open" record entry.
   * Generates the session id.
   */
  async open(ownerId: string, accountId: string): Promise<Session> {
    const session: Session = {
      id: globalThis.crypto.randomUUID(),
      ownerId,
      accountId,
      step: "intake",
      data: {},
      status: "open",
      updatedAt: new Date().toISOString(),
    };
    await this.store.put(SESSIONS, session.id, { ...session });
    await this.log.append(
      ownerId,
      "session-open",
      session.id,
      "Session opened.",
    );
    return session;
  }

  /**
   * Move a session to a new step, merging any given data into the data
   * already gathered, and append a "session-step" record entry.
   * Owner only, and only while the session is open: anyone else is
   * refused generically with a "refuse" log entry, and a closed session
   * fails closed as "not open" with nothing changed.
   */
  async advance(
    sessionId: string,
    ownerId: string,
    step: string,
    data?: JsonRecord,
  ): Promise<SessionResult> {
    const loaded = await this.loadOwned(sessionId, ownerId, "Advance");
    if (!loaded.ok) {
      return loaded;
    }
    const session = loaded.session;
    if (session.status !== "open") {
      return { ok: false, error: "not open" };
    }
    const next: Session = {
      ...session,
      step,
      data: data === undefined ? session.data : { ...session.data, ...data },
      updatedAt: new Date().toISOString(),
    };
    await this.store.put(SESSIONS, sessionId, { ...next });
    await this.log.append(ownerId, "session-step", sessionId, "Session advanced.");
    return { ok: true, session: next };
  }

  /**
   * Close a session, keeping its step and data exactly as they are, and
   * append a "session-close" record entry. Owner only, and only while
   * the session is open; anyone else is refused generically with a
   * "refuse" log entry and the session is left untouched.
   */
  async close(sessionId: string, ownerId: string): Promise<SessionResult> {
    const loaded = await this.loadOwned(sessionId, ownerId, "Close");
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
    await this.store.put(SESSIONS, sessionId, { ...next });
    await this.log.append(ownerId, "session-close", sessionId, "Session closed.");
    return { ok: true, session: next };
  }

  /**
   * Resume a closed session at its exact saved step, with its saved
   * data, status back to "open", and append a "session-resume" record
   * entry. Owner only, and only from closed: a session that was never
   * closed fails closed as "not closed", and another owner's session is
   * refused generically with a "refuse" log entry — it stays closed and
   * nothing about it is revealed.
   */
  async resume(sessionId: string, ownerId: string): Promise<SessionResult> {
    const loaded = await this.loadOwned(sessionId, ownerId, "Resume");
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
    await this.store.put(SESSIONS, sessionId, { ...next });
    await this.log.append(
      ownerId,
      "session-resume",
      sessionId,
      "Session resumed.",
    );
    return { ok: true, session: next };
  }

  /**
   * Load a session and check that `ownerId` owns it.
   * A missing session fails closed as "not found". A session owned by
   * someone else appends a "refuse" record entry — `verb` names the
   * attempted action in the entry's detail — and returns "not yours",
   * revealing nothing about the session.
   */
  private async loadOwned(
    sessionId: string,
    ownerId: string,
    verb: string,
  ): Promise<SessionResult> {
    const raw = await this.store.get(SESSIONS, sessionId);
    if (raw === undefined) {
      return { ok: false, error: "not found" };
    }
    const session = raw as unknown as Session;
    if (session.ownerId !== ownerId) {
      await this.log.append(
        ownerId,
        "refuse",
        sessionId,
        `${verb} refused: not the owner.`,
      );
      return { ok: false, error: "not yours" };
    }
    return { ok: true, session };
  }
}
