/**
 * Worker entry point for the governed sales memory app.
 *
 * Routes:
 * - `GET /health` reports that the Worker is up.
 * - `GET /seed` returns the sample seed state, read back out of a
 *   per-request in-memory store so the storage seam is exercised.
 * - `POST /memory?as=<salespersonId>` stores a memory item for its owner.
 * - `GET /memory/:id?as=<requesterId>` recalls one item for its owner;
 *   anyone else — and anyone asking for an item that does not exist —
 *   gets one identical generic refusal with HTTP 404.
 *
 * The caller's identity comes only from the `?as=` query parameter,
 * never from the request body. Malformed input is answered with a JSON
 * 400, never a thrown 500. Any other route or method gets a JSON 404
 * rather than a guess.
 *
 * The `/memory` routes run on the store the environment selects (see
 * `factory.ts`): the database when `MONGODB_URI` is set, and — only
 * when `ALLOW_IN_MEMORY_STORE` is exactly "true" — the shared in-memory
 * service used for local development. With neither, store selection
 * refuses and the route answers a JSON 500: the app fails closed
 * instead of silently keeping data in memory. Database errors surface
 * the same way, as JSON, never as a thrown stack trace.
 */

import { ChangeLog } from "./change-log";
import { createStore, type WorkerEnv } from "./factory";
import { MemoryService } from "./memory";
import { seededStore } from "./seed";
import { MemoryStore } from "./store";

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

/** The shared in-memory service behind the `/memory` routes, once built. */
let sharedMemory: MemoryService | undefined;

/**
 * Return the shared in-memory service, building it on first use.
 *
 * Module-level on purpose: a POST and a later GET must see the same
 * items, which a per-request store cannot do. Only used when the
 * environment explicitly allows the in-memory store (local dev).
 */
function sharedMemoryService(): MemoryService {
  if (sharedMemory === undefined) {
    const store = new MemoryStore();
    sharedMemory = new MemoryService(store, new ChangeLog(store));
  }
  return sharedMemory;
}

/**
 * Run `run` against the memory service for one request's environment.
 *
 * Store selection happens in the factory and may refuse (no database
 * configured, no explicit in-memory allowance); that refusal — and any
 * database error from `run` — propagates to the fetch handler, which
 * answers it as a JSON error. A database-backed store is created for
 * this request and closed when the request finishes, so it holds at
 * most one client and never outlives the request.
 */
async function withMemoryService<T>(
  env: WorkerEnv | undefined,
  run: (service: MemoryService) => Promise<T>,
): Promise<T> {
  const store = createStore(env);
  if (store instanceof MemoryStore) {
    return run(sharedMemoryService());
  }
  try {
    return await run(new MemoryService(store, new ChangeLog(store)));
  } finally {
    await store.close?.();
  }
}

/**
 * The Worker handler.
 *
 * Builds a fresh seeded store for each `/seed` request, so no state is
 * shared between requests there; `/memory` uses the service the
 * environment selects. The fetch method is the Worker's whole surface.
 */
const worker = {
  /**
   * Route one request to its handler, or a JSON 404.
   * Never throws for an unknown route; unknown means refused, not
   * guessed. Handler failures (a refused store selection, a database
   * error) are answered as a JSON 500 rather than thrown.
   */
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
 * function lets handler errors propagate to it.
 */
async function route(
  request: Request,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const url = new URL(request.url);
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
    return storeMemoryItem(request, url, env);
  }
  const recallMatch = /^\/memory\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && recallMatch !== null) {
    return recallMemoryItem(url, recallMatch[1], env);
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
  const ownerSalespersonId = url.searchParams.get("as");
  if (ownerSalespersonId === null || ownerSalespersonId === "") {
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
  const item = await withMemoryService(env, (service) =>
    service.remember(ownerSalespersonId, {
      id: typeof body.id === "string" ? body.id : undefined,
      kind: body.kind,
      text: body.text,
    }),
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
  const requesterId = url.searchParams.get("as");
  if (requesterId === null || requesterId === "") {
    return jsonResponse({ ok: false, error: "missing requester" }, 400);
  }
  let itemId: string;
  try {
    itemId = decodeURIComponent(rawId);
  } catch {
    return jsonResponse({ ok: false, error: "malformed id" }, 400);
  }
  const result = await withMemoryService(env, (service) =>
    service.recall(requesterId, itemId),
  );
  if (!result.ok) {
    return jsonResponse(result, 404);
  }
  return jsonResponse(result);
}

export default worker;
