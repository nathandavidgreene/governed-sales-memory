/**
 * Worker entry point for the governed sales memory app.
 *
 * Routes:
 * - `GET /` serves the demo page (see `page.ts`): chat in the main
 *   pane, approval card, change log, and outbox in the side rail.
 * - `GET /health` reports that the Worker is up.
 * - `POST /memory?as=<salespersonId>` stores a memory item for its owner.
 * - `GET /memory/:id?as=<requesterId>` recalls one item for its owner;
 *   anyone else — and anyone asking for an item that does not exist —
 *   gets one identical generic refusal with HTTP 404.
 * - `POST /session?as=<salespersonId>` opens a working session on the
 *   salesperson's account.
 * - `GET /session/:id?as=<requesterId>` reads one session back, owner
 *   only; `POST /session/:id/close?as=` and `.../resume?as=` close and
 *   resume it, owner only.
 * - `POST /chat?as=<salespersonId>` runs one chat message in a session
 *   (see `chat.ts`) and returns the reply, the step, and any pending
 *   approval.
 * - `POST /approve/:id?as=<approverId>` approves a pending proposal —
 *   for its owner only; anyone else gets the same generic refusal as
 *   an unknown id, and the attempt is logged.
 * - `GET /change-log?as=<salespersonId>` returns the change log
 *   entries the requester made (plus ownerless system entries).
 * - `GET /outbox?as=<salespersonId>` returns the requester's own
 *   outbox entries (the CRM stand-in).
 * Any other route or method gets a JSON 404 rather than a guess.
 * There is deliberately no route that serves the seed state: it would
 * hand every owner's accounts to anyone who asked.
 *
 * The caller's identity comes only from the `?as=` query parameter,
 * never from the request body. Malformed input is answered with a JSON
 * 400, never a thrown 500. Handler failures — a refused store
 * selection, a database error — are answered as a JSON 500.
 *
 * The stateful routes run on the store the environment selects (see
 * `factory.ts`): the database when `MONGODB_URI` is set, failing
 * closed when it is not, unless `ALLOW_IN_MEMORY_STORE` is exactly
 * "true" (local development), in which case a shared in-memory bundle
 * answers so a POST and a later GET see the same items. The local
 * bundle's store starts from the sample seed, mirroring the seeded
 * database, so the demo path runs the same way locally.
 */

import { ChangeLog } from "./change-log";
import { ChatService } from "./chat";
import { createStore, type WorkerEnv } from "./factory";
import { MemoryService } from "./memory";
import { createModelClient } from "./model";
import { Outbox } from "./outbox";
import { demoPage } from "./page";
import { searchRoute } from "./search-route";
import { seededStore } from "./seed";
import { SessionService } from "./session";
import { MemoryStore, type Store } from "./store";

/** The governed services, all over one store and one change log. */
interface Services {
  memory: MemoryService;
  sessions: SessionService;
  outbox: Outbox;
  log: ChangeLog;
  chat: ChatService;
}

/**
 * Build the service bundle over one store.
 * Every service shares the store and the change log, so an action
 * taken through any of them lands in the same change log. The model
 * client is built from the environment: present only when its secret
 * is set, and consulted by the chat only for free-form replies.
 */
function buildServices(store: Store, env: WorkerEnv | undefined): Services {
  const log = new ChangeLog(store);
  const memory = new MemoryService(store, log);
  const sessions = new SessionService(store, log);
  const outbox = new Outbox(store);
  const chat = new ChatService(memory, sessions, store, createModelClient(env));
  return { memory, sessions, outbox, log, chat };
}

/** The shared in-memory services, once built. */
let sharedServices: Services | undefined;

/**
 * Return the shared in-memory services, building them on first use.
 * Module-level on purpose: a POST and a later GET must see the same
 * items, which a per-request store cannot do. Only used when the
 * environment explicitly allows the in-memory store (local dev); the
 * store starts from the sample seed, mirroring the seeded database,
 * so the accounts the chat works on exist locally too.
 */
