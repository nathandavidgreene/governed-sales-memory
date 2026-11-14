/**
 * Worker entry point for the governed sales memory app.
 *
 * Routes:
 * - `GET /health` reports that the Worker is up.
 * - `GET /seed` returns the sample seed state, read back out of a
 *   per-request in-memory store so the storage seam is exercised.
 * - `POST /memory` stores a memory item for its owner.
 * - `GET /memory/:id?as=<requesterId>` recalls one item for its owner;
 *   anyone else gets the generic refusal with HTTP 403.
 * Any other route or method gets a JSON 404 rather than a guess.
 *
 * The `/memory` routes run on the store the environment selects (see
 * `factory.ts`): the database when `MONGODB_URI` is set, in-memory
 * otherwise. `/seed` always serves the sample seed from memory.
 */

import { createStore, type WorkerEnv } from "./factory";
import { MemoryService } from "./memory";
import { RecordLog } from "./record";
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
 * items, which a per-request in-memory store cannot do. This is the
 * fallback for when no database is configured.
 */
function sharedMemoryService(): MemoryService {
  if (sharedMemory === undefined) {
    const store = new MemoryStore();
    sharedMemory = new MemoryService(store, new RecordLog(store));
  }
  return sharedMemory;
}

/**
 * Return the memory service for one request's environment.
 *
 * With `MONGODB_URI` set, a fresh service is built over the database
 * store, so its state is the database's and nothing is shared between
 * requests. Without it, the shared in-memory service answers.
 */
function memoryService(env: WorkerEnv | undefined): MemoryService {
  if (typeof env?.MONGODB_URI === "string" && env.MONGODB_URI !== "") {
    const store = createStore(env);
    return new MemoryService(store, new RecordLog(store));
  }
  return sharedMemoryService();
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
   * Never throws for an unknown route; unknown means refused, not guessed.
   */
  async fetch(request: Request, env?: WorkerEnv): Promise<Response> {
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
      return storeMemoryItem(request, env);
    }
    const recallMatch = /^\/memory\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && recallMatch !== null) {
      return recallMemoryItem(url, recallMatch[1], env);
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
  const item = await memoryService(env).remember(body.ownerId, {
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
  const result = await memoryService(env).recall(
    requesterId,
    decodeURIComponent(rawId),
  );
  if (!result.ok) {
    return jsonResponse(result, result.error === "not yours" ? 403 : 404);
  }
  return jsonResponse(result);
}

export default worker;
