/**
 * Embedding through Voyage: turning text into vectors for search.
 *
 * One small wrapper around the Voyage embeddings endpoint. The API key
 * arrives from the caller, never from the environment here and never
 * in a log line: a missing key fails closed before any request, and a
 * failed request throws with its HTTP status only — the key is never
 * part of an error message. Stored text is embedded as a "document"
 * and a search query as a "query", as Voyage recommends.
 *
 * The model is voyage-3 (1024 dimensions). The vector index in
 * db/vector-index.json is built for 1024 dimensions, so a different
 * model means a different index. Change it in one place —
 * VOYAGE_MODEL below — and rebuild the index to match.
 * scripts/embed-memories.mjs carries the same constants; keep the two
 * in sync.
 */

/** The Voyage embeddings endpoint. */
export const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

/**
 * The Voyage model used to embed memory text and search queries.
 * voyage-3, matching the 1024-dimension vector index.
 */
export const VOYAGE_MODEL = "voyage-3";

/**
 * Dimensions a voyage-3 vector has; must match db/vector-index.json.
 * Only enforced for the default model — a different model has its own
 * dimension, and this module refuses to guess what it is.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** Most texts one Voyage call accepts; larger batches are refused, not split. */
export const VOYAGE_MAX_TEXTS_PER_CALL = 128;

/** How long one Voyage call may take before it is abandoned. */
export const VOYAGE_REQUEST_TIMEOUT_MS = 30000;

/** The two sides of a retrieval: stored text is a "document", a query is a "query". */
export type VoyageInputType = "document" | "query";

/**
 * Embed `texts` with Voyage, in the order given, and return one vector
 * per text. Fails closed: a missing key, an empty batch, a batch over
 * the call limit, a failed request, or a response whose vectors do not
 * match the request all throw — a caller never receives a partial or
 * wrong-shaped set of vectors to store or search with.
 */
export async function embedTexts(
  apiKey: string,
  texts: string[],
  inputType: VoyageInputType = "document",
  model: string = VOYAGE_MODEL,
): Promise<number[][]> {
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new Error(
      "Voyage API key is missing; refusing to embed without one.",
    );
  }
  if (texts.length === 0) {
    return [];
  }
  if (texts.length > VOYAGE_MAX_TEXTS_PER_CALL) {
    throw new Error(
      `Refusing to embed ${texts.length} texts in one call ` +
        `(limit ${VOYAGE_MAX_TEXTS_PER_CALL}); split the batch first.`,
    );
  }
  const response = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: texts, input_type: inputType }),
    signal: AbortSignal.timeout(VOYAGE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Voyage embeddings failed with HTTP ${response.status}; no vectors returned.`,
    );
  }
  const body = (await response.json()) as {
    data?: Array<{ embedding?: unknown }>;
  };
  if (!Array.isArray(body.data) || body.data.length !== texts.length) {
    throw new Error(
      "Voyage returned an unexpected number of embeddings; refusing to use them.",
    );
  }
  const vectors: number[][] = [];
  for (const item of body.data) {
    const vector = item.embedding;
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      vector.some((n) => typeof n !== "number" || !Number.isFinite(n))
    ) {
      throw new Error(
        "Voyage returned an embedding with the wrong shape; refusing to use it.",
      );
    }
    if (model === VOYAGE_MODEL && vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Voyage returned a ${vector.length}-dimension embedding, ` +
          `not ${EMBEDDING_DIMENSIONS}; refusing to use it.`,
      );
    }
    vectors.push(vector as number[]);
  }
  return vectors;
}

/**
 * Embed one search query with Voyage, as a "query" (the retrieval
 * side), and return its vector. See `embedTexts` for the failure
 * behaviour.
 */
export async function embedQuery(
  apiKey: string,
  query: string,
): Promise<number[]> {
  const [vector] = await embedTexts(apiKey, [query], "query");
  return vector;
}

/**
 * Build the one-query embedder `searchMemories` takes, bound to one
 * API key. The key is held in the closure and never logged; a missing
 * key fails on the first call, not at build time, so the caller can
 * build the embedder before the key is known to be present.
 */
export function createVoyageEmbedder(
  apiKey: string,
): (query: string) => Promise<number[]> {
  return (query: string) => embedQuery(apiKey, query);
}

/**
 * Build a one-text document embedder bound to one API key, for
 * embedding memory text when it is stored or corrected. Embeds as a
 * "document" with the default model, one text per call — never a
 * batch, to stay inside the free tier's rate limit. Throws on any
 * failure, like `embedTexts`; the memory service catches that and
 * stores the text without a vector.
 */
export function createVoyageDocumentEmbedder(
  apiKey: string,
): (text: string) => Promise<number[]> {
  return async (text: string) => {
    const [vector] = await embedTexts(apiKey, [text], "document");
    return vector;
  };
}