async function sharedBundle(env: WorkerEnv | undefined): Promise<Services> {
  if (sharedServices === undefined) {
    sharedServices = buildServices(await seededStore(), env);
  }
  return sharedServices;
}

/**
 * Run `run` against the service bundle for one request's environment.
 *
 * Store selection happens in the factory and may refuse (no database
 * configured, no explicit in-memory allowance); that refusal — and any
 * database error from `run` — propagates to the fetch handler, which
 * answers it as a JSON error. A database-backed store is created for
 * this request and closed when the request finishes, so it holds at
 * most one client and never outlives the request.
 */
async function withServices<T>(
  env: WorkerEnv | undefined,
  run: (services: Services) => Promise<T>,
): Promise<T> {
  const store = createStore(env);
  if (store instanceof MemoryStore) {
    return run(await sharedBundle(env));
  }
  try {
    return await run(buildServices(store, env));
  } finally {
    await store.close?.();
  }
}

/**
 * Build a JSON response with the given body and HTTP status.
 * Centralised so every route answers with the same content type.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Read the caller's identity from the `?as=` query parameter.
 * Identity comes from nowhere else — never the request body. Returns
 * `undefined` when the parameter is missing or empty, which every
 * handler answers with a JSON 400.
 */
function requesterId(url: URL): string | undefined {
  const id = url.searchParams.get("as");
  return id === null || id === "" ? undefined : id;
}

/**
 * Map a governed service's error to an HTTP status.
 * The generic refusal "not found" is a 404 — identical for a missing
 * item and someone else's item, by design. State conflicts ("not
 * open", "not closed", "already decided") are 409; "outbox write
 * failed" is a 500, since the approval is still safely pending and
 * the failure is on this side, not the caller's.
 */
function errorStatus(error: string): number {
  if (error === "not found") {
    return 404;
  }
  if (error === "outbox write failed") {
    return 500;
  }
  if (
    error === "not open" ||
    error === "not closed" ||
    error === "already decided"
  ) {
    return 409;
  }
  return 400;
}

/**
 * The Worker handler.
 *
 * Routes one request, mapping any handler failure (a refused store
 * selection, a database error) to a JSON 500 rather than a thrown
 * stack trace.
 */
const worker = {
  /** Route one request to its handler, or a JSON 404. */
  async fetch(request: Request, env?: WorkerEnv): Promise<Response> {
    try {
      return await route(request, env);
    } catch {
      return jsonResponse({ ok: false, error: "internal error" }, 500);
    }
  },
};

/**
 * Route one request to its handler.
 * Split from `fetch` so the handler can own the error mapping; this
 * function lets handler errors propagate to it. An unknown route or
 * method is refused with a JSON 404, never guessed at.
 */
async function route(
  request: Request,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    return new Response(demoPage, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/memory") {
    return storeMemoryItem(request, url, env);
  }
  const recallMatch = /^\/memory\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && recallMatch !== null) {
    return recallMemoryItem(url, recallMatch[1], env);
  }
  if (request.method === "POST" && url.pathname === "/session") {
    return openSession(url, env);
  }
  if (request.method === "GET" && url.pathname === "/search") {
    return searchRoute(url, env);
  }
  if (request.method === "POST" && url.pathname === "/chat") {
    return chatMessage(request, url, env);
  }
  const sessionMatch = /^\/session\/([^/]+)(\/close|\/resume)?$/.exec(
    url.pathname,
  );
  if (sessionMatch !== null) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(sessionMatch[1]);
    } catch {
      return jsonResponse({ ok: false, error: "malformed id" }, 400);
    }
    const action = sessionMatch[2];
    if (request.method === "GET" && action === undefined) {
      return getSession(url, sessionId, env);
    }
    if (request.method === "POST" && action === "/close") {
      return changeSession(url, sessionId, env, "close");
    }
    if (request.method === "POST" && action === "/resume") {
      return changeSession(url, sessionId, env, "resume");
    }
  }
  const approveMatch = /^\/approve\/([^/]+)$/.exec(url.pathname);
  if (request.method === "POST" && approveMatch !== null) {
    let approvalId: string;
    try {
      approvalId = decodeURIComponent(approveMatch[1]);
    } catch {
      return jsonResponse({ ok: false, error: "malformed id" }, 400);
    }
    return approveChange(url, approvalId, env);
  }
  if (request.method === "GET" && url.pathname === "/change-log") {
    return changeLog(url, env);
  }
  if (request.method === "GET" && url.pathname === "/outbox") {
    return outboxEntries(url, env);
  }
  return jsonResponse({ error: "not found" }, 404);
}

