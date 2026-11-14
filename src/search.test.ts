/**
 * Tests for semantic search that run without a database or Voyage: a
 * fake memories collection that records the queries it receives and
 * ranks by real cosine similarity, so the meaning, isolation, and
 * fallback behaviour is verified for real — only the database and the
 * embedder are fake. Live behaviour against the seeded Atlas data is
 * covered by search.integration.test.ts, which skips without secrets.
 */

import type { Collection, Document } from "mongodb";
import { describe, expect, it } from "vitest";

import {
  MAX_SEARCH_RESULTS,
  searchMemories,
  type SearchDeps,
} from "./search";

/** Salesperson 1 in the seeded data, who owns the Harbor account. */
const SALESPERSON_1 = "acct_salesperson";

/** Salesperson 2 in the seeded data, who owns the Cabot Shore account. */
const SALESPERSON_2 = "acct_salesperson_2";

/** One fake stored memory, shaped like the seeded documents. */
interface FakeDoc {
  _id: string;
  owner_salesperson_id: string;
  text?: string;
  kind?: string;
  account_id?: string;
  demo_tag?: string;
  pair_id?: string;
  forgotten?: boolean;
  embedding?: number[];
}

/** Harbor's CMO note, owned by Salesperson 1. */
const HARBOR_CMO: FakeDoc = {
  _id: "mem_harbor_cmo", owner_salesperson_id: SALESPERSON_1,
  text: "Harbor's chief marketing officer is Jordan Hale. Reach them through the Harbor front desk.",
  kind: "note", account_id: "acct_harbor", embedding: [1, 0, 0],
};

/** Cabot Shore Advisors' CMO note, owned by Salesperson 2: the look-alike to the Harbor note. */
const CABOT_CMO: FakeDoc = {
  _id: "mem_cabot_cmo_near_miss", owner_salesperson_id: SALESPERSON_2,
  text: "Cabot Shore Advisors' chief marketing officer is Dana Whitfield.",
  kind: "note", account_id: "acct_cabot_shore", demo_tag: "near_miss", pair_id: "cmo-pair",
  embedding: [0.9, 0.4359, 0],
};

/** A note about a buyer who wants to sign fast, owned by Salesperson 1. */
const SPEED_NOTE: FakeDoc = {
  _id: "mem_speed_note", owner_salesperson_id: SALESPERSON_1,
  text: "The buyer wants to sign this week and move fast.",
  kind: "note", demo_tag: "paraphrase", pair_id: "speed-pair", embedding: [0, 1, 0],
};

/** The same idea in different words: no shared words with the query. */
const SPEED_PARAPHRASE: FakeDoc = {
  _id: "mem_speed_paraphrase", owner_salesperson_id: SALESPERSON_1,
  text: "The client is in a hurry to close the deal soon.",
  kind: "note", demo_tag: "paraphrase", pair_id: "speed-pair", embedding: [0.1, 0.995, 0],
};

/** A forgotten note: same meaning as the speed note, but forgotten. */
const FORGOTTEN_NOTE: FakeDoc = {
  _id: "mem_forgotten_note", owner_salesperson_id: SALESPERSON_1,
  text: "The buyer wants to sign this week.",
  kind: "note", forgotten: true, embedding: [0, 1, 0],
};

/** A document with no text: malformed, never a result. */
const NO_TEXT_DOC: FakeDoc = {
  _id: "mem_no_text", owner_salesperson_id: SALESPERSON_1,
  kind: "note", embedding: [0, 1, 0],
};

/** All fixtures together, the fake collection's contents. */
const ALL_DOCS = [
  HARBOR_CMO, CABOT_CMO, SPEED_NOTE, SPEED_PARAPHRASE, FORGOTTEN_NOTE, NO_TEXT_DOC,
];

/** Words the fake keyword search ignores, mirroring a text index's stop words. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "is", "to", "of", "in", "for", "on",
]);

/**
 * Cosine similarity between two vectors, for the fake's ranking.
 * Returns 0 for mismatched or empty vectors instead of guessing.
 */
function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * A fake memories collection: records every query it receives, and
 * answers the vector stage by real cosine ranking and the keyword
 * stage by word matching, both over its fixture documents. With
 * `leak` set, it ignores every filter and hands back all documents,
 * so the tests can prove `searchMemories` still drops what must not
 * cross owners. With `failVector` set, the vector stage throws, so
 * the tests can prove the keyword fallback runs.
 */
class FakeMemories {
  /** Every aggregation pipeline this fake received, in order. */
  aggregateCalls: Document[] = [];
  /** Every find filter and options this fake received, in order. */
  findCalls: Array<{ filter: Document; options?: Document }> = [];

  /** Wrap the fixture documents; `leak` and `failVector` change its behaviour. */
  constructor(
    private readonly docs: FakeDoc[],
    private readonly leak = false,
    private readonly failVector = false,
  ) {}

