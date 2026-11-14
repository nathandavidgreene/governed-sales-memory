/**
 * Worker entry point for the governed sales memory app.
 *
 * Routes:
 * - `GET /` serves the demo page (see `page.ts`): chat in the main
 *   pane, approval card, change log, and outbox in the side rail.
 * - `GET /health` reports that the Worker is up.
 * - `GET /seed` returns the sample seed state, read back out of a
 *   per-request in-memory store so the storage seam is exercised.
 * - `POST /memory` stores a memory item for its owner.
 * - `GET /memory/:id?as=<requesterId>` recalls one item for its owner;
 *   anyone else gets the generic refusal with HTTP 403.
 * - `POST /session` opens a working session for a salesperson.
 * - `GET /session/:id?as=<requesterId>` reads one session back, owner
 *   only; `POST /session/:id/close?as=` and `.../resume?as=` close and
 *   resume it, owner only.
 * - `POST /chat` runs one scripted chat message in a session (see
 *   `chat.ts`) and returns the reply, the step, and any pending
 *   approval.
 * - `POST /approve/:id` approves a pending proposal for its owner and
 *   guarantees the outbox holds exactly one entry for it.
 * - `GET /records` returns the change log (the record log's entries).
 * - `GET /outbox` returns the outbox entries (the CRM stand-in).
 * Any other route or method gets a JSON 404 rather than a guess.
 *
 * The stateful routes run on the store the environment selects (see
 * `factory.ts`): the database when `MONGODB_URI` is set, in-memory
 * otherwise. `/seed` always serves the sample seed from memory.
 */

import { ChatService } from "./chat";
import { createStore, type WorkerEnv } from "./factory";
import { MemoryService } from "./memory";
import { Outbox } from "./outbox";
import { demoPage } from "./page";
import { RecordLog } from "./record";
import { seededStore } from "./seed";
import { SessionService } from "./session";
import { MemoryStore, type Store } from "./store";

/** The governed services, all over one store and one record log. */
interface Services {
  memory: MemoryService;
  sessions: SessionService;
  outbox: Outbox;
  log: RecordLog;
  chat: ChatService;
}

/**
 * Build the service bundle over one store.
 * Every service shares the store and the record log, so an action
 * taken through any of them lands in the same change log.
 */
function buildServices(store: Store): Services {
  const log = new RecordLog(store);
  const memory = new MemoryService(store, log);
  const sessions = new SessionService(store, log);
  const outbox = new Outbox(store);
  const chat = new ChatService(memory, sessions, store);
  return { memory, sessions, outbox, log, chat };
}

/** The shared in-memory services, once built. */
let sharedServices: Services | undefined;

/**
 * Return the services for one request's environment.
 *
 * With `MONGODB_URI` set, a fresh bundle is built over the database
 * store, so its state is the database's and nothing is shared between
 * requests. Without it, a shared in-memory bundle answers, so a POST
 * and a later GET see the same items within the isolate — the fallback
 * for when no database is configured.
 */
function services(env: WorkerEnv | undefined): Services {
  if (typeof env?.MONGODB_URI === "string" && env.MONGODB_URI !== "") {
    return buildServices(createStore(env));
  }
  if (sharedServices === undefined) {
    sharedServices = buildServices(new MemoryStore());
  }
  return sharedServices;
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
 * Map a governed service's fail-closed error to an HTTP status.
 * "not yours" is 403, "not found" and "unknown approval" are 404, and
 * state conflicts ("not open", "not closed", "already decided") are
 * 409; anything else is a 400.
 */
function errorStatus(error: string): number {
  if (error === "not yours") {
    return 403;
  }
  if (error === "not found" || error === "unknown approval") {
    return 404;
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
 * Builds a fresh seeded store for each `/seed` request, so no state is
 * shared between requests there; the stateful routes use the services
 * the environment selects. The fetch method is the Worker's whole
 * surface.
 */
const worker = {
  /**
   * Route one request to its handler, or a JSON 404.
   * Never throws for an unknown route; unknown means refused, not guessed.
   */
  async fetch(request: Request, env?: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(demoPage, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/seed") {
      const store = await seededStore();
      return jsonResponse({
        salespeople: await store.list("salespeople"),
        products: await store.list("products"),
        pricing: await store.list("pricing"),
        accounts: await store.list("accounts"),
      });
    }
    if (request.method === "POST" && url.pathname === "/memory") {
      return storeMemoryItem(request, env);
    }
    const recallMatch = /^\/memory\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && recallMatch !== null) {
      return recallMemoryItem(url, recallMatch[1], env);
    }
    if (request.method === "POST" && url.pathname === "/session") {
      return openSession(request, env);
    }
    if (request.method === "POST" && url.pathname === "/chat") {
      return chatMessage(request, env);
    }
    const sessionMatch = /^\/session\/([^/]+)(\/close|\/resume)?$/.exec(
      url.pathname,
    );
    if (sessionMatch !== null) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
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
      return approveChange(request, decodeURIComponent(approveMatch[1]), env);
    }
    if (request.method === "GET" && url.pathname === "/records") {
      const entries = await services(env).log.entries();
      return jsonResponse({ ok: true, entries });
    }
    if (request.method === "GET" && url.pathname === "/outbox") {
      const entries = await services(env).outbox.list();
      return jsonResponse({ ok: true, entries });
    }
    return jsonResponse({ error: "not found" }, 404);
  },
};

/**
 * Handle `POST /memory`: store one item for its owner.
 * Fails closed with 400 when the body is not JSON or a required field
 * (`ownerId`, `kind`, `text`) is missing; an omitted `id` is generated.
 */
async function storeMemoryItem(
  request: Request,
  env: WorkerEnv | undefined,
): Promise<Response> {
  let body: { ownerId?: unknown; id?: unknown; kind?: unknown; text?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "invalid body" }, 400);
  }
  if (
    typeof body.ownerId !== "string" ||
    typeof body.kind !== "string" ||
    typeof body.text !== "string"
  ) {
    return jsonResponse({ ok: false, error: "missing fields" }, 400);
  }
  const item = await services(env).memory.remember(body.ownerId, {
    id: typeof body.id === "string" ? body.id : undefined,
    kind: body.kind,
    text: body.text,
  });
  return jsonResponse({ ok: true, item }, 201);
}

