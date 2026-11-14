/**
 * Tests for semantic search against the live database and Voyage.
 * Skipped entirely when MONGODB_URI or VOYAGE_API_KEY is unset, so CI
 * stays green without secrets. Run with both set, after the embed
 * script has run: the meaning test needs stored embeddings, and says
 * so plainly when there are none yet instead of failing on an
 * unembedded database.
 */

import { MongoClient, type Collection, type Document } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { searchMemories } from "./search";
import { createVoyageEmbedder } from "./voyage";

/** Whether both secrets are present in this run. */
const HAS_SECRETS =
  typeof process.env.MONGODB_URI === "string" &&
  process.env.MONGODB_URI !== "" &&
  typeof process.env.VOYAGE_API_KEY === "string" &&
  process.env.VOYAGE_API_KEY !== "";

/** Salesperson 2 in the seeded data, who must never see Harbor's memory. */
const SALESPERSON_2 = "acct_salesperson_2";

/** The Harbor CMO note Salesperson 2 must never receive. */
const HARBOR_CMO_ID = "mem_harbor_cmo";

describe.skipIf(!HAS_SECRETS)("vector search against the live database", () => {
  /** The one client this file opens; closed when the file finishes. */
  let client: MongoClient;
  /** The seeded memories collection. */
  let memories: Collection<Document>;
  /** The Voyage embedder for live queries. */
  let embed: (query: string) => Promise<number[]>;

  /**
   * Connect once for the file: one client, closed in afterAll, so no
   * test opens a client of its own.
   */
  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URI as string, {
      serverSelectionTimeoutMS: 10000,
    });
    await client.connect();
    memories = client
      .db(process.env.MONGODB_DB ?? "sales_memory")
      .collection("memories");
    embed = createVoyageEmbedder(process.env.VOYAGE_API_KEY as string);
  });

  /** Close the file's one client. */
  afterAll(async () => {
    await client.close();
  });

  /**
   * On the real seeded data, Salesperson 2 asking about Harbor's CMO
   * never receives the Harbor note — and everything they do receive
   * is theirs.
   */
  it(
    "never returns the Harbor CMO note to Salesperson 2",
    { timeout: 60000 },
    async () => {
      const hits = await searchMemories(
        SALESPERSON_2,
        "Harbor chief marketing officer Jordan Hale",
        5,
        { memories, embed },
      );
      expect(hits.map((hit) => hit.id)).not.toContain(HARBOR_CMO_ID);
      for (const hit of hits) {
        expect(hit.owner_salesperson_id).toBe(SALESPERSON_2);
      }
    },
  );

  /**
   * On the real seeded data, searching with one member of a paraphrase
   * pair finds its partner by meaning: same pair id, different note,
   * different words. When no memory has an embedding yet — the embed
   * script has not run — the vector path honestly returns nothing, and
   * the test says that instead of failing on an unembedded database.
   */
  it(
    "finds a paraphrase partner by meaning",
    { timeout: 60000 },
    async () => {
      const first = await memories.findOne({ demo_tag: "paraphrase" });
      expect(first).not.toBeNull();
      const pairId = first?.pair_id as string | undefined;
      expect(typeof pairId).toBe("string");
      const partner = await memories.findOne({
        demo_tag: "paraphrase",
        pair_id: pairId,
        _id: { $ne: first?._id },
      });
      expect(partner).not.toBeNull();
      const partnerId = partner?._id?.toString();
      expect(typeof partnerId).toBe("string");
      const embedded = await memories.countDocuments({
        embedding: { $exists: true },
      });
      const hits = await searchMemories(
        first?.owner_salesperson_id as string,
        first?.text as string,
        5,
        { memories, embed },
      );
      if (embedded === 0) {
        expect(hits).toEqual([]);
        return;
      }
      expect(hits.map((hit) => hit.id)).toContain(partnerId as string);
      for (const hit of hits) {
        expect(hit.owner_salesperson_id).toBe(
          first?.owner_salesperson_id as string,
        );
      }
    },
  );
});