  /** Answer a vector search: filter, rank by cosine, take the limit. */
  aggregate(pipeline: Document[]): { toArray: () => Promise<Document[]> } {
    this.aggregateCalls.push(pipeline);
    if (this.failVector) throw new Error("vector index missing");
    const stage = pipeline[0].$vectorSearch as {
      queryVector: number[];
      limit: number;
      filter: { owner_salesperson_id: string };
    };
    let pool = [...this.docs];
    if (!this.leak) {
      pool = pool.filter(
        (doc) =>
          doc.owner_salesperson_id === stage.filter.owner_salesperson_id &&
          doc.forgotten !== true,
      );
      pool.sort(
        (a, b) =>
          cosine(b.embedding ?? [], stage.queryVector) -
          cosine(a.embedding ?? [], stage.queryVector),
      );
      pool = pool.slice(0, stage.limit);
    }
    return { toArray: async () => pool.map((doc) => asStored(doc, stage)) };
  }

  /** Answer a keyword search: filter, match words, take the limit. */
  find(
    filter: Document,
    options?: Document,
  ): { toArray: () => Promise<Document[]> } {
    this.findCalls.push({ filter, options });
    let pool = [...this.docs];
    if (!this.leak) {
      const terms = String(filter.$text.$search)
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
      pool = pool.filter(
        (doc) =>
          doc.owner_salesperson_id === filter.owner_salesperson_id &&
          doc.forgotten !== true &&
          doc.text !== undefined &&
          terms.some((term) => doc.text!.toLowerCase().includes(term)),
      );
      pool = pool.slice(0, (options?.limit as number | undefined) ?? pool.length);
    }
    return { toArray: async () => pool.map((doc) => asStored(doc)) };
  }
}

/**
 * Turn a fixture into the document the database would hand back: the
 * stored fields plus a score — the cosine similarity for a vector
 * result, 1 for a keyword result.
 */
function asStored(doc: FakeDoc, stage?: { queryVector: number[] }): Document {
  const stored: Document = {
    _id: doc._id,
    text: doc.text,
    owner_salesperson_id: doc.owner_salesperson_id,
    forgotten: doc.forgotten ?? false,
    score: stage === undefined ? 1 : cosine(doc.embedding ?? [], stage.queryVector),
  };
  for (const field of ["kind", "account_id", "demo_tag", "pair_id"] as const) {
    if (typeof doc[field] === "string") stored[field] = doc[field];
  }
  return stored;
}

/** An embedder that always returns one fixed vector. */
function fixedEmbedder(vector: number[]): (query: string) => Promise<number[]> {
  return async () => vector;
}

/** An embedder that always fails, as Voyage would on an outage or a limit. */
async function failingEmbedder(): Promise<number[]> {
  throw new Error("Voyage is down");
}

/** Build search dependencies over a fake collection and an embedder. */
function depsFor(
  fake: FakeMemories,
  embed: (query: string) => Promise<number[]>,
): SearchDeps {
  return { memories: fake as unknown as Collection<Document>, embed };
}