/**
 * Handle `POST /memory?as=<salespersonId>`: store one item for its owner.
 * The owner is the `?as=` caller — an owner field in the body is never
 * trusted and is ignored. Fails closed with a JSON 400 when `as` is
 * missing, the body is not JSON, or a required field (`kind`, `text`)
 * is missing; an omitted `id` is generated.
 */
async function storeMemoryItem(
  request: Request,
  url: URL,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const ownerSalespersonId = requesterId(url);
  if (ownerSalespersonId === undefined) {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  let body: { id?: unknown; kind?: unknown; text?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "invalid body" }, 400);
  }
  if (typeof body.kind !== "string" || typeof body.text !== "string") {
    return jsonResponse({ ok: false, error: "missing fields" }, 400);
  }
  const kind = body.kind;
  const text = body.text;
  const id = typeof body.id === "string" ? body.id : undefined;
  const item = await withServices(env, (services) =>
    services.memory.remember(ownerSalespersonId, { id, kind, text }),
  );
  return jsonResponse({ ok: true, item }, 201);
}

/**
 * Handle `GET /memory/:id?as=<requesterId>`: recall one item.
 * The service's read rule decides; this handler only maps its answer
 * to HTTP — 200 for the owner, and one identical 404 refusal for both
 * a cross-owner read and an item that does not exist, so the two are
 * indistinguishable. A missing requester id or a malformed id in the
 * URL is a JSON 400.
 */