/**
 * Handle `GET /memory/:id?as=<requesterId>`: recall one item.
 * The service's read rule decides; this handler only maps its answer to
 * HTTP — 200 for the owner, 403 for the generic cross-owner refusal,
 * 404 when there is nothing there, 400 without a requester id.
 */
async function recallMemoryItem(
  url: URL,
  rawId: string,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const requesterId = url.searchParams.get("as");
  if (requesterId === null || requesterId === "") {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  const result = await services(env).memory.recall(
    requesterId,
    decodeURIComponent(rawId),
  );
  if (!result.ok) {
    return jsonResponse(result, result.error === "not yours" ? 403 : 404);
  }
  return jsonResponse(result);
}

/**
 * Handle `POST /session`: open a working session for one salesperson.
 * The body names `ownerId`; the chat service finds that salesperson's
 * sample account. Fails closed with 400 for a malformed body, a
 * missing owner id, or an owner with no account.
 */
async function openSession(
  request: Request,
  env: WorkerEnv | undefined,
): Promise<Response> {
  let body: { ownerId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "invalid body" }, 400);
  }
  if (typeof body.ownerId !== "string" || body.ownerId === "") {
    return jsonResponse({ ok: false, error: "missing fields" }, 400);
  }
  const result = await services(env).chat.openSession(body.ownerId);
  if (!result.ok) {
    return jsonResponse(result, 400);
  }
  return jsonResponse({ ok: true, session: result.session }, 201);
}

/**
 * Handle `GET /session/:id?as=<requesterId>`: read one session back.
 * The session service's ownership check decides; this handler only maps
 * its answer to HTTP — 200 for the owner, 403 for the generic
 * cross-owner refusal, 404 when there is nothing there, 400 without a
 * requester id.
 */
async function getSession(
  url: URL,
  sessionId: string,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const requesterId = url.searchParams.get("as");
  if (requesterId === null || requesterId === "") {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  const result = await services(env).sessions.get(sessionId, requesterId);
  if (!result.ok) {
    return jsonResponse(result, errorStatus(result.error));
  }
  return jsonResponse({ ok: true, session: result.session });
}

/**
 * Handle `POST /session/:id/close?as=` and `.../resume?as=`: close or
 * resume one session for its owner, keeping the exact step and data.
 * The session service decides; errors map the same way as a read —
 * 403 for another owner's session, 404 when missing, 409 when the
 * session is in the wrong state — and a missing requester id is a 400.
 */
async function changeSession(
  url: URL,
  sessionId: string,
  env: WorkerEnv | undefined,
  action: "close" | "resume",
): Promise<Response> {
  const requesterId = url.searchParams.get("as");
  if (requesterId === null || requesterId === "") {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  const bundle = services(env);
  const result =
    action === "close"
      ? await bundle.sessions.close(sessionId, requesterId)
      : await bundle.sessions.resume(sessionId, requesterId);
  if (!result.ok) {
    return jsonResponse(result, errorStatus(result.error));
  }
  return jsonResponse({ ok: true, session: result.session });
}

/**
 * Handle `POST /chat`: run one scripted chat message in a session.
 * The body is `{ sessionId, as, text }`. The chat service decides the
 * reply; errors map to 403 (another owner's session), 404 (no such
 * session), or 409 (session closed). A malformed body is a 400.
 */
async function chatMessage(
  request: Request,
  env: WorkerEnv | undefined,
): Promise<Response> {
  let body: { sessionId?: unknown; as?: unknown; text?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "invalid body" }, 400);
  }
  if (
    typeof body.sessionId !== "string" ||
    typeof body.as !== "string" ||
    typeof body.text !== "string"
  ) {
    return jsonResponse({ ok: false, error: "missing fields" }, 400);
  }
  const result = await services(env).chat.handle(
    body.as,
    body.sessionId,
    body.text,
  );
  if (!result.ok) {
    return jsonResponse(result, errorStatus(result.error));
  }
  return jsonResponse(result);
}

/**
 * Handle `POST /approve/:id`: approve one pending proposal.
 * The body is `{ as }`, the salesperson deciding. Approving goes
 * through the memory service, which writes the change to the outbox;
 * the explicit `writeOnApprove` call below is this route's own
 * guarantee and is idempotent — one approval still produces exactly
 * one outbox entry, and a second approve attempt is a 409, not a
 * second entry. An unknown approval id is a 404 and a missing decider
 * is a 400.
 */
async function approveChange(
  request: Request,
  approvalId: string,
  env: WorkerEnv | undefined,
): Promise<Response> {
  let body: { as?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "invalid body" }, 400);
  }
  if (typeof body.as !== "string" || body.as === "") {
    return jsonResponse({ ok: false, error: "missing fields" }, 400);
  }
  const bundle = services(env);
  const result = await bundle.memory.approve(body.as, approvalId);
  if (!result.ok) {
    return jsonResponse(result, errorStatus(result.error));
  }
  const entry = await bundle.outbox.writeOnApprove(result.approval);
  return jsonResponse({ ok: true, approval: result.approval, entry });
}

export default worker;