describe("searchMemories input checks", () => {
  /** A search with no owner or no question refuses instead of guessing. */
  it("refuses an empty owner or query", async () => {
    const fake = new FakeMemories(ALL_DOCS);
    const embed = fixedEmbedder([1, 0, 0]);
    await expect(
      searchMemories("", "something", 5, depsFor(fake, embed)),
    ).rejects.toThrow("salesperson id");
    await expect(
      searchMemories(SALESPERSON_1, "   ", 5, depsFor(fake, embed)),
    ).rejects.toThrow("query");
    expect(fake.aggregateCalls).toEqual([]);
  });

  /** A search with a bad result count refuses; a huge ask is capped. */
  it("refuses a bad result count and caps a large one", async () => {
    const fake = new FakeMemories(ALL_DOCS);
    const embed = fixedEmbedder([0, 1, 0]);
    await expect(
      searchMemories(SALESPERSON_1, "something", 0, depsFor(fake, embed)),
    ).rejects.toThrow("positive whole number");
    const hits = await searchMemories(
      SALESPERSON_1, "buyer", 100, depsFor(fake, embed),
    );
    const stage = fake.aggregateCalls[0][0].$vectorSearch as { limit: number };
    expect(stage.limit).toBe(MAX_SEARCH_RESULTS);
    expect(hits.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
  });
});

describe("vector search path", () => {
  /**
   * The paraphrase shares no content words with the query, so only
   * meaning can find it — and it ranks first, ahead of the note it
   * paraphrases, without ever touching the keyword path.
   */
  it("finds a paraphrase by meaning, not by keywords", async () => {
    const fake = new FakeMemories(ALL_DOCS);
    const hits = await searchMemories(
      SALESPERSON_1,
      "the customer is eager to wrap things up quickly",
      2,
      depsFor(fake, fixedEmbedder([0.12, 0.9928, 0])),
    );
    expect(hits.map((hit) => hit.id)).toEqual([
      "mem_speed_paraphrase",
      "mem_speed_note",
    ]);
    expect(fake.findCalls).toEqual([]);
  });

  /** The vector stage itself carries the owner and unforgotten filter. */
  it("filters the vector stage to the caller and to unforgotten memories", async () => {
    const fake = new FakeMemories(ALL_DOCS);
    await searchMemories(
      SALESPERSON_2,
      "who is the chief marketing officer",
      5,
      depsFor(fake, fixedEmbedder([0.95, 0.3122, 0])),
    );
    const stage = fake.aggregateCalls[0][0].$vectorSearch as {
      filter: Document;
    };
    expect(stage.filter).toEqual({
      owner_salesperson_id: SALESPERSON_2,
      forgotten: false,
    });
  });

  /**
   * Salesperson 2 asking about a CMO gets their own Cabot Shore note
   * and never the Harbor note — even when the store hands back both.
   */
  it("never returns another salesperson's memory", async () => {
    const fake = new FakeMemories(ALL_DOCS, true);
    const hits = await searchMemories(
      SALESPERSON_2,
      "who is the chief marketing officer",
      5,
      depsFor(fake, fixedEmbedder([0.95, 0.3122, 0])),
    );
    expect(hits.map((hit) => hit.id)).toEqual(["mem_cabot_cmo_near_miss"]);
    expect(hits.map((hit) => hit.id)).not.toContain("mem_harbor_cmo");
  });

  /** A forgotten note and a malformed document are never returned. */
  it("never returns a forgotten or malformed memory", async () => {
    const fake = new FakeMemories(ALL_DOCS, true);
    const hits = await searchMemories(
      SALESPERSON_1,
      "the buyer wants to sign this week",
      5,
      depsFor(fake, fixedEmbedder([0, 1, 0])),
    );
    expect(hits.map((hit) => hit.id)).not.toContain("mem_forgotten_note");
    expect(hits.map((hit) => hit.id)).not.toContain("mem_no_text");
  });
});

describe("keyword fallback", () => {
  /** When Voyage fails, the keyword search runs and finds by words. */
  it("runs the keyword search when Voyage fails", async () => {
    const fake = new FakeMemories(ALL_DOCS);
    const hits = await searchMemories(
      SALESPERSON_1,
      "Harbor",
      5,
      depsFor(fake, failingEmbedder),
    );
    expect(fake.findCalls).toHaveLength(1);
    expect(hits.map((hit) => hit.id)).toEqual(["mem_harbor_cmo"]);
  });

  /** When the vector stage itself fails, the keyword search runs. */
  it("runs the keyword search when the vector query fails", async () => {
    const fake = new FakeMemories(ALL_DOCS, false, true);
    const hits = await searchMemories(
      SALESPERSON_1,
      "Harbor",
      5,
      depsFor(fake, fixedEmbedder([1, 0, 0])),
    );
    expect(fake.findCalls).toHaveLength(1);
    expect(hits.map((hit) => hit.id)).toEqual(["mem_harbor_cmo"]);
  });

  /** The keyword search carries the same owner and unforgotten filter. */
  it("filters the keyword search to the caller and to unforgotten memories", async () => {
    const fake = new FakeMemories(ALL_DOCS);
    await searchMemories(SALESPERSON_2, "Cabot", 5, depsFor(fake, failingEmbedder));
    expect(fake.findCalls[0].filter).toEqual({
      $text: { $search: "Cabot" },
      owner_salesperson_id: SALESPERSON_2,
      forgotten: false,
    });
  });

  /** The fallback keeps the owner rule too: no Harbor note for Salesperson 2. */
  it("never returns another salesperson's memory through the fallback", async () => {
    const fake = new FakeMemories(ALL_DOCS, true);
    const hits = await searchMemories(
      SALESPERSON_2,
      "Harbor",
      5,
      depsFor(fake, failingEmbedder),
    );
    expect(hits.map((hit) => hit.id)).not.toContain("mem_harbor_cmo");
  });

  /**
   * The query the vector path found by meaning has no keywords in
   * common with any note, so the fallback honestly finds nothing —
   * the meaning result came from vectors, not words.
   */
  it("finds nothing by keywords for a pure paraphrase query", async () => {
    const fake = new FakeMemories(ALL_DOCS);
    const hits = await searchMemories(
      SALESPERSON_1,
      "the customer is eager to wrap things up quickly",
      5,
      depsFor(fake, failingEmbedder),
    );
    expect(hits).toEqual([]);
  });

  /** A successful vector search never touches the keyword path. */
  it("does not run the keyword search when the vector path succeeds", async () => {
    const fake = new FakeMemories(ALL_DOCS);
    await searchMemories(
      SALESPERSON_1,
      "Harbor",
      5,
      depsFor(fake, fixedEmbedder([1, 0, 0])),
    );
    expect(fake.findCalls).toEqual([]);
  });
});
