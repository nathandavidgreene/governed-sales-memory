/**
 * The session service: one salesperson's working session on one account.
 *
 * A session remembers where the work got to — its current step and the
 * data gathered so far — so closing it and resuming it later lands on
 * exactly the same step with the same data, instead of starting over.
 * Sessions are owner-scoped like memory items: opening one checks that
 * the account belongs to the salesperson opening it, and only the
 * owner can move, close, or resume one. Every refusal is the one
 * generic refusal the memory service gives — the same for a session or
 * account that belongs to someone else and for one that does not exist
 * at all — and a cross-owner attempt is written to the change log as a
 * "refuse" entry. Steps are plain strings chosen by the caller; this
 * service stores whatever step it is given and never assumes a fixed
 * script.
 */

import type { ChangeLog } from "./change-log";
import type { JsonRecord, Store } from "./store";

/** One working session on one account, owned by one salesperson. */
export interface Session {
  id: string;
  owner_salesperson_id: string;
  accountId: string;
  /** Where the work currently stands; a plain word set by the caller. */
  step: string;
  /** Data gathered so far, as plain JSON; survives close and resume. */
  data: JsonRecord;
  status: "open" | "closed";
  /** ISO 8601 timestamp of the last change to this session. */
  updatedAt: string;
}

/**
 * The result of a session action: the session, the generic refusal
 * ("not found" — covering both a missing session and one owned by
 * someone else), or a state refusal for the owner's own session.
 */
export type SessionResult =
  | { ok: true; session: Session }
  | { ok: false; error: "not found" | "not open" | "not closed" };

/** The collection sessions live in. */
const SESSIONS = "sessions";

/** The collection accounts live in; open checks ownership here. */
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
   * Open a new session for `ownerSalespersonId` on `accountId`, at
   * step "intake" with no data yet, and append a "session-open" change
   * log entry. Generates the session id.
   *
   * The account must exist and belong to the salesperson opening the
   * session — nobody opens a session on someone else's account. A
   * missing account gets the generic refusal; someone else's account
   * gets the generic refusal and a "refuse" change log entry, and no
   * session is stored either way.
   */
  async open(
    ownerSalespersonId: string,
    accountId: string,
  ): Promise<SessionResult> {
    const account = await this.store.get(ACCOUNTS, accountId);
    if (account === undefined) {
      return { ok: false, error: "not found" };
    }
    if (account.owner_salesperson_id !== ownerSalespersonId) {
      await this.log.append(
        ownerSalespersonId,
        "refuse",
        accountId,
        "Session open refused: not the owner.",
      );
      return { ok: false, error: "not found" };
    }
    const session: Session = {
      id: globalThis.crypto.randomUUID(),
      owner_salesperson_id: ownerSalespersonId,
      accountId,
      step: "intake",
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
   * Move a session to a new step, merging any given data into the data
   * already gathered, and append a "session-step" change log entry.
   * Owner only, and only while the session is open: anyone else gets
   * the generic refusal with a "refuse" log entry, and a closed
   * session fails closed as "not open" with nothing changed.
   */
  async advance(
    sessionId: string,
    ownerSalespersonId: string,
    step: string,
    data?: JsonRecord,
  ): Promise<SessionResult> {
    const loaded = await this.loadOwned(sessionId, ownerSalespersonId, "Advance");
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
    await this.store.put(SESSIONS, sessionId, { _id: sessionId, ...next });
    await this.log.append(
      ownerSalespersonId,
      "session-step",
      sessionId,
      "Session advanced.",
    );
    return { ok: true, session: next };
  }

  /**
   * Close a session, keeping its step and data exactly as they are,
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
   * Resume a closed session at its exact saved step, with its saved
   * data, status back to "open", and append a "session-resume" change
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
