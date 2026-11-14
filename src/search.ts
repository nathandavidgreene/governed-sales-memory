/**
 * Semantic search over the memories collection: find what a
 * salesperson's own memories mean, not just what they say.
 *
 * One function, `searchMemories`: embed the query with Voyage and ask
 * Atlas Vector Search for the closest memories, falling back to a
 * keyword search when Voyage fails or hits a limit. Both paths carry
 * the same owner rule — only the caller's own memories, and never a
 * forgotten one — and every returned memory is checked against that
 * rule a second time in code, so a database that handed back someone
 * else's memory would still not leak it.
 *
 * Wiring (for the chat): pass the connected `memories` collection and
 * an embedder built with `createVoyageEmbedder` from `./voyage`:
 *   searchMemories(ownerId, query, 5, { memories, embed })
 * The caller owns the database connection; this module never opens one
 * and never reads the environment. The vector index is defined in
 * db/vector-index.json; the keyword fallback uses the text index on
 * `text` in db/indexes.json.
 */

import type { Collection, Document } from "mongodb";

/** The collection memories live in. */
export const MEMORIES_COLLECTION = "memories";

/** The Atlas Vector Search index over the memories collection. */
export const MEMORIES_VECTOR_INDEX = "memories_vector";

/** The field on each memory document that holds its embedding vector. */
export const EMBEDDING_FIELD = "embedding";

/** Most matches one search ever returns; larger asks are capped, not refused. */
export const MAX_SEARCH_RESULTS = 20;

/** How many candidates the vector stage may consider per returned match. */
const CANDIDATES_PER_RESULT = 10;

/** Fewest candidates the vector stage considers, whatever k is. */
const MIN_CANDIDATES = 50;

/** One memory as a search result: the owner's own text, with its score. */
export interface MemoryHit {
  /** The memory's `_id`, for example "mem_harbor_cmo". */
  id: string;
  /** The memory's text, readable only by its owner. */
  text: string;
  /** The salesperson who owns this memory. */
  owner_salesperson_id: string;
  /** Plain-word category, when the memory has one. */
  kind?: string;
  /** The account the memory is about, when it names one. */
  account_id?: string;
  /** Test-pair marker, when the memory is part of one. */
  demo_tag?: string;
  /** The pair the memory belongs to, when it is part of one. */
  pair_id?: string;
  /** How close the match is, higher meaning closer. */
  score?: number;
}

/** Embed one query string and return its vector. Throws when Voyage fails. */
export type EmbedQuery = (query: string) => Promise<number[]>;

/** What `searchMemories` needs from its caller: the collection and an embedder. */
export interface SearchDeps {
  /** The connected `memories` collection. */
  memories: Collection<Document>;
  /** Embed one query string with Voyage. */
  embed: EmbedQuery;
}

/**
 * Search one salesperson's memories for `query`, returning at most
 * `k` matches, closest first.
 *
 * The vector path runs first: the query is embedded with Voyage and
 * Atlas Vector Search ranks the caller's own memories by meaning,
 * pre-filtered to `owner_salesperson_id` equal to `ownerId` and
 * `forgotten` false. When embedding or the vector query fails — a
 * Voyage outage, a rate limit, a missing index — the keyword fallback
 * runs instead, searching the same owner's unforgotten memories by
 * words. Both paths check every returned memory against the owner
 * rule a second time in code, so a leaked document is dropped rather
 * than returned. Fails closed on bad input: an empty owner, an empty
 * query, or a non-positive `k` throws instead of searching; a `k`
 * above the cap is capped. A failure in the keyword fallback itself
 * propagates — the caller sees the error rather than a fake empty
 * answer.
 */
export async function searchMemories(
  ownerId: string,
  query: string,
  k: number,
  deps: SearchDeps,
): Promise<MemoryHit[]> {
  const checked = checkSearchArgs(ownerId, query, k);
  try {
    const queryVector = await deps.embed(checked.query);
    const docs = await vectorSearch(
      deps.memories,
      checked.ownerId,
      queryVector,
      checked.limit,
    );
    return toHits(docs, checked.ownerId);
  } catch {
    const docs = await keywordSearch(
      deps.memories,
      checked.ownerId,
      checked.query,
      checked.limit,
    );
    return toHits(docs, checked.ownerId);
  }
}

/** The checked search arguments: a trimmed owner and query, and the capped limit. */
interface CheckedSearchArgs {
  ownerId: string;
  query: string;
  limit: number;
}

/**
 * Check the search arguments: an empty owner, an empty query, or a
 * `k` that is not a positive integer throws instead of searching —
 * a search with no owner, no question, or no room for an answer
 * refuses rather than guessing. A `k` above the cap is capped.
 */