async function recallMemoryItem(
  url: URL,
  rawId: string,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const requester = requesterId(url);
  if (requester === undefined) {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  let itemId: string;
  try {
    itemId = decodeURIComponent(rawId);
  } catch {
    return jsonResponse({ ok: false, error: "malformed id" }, 400);
  }
  const result = await withServices(env, (services) =>
    services.memory.recall(requester, itemId),
  );
  if (!result.ok) {
    return jsonResponse(result, 404);
  }
  return jsonResponse(result);
}

/**
 * Handle `POST /session?as=<salespersonId>`: open a working session
 * on the salesperson's account, through the chat service.
 * Fails closed with a 400 when the requester id is missing or the
 * salesperson owns no account in the store.
 */
async function openSession(
  url: URL,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const ownerId = requesterId(url);
  if (ownerId === undefined) {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  const result = await withServices(env, (services) =>
    services.chat.openSession(ownerId),
  );
  if (!result.ok) {
    return jsonResponse(result, 400);
  }
  return jsonResponse({ ok: true, session: result.session }, 201);
}

/**
 * Handle `GET /session/:id?as=<requesterId>`: read one session back.
 * The session service's ownership check decides; this handler only
 * maps its answer to HTTP — 200 for the owner, the generic 404
 * refusal for anyone else (and for a session that does not exist),
 * 400 without a requester id.
 */
async function getSession(
  url: URL,
  sessionId: string,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const requester = requesterId(url);
  if (requester === undefined) {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  const result = await withServices(env, (services) =>
    services.sessions.get(sessionId, requester),
  );
  if (!result.ok) {
    return jsonResponse(result, errorStatus(result.error));
  }
  return jsonResponse({ ok: true, session: result.session });
}

/**
 * Handle `POST /session/:id/close?as=` and `.../resume?as=`: close or
 * resume one session for its owner, keeping the exact step and data.
 * The session service decides; errors map the same way as a read —
 * the generic 404 for another owner's session, 409 when the session
 * is in the wrong state — and a missing requester id is a 400.
 */
async function changeSession(
  url: URL,
  sessionId: string,
  env: WorkerEnv | undefined,
  action: "close" | "resume",
): Promise<Response> {
  const requester = requesterId(url);
  if (requester === undefined) {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  const result = await withServices(env, (services) =>
    action === "close"
      ? services.sessions.close(sessionId, requester)
      : services.sessions.resume(sessionId, requester),
  );
  if (!result.ok) {
    return jsonResponse(result, errorStatus(result.error));
  }
  return jsonResponse({ ok: true, session: result.session });
}

/**
 * Handle `POST /chat?as=<salespersonId>`: run one chat message in a
 * session. The body is `{ sessionId, text }`; the sender is the `?as=`
 * caller, never a body field. The chat service decides the reply;
 * errors map to the generic 404 (another owner's session, or none)
 * or 409 (session closed). A malformed body is a 400.
 */
async function chatMessage(
  request: Request,
  url: URL,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const senderId = requesterId(url);
  if (senderId === undefined) {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  let body: { sessionId?: unknown; text?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "invalid body" }, 400);
  }
  if (typeof body.sessionId !== "string" || typeof body.text !== "string") {
    return jsonResponse({ ok: false, error: "missing fields" }, 400);
  }
  const sessionId = body.sessionId;
  const text = body.text;
  const result = await withServices(env, (services) =>
    services.chat.handle(senderId, sessionId, text),
  );
  if (!result.ok) {
    return jsonResponse(result, errorStatus(result.error));
  }
  return jsonResponse(result);
}

/**
 * Handle `POST /approve/:id?as=<approverId>`: approve one pending
 * proposal — for the approval's owner only.
 * The decider is the `?as=` caller, never a body field; the request
 * body is not read at all. Approving goes through the memory service,
 * which checks ownership (a cross-owner attempt gets the one generic
 * refusal, identical to an unknown id, and is written to the change
 * log) and writes the outbox entry before marking the approval
 * decided, so one approval produces exactly one outbox entry and a
 * repeat attempt is a 409, not a second entry.
 */
async function approveChange(
  url: URL,
  approvalId: string,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const approverId = requesterId(url);
  if (approverId === undefined) {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  const result = await withServices(env, (services) =>
    services.memory.approve(approverId, approvalId),
  );
  if (!result.ok) {
    return jsonResponse(result, errorStatus(result.error));
  }
  return jsonResponse({ ok: true, approval: result.approval });
}

/**
 * Handle `GET /change-log?as=<salespersonId>`: the change log panel.
 * Entries are filtered to the requester: an entry belongs to the
 * salesperson who acted (its `actor`), and ownerless system entries
 * are shown to everyone. One salesperson's governed actions are never
 * listed in another's view. A missing requester id is a 400.
 */
async function changeLog(
  url: URL,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const requester = requesterId(url);
  if (requester === undefined) {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  const entries = await withServices(env, (services) =>
    services.log.entries(),
  );
  const visible = entries.filter(
    (entry) => entry.actor === requester || entry.actor === "system",
  );
  return jsonResponse({ ok: true, entries: visible });
}

/**
 * Handle `GET /outbox?as=<salespersonId>`: the outbox panel.
 * The outbox service's list is owner-filtered, so the panel only ever
 * shows the requester's own hand-offs to the CRM stand-in. A missing
 * requester id is a 400.
 */
async function outboxEntries(
  url: URL,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const requester = requesterId(url);
  if (requester === undefined) {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  const entries = await withServices(env, (services) =>
    services.outbox.list(requester),
  );
  return jsonResponse({ ok: true, entries });
}

export default worker;
