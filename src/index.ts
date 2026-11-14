/**
 * Worker entry point for the governed sales memory app.
 *
 * The skeleton answers two routes and refuses everything else:
 * - `GET /health` reports that the Worker is up.
 * - `GET /seed` returns the sample seed state, read back out of a
 *   per-request in-memory store so the storage seam is exercised.
 * Any other route or method gets a JSON 404 rather than a guess.
 */

import { seededStore } from "./seed";

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
 * The Worker handler.
 *
 * Builds a fresh seeded store for each `/seed` request, so no state is
 * shared between requests. The fetch method is the whole surface of the
 * skeleton; feature routes arrive in later pull requests.
 */
const worker = {
  /**
   * Route one request: `/health`, `/seed`, or a JSON 404.
   * Never throws for an unknown route; unknown means refused, not guessed.
   */
  async fetch(request: Request): Promise<Response> {
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
    return jsonResponse({ error: "not found" }, 404);
  },
};

export default worker;
