/**
 * The read-only search route: `GET /search?as=<salespersonId>&q=<query>`.
 *
 * Wires `searchMemories` into the Worker so the demo can show
 * meaning-based recall. The owner is the `?as=` caller and nothing
 * else; the route returns at most `SEARCH_ROUTE_LIMIT` of that owner's
 * unforgotten memories and writes nothing — no memory, no session, no
 * change log entry. Vector search runs when the Voyage key is set; the
 * keyword fallback inside `searchMemories` covers a missing key, a
 * rate limit, or a Voyage outage. Every hit is checked against the
 * owner once more here, so another owner's memory is never returned.
 */

import { MongoClient } from "mongodb";

import { DEFAULT_DB_NAME, type WorkerEnv } from "./factory";
import {
  MEMORIES_COLLECTION,
  searchMemories,
  type MemoryHit,
  type SearchDeps,
} from "./search";
import { createVoyageEmbedder } from "./voyage";

/** How many matches the route returns. */
export const SEARCH_ROUTE_LIMIT = 5;

/** How long the route waits to reach the database before failing. */
const SERVER_SELECTION_TIMEOUT_MS = 5000;

/** Run one owner-scoped search; injectable so tests need no database. */
export type SearchFn = (
  ownerId: string,
  query: string,
  k: number,
) => Promise<MemoryHit[]>;

/**
 * Run `run` with a search function over the configured database, for
 * the chat agent's search tool. The database client is opened only if
 * a search actually runs, and is always closed when `run` finishes, so
 * it never outlives the request. Without a connection string `run`
 * gets `fallback` instead (the in-memory store's keyword search in
 * local development).
 */
export async function withDatabaseSearch<T>(
  env: WorkerEnv | undefined,
  fallback: SearchFn,
  run: (search: SearchFn) => Promise<T>,
): Promise<T> {
  const uri = env?.MONGODB_URI;
  if (typeof uri !== "string" || uri === "") {
    return run(fallback);
  }
  let client: MongoClient | undefined;
  const search: SearchFn = (owner, query, k) => {
    client ??= new MongoClient(uri, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    });
    const deps: SearchDeps = {
      memories: client
        .db(env?.MONGODB_DB ?? DEFAULT_DB_NAME)
        .collection(MEMORIES_COLLECTION),
      embed: createVoyageEmbedder(env?.VOYAGE_API_KEY ?? ""),
    };
    return searchMemories(owner, query, k, deps);
  };
  try {
    return await run(search);
  } finally {
    await client?.close();
  }
}

/**
 * Build a JSON response with the given body and status.
 * Kept local so this module does not depend on the router.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Handle the search route with an injected search function.
 * A missing `?as=` or an empty `q` is a 400 before any search runs.
 * Hits whose owner is not the caller are dropped, so a leak in the
 * search layer still never reaches the response.
 */
export async function handleSearch(url: URL, search: SearchFn): Promise<Response> {
  const ownerId = url.searchParams.get("as") ?? "";
  if (ownerId.trim() === "") {
    return json({ ok: false, error: "missing requester" }, 400);
  }
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query === "") {
    return json({ ok: false, error: "missing query" }, 400);
  }
  const hits = await search(ownerId, query, SEARCH_ROUTE_LIMIT);
  const own = hits
    .filter((hit) => hit.owner_salesperson_id === ownerId)
    .slice(0, SEARCH_ROUTE_LIMIT)
    .map((hit) => ({
      id: hit.id,
      text: hit.text,
      kind: hit.kind,
      account_id: hit.account_id,
      score: hit.score,
    }));
  return json({ ok: true, query, hits: own });
}

/**
 * Handle the search route against the configured database.
 * Opens one client for this request and always closes it. Without a
 * connection string the route fails closed with a 503 instead of
 * searching anything else. A missing Voyage key makes the embedder
 * throw, which sends `searchMemories` to its keyword fallback.
 */
export async function searchRoute(
  url: URL,
  env: WorkerEnv | undefined,
): Promise<Response> {
  const uri = env?.MONGODB_URI;
  if (typeof uri !== "string" || uri === "") {
    return json({ ok: false, error: "search unavailable" }, 503);
  }
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  });
  try {
    const deps: SearchDeps = {
      memories: client
        .db(env?.MONGODB_DB ?? DEFAULT_DB_NAME)
        .collection(MEMORIES_COLLECTION),
      embed: createVoyageEmbedder(env?.VOYAGE_API_KEY ?? ""),
    };
    return await handleSearch(url, (owner, query, k) =>
      searchMemories(owner, query, k, deps),
    );
  } finally {
    await client.close();
  }
}