function checkSearchArgs(
  ownerId: string,
  query: string,
  k: number,
): CheckedSearchArgs {
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    throw new Error(
      "Search needs a salesperson id; refusing to search without an owner.",
    );
  }
  if (typeof query !== "string" || query.trim() === "") {
    throw new Error("Search needs a query; refusing to search for nothing.");
  }
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(
      "Search needs a positive whole number of results; refusing to search with an invalid limit.",
    );
  }
  return {
    ownerId: ownerId.trim(),
    query: query.trim(),
    limit: Math.min(k, MAX_SEARCH_RESULTS),
  };
}

/**
 * Rank one salesperson's memories by meaning: ask Atlas Vector Search
 * for the closest unforgotten memories owned by `ownerId`. The filter
 * is part of the vector stage itself, so the database never scores
 * another owner's memories. `numCandidates` is bounded — ten per
 * returned match, at least fifty — so a large `k` cannot ask the
 * database for an unbounded candidate set.
 */
async function vectorSearch(
  memories: Collection<Document>,
  ownerId: string,
  queryVector: number[],
  limit: number,
): Promise<Document[]> {
  const pipeline: Document[] = [
    {
      $vectorSearch: {
        index: MEMORIES_VECTOR_INDEX,
        path: EMBEDDING_FIELD,
        queryVector,
        numCandidates: Math.max(limit * CANDIDATES_PER_RESULT, MIN_CANDIDATES),
        limit,
        filter: { owner_salesperson_id: ownerId, forgotten: false },
      },
    },
    {
      $project: {
        _id: 1,
        text: 1,
        owner_salesperson_id: 1,
        kind: 1,
        account_id: 1,
        demo_tag: 1,
        pair_id: 1,
        forgotten: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];
  return memories.aggregate(pipeline).toArray();
}

/**
 * The fallback: search one salesperson's unforgotten memories by
 * words, using the text index on `text` (see db/indexes.json).
 * Carries the same owner rule as the vector path — the filter is part
 * of the find itself — and ranks by the text score, closest first.
 */
async function keywordSearch(
  memories: Collection<Document>,
  ownerId: string,
  query: string,
  limit: number,
): Promise<Document[]> {
  const cursor = memories.find(
    {
      $text: { $search: query },
      owner_salesperson_id: ownerId,
      forgotten: false,
    },
    {
      projection: {
        _id: 1,
        text: 1,
        owner_salesperson_id: 1,
        kind: 1,
        account_id: 1,
        demo_tag: 1,
        pair_id: 1,
        forgotten: 1,
        score: { $meta: "textScore" },
      },
      sort: { score: { $meta: "textScore" } },
      limit,
    },
  );
  return cursor.toArray();
}

/**
 * Turn stored documents into search results, dropping anything that
 * breaks the owner rule: a document owned by someone else, a
 * forgotten one, or one without readable text or owner is never
 * returned, whatever the database handed back. This is the second
 * check — the database filter is the first — so a leak needs both to
 * fail before a memory crosses owners.
 */
function toHits(docs: Document[], ownerId: string): MemoryHit[] {
  const hits: MemoryHit[] = [];
  for (const doc of docs) {
    const hit = asHit(doc, ownerId);
    if (hit !== undefined) {
      hits.push(hit);
    }
  }
  return hits;
}

/**
 * Read one stored document as a search result, or `undefined` when it
 * must not be returned: another owner's memory, a forgotten memory,
 * or a document without a string id, text, or owner. The id comes
 * from `_id`, the key the seed uses.
 */
function asHit(doc: Document, ownerId: string): MemoryHit | undefined {
  if (doc.forgotten === true) {
    return undefined;
  }
  if (typeof doc._id !== "string" || typeof doc.text !== "string") {
    return undefined;
  }
  if (doc.owner_salesperson_id !== ownerId) {
    return undefined;
  }
  const hit: MemoryHit = {
    id: doc._id,
    text: doc.text,
    owner_salesperson_id: ownerId,
  };
  if (typeof doc.kind === "string") {
    hit.kind = doc.kind;
  }
  if (typeof doc.account_id === "string") {
    hit.account_id = doc.account_id;
  }
  if (typeof doc.demo_tag === "string") {
    hit.demo_tag = doc.demo_tag;
  }
  if (typeof doc.pair_id === "string") {
    hit.pair_id = doc.pair_id;
  }
  if (typeof doc.score === "number") {
    hit.score = doc.score;
  }
  return hit;
}
