/**
 * Embed the seeded memories with Voyage, so vector search has vectors
 * to rank. Runs outside the Worker, by a person who holds the
 * secrets: it reads MONGODB_URI and VOYAGE_API_KEY from the
 * environment, embeds the `text` of every memory in `memories` that
 * does not already carry a 1024-dimension embedding, and writes each
 * vector back into that memory's `embedding` field. Re-running is
 * safe — embedded memories are skipped — so an interrupted run
 * resumes where it stopped.
 *
 * Fails closed: a missing secret means no connection and a non-zero
 * exit; a Voyage failure or wrong-shaped response stops the run with
 * the status and the batch left unwritten; a memory without text is
 * skipped, counted, and reported, and the run exits non-zero so a
 * seed data problem is not hidden behind success. No secret is ever
 * printed. Model note: voyage-3 (1024 dimensions) is used,
 * matching db/vector-index.json — the same constants live in src/voyage.ts; keep the
 * two in sync.
 *
 *   MONGODB_URI=... VOYAGE_API_KEY=... node scripts/embed-memories.mjs
 */

import { MongoClient } from "mongodb";

/** The Voyage embeddings endpoint. */
const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

/** The Voyage model used to embed memory text. Needs confirmation. */
const VOYAGE_MODEL = "voyage-3";

/** Dimensions a voyage-3 vector has; must match db/vector-index.json. */
const EMBEDDING_DIMENSIONS = 1024;

/** Most texts one Voyage call carries; larger batches are split first. */
const BATCH_SIZE = 50;

/** How long one Voyage call may take before it is abandoned. */
const VOYAGE_REQUEST_TIMEOUT_MS = 30000;

/** Bound on how long to wait for a server before failing honestly. */
const SERVER_SELECTION_TIMEOUT_MS = 10000;

/** The database the seeded memories live in, unless MONGODB_DB names one. */
const DEFAULT_DB_NAME = "sales_memory";

/** The collection the seeded memories live in. */
const MEMORIES_COLLECTION = "memories";

/** Most skipped ids the final report names; the count is always printed. */
const MAX_SKIPPED_IDS_SHOWN = 10;

/**
 * Split `items` into batches of at most `size`, in order.
 * Pure: the input is never changed.
 */
function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Ask Voyage to embed one batch of texts as documents, and return one
 * vector per text, in order. Throws with the HTTP status when Voyage
 * fails, and throws when the response does not carry exactly one
 * 1024-dimension vector per text — a wrong-shaped response is never
 * written to the database.
 */
async function embedBatch(apiKey, texts) {
  const response = await fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: "document",
    }),
    signal: AbortSignal.timeout(VOYAGE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Voyage embeddings failed with HTTP ${response.status}; batch left unwritten.`,
    );
  }
  const body = await response.json();
  if (!Array.isArray(body.data) || body.data.length !== texts.length) {
    throw new Error(
      "Voyage returned an unexpected number of embeddings; batch left unwritten.",
    );
  }
  const vectors = [];
  for (const item of body.data) {
    const vector = item.embedding;
    if (
      !Array.isArray(vector) ||
      vector.length !== EMBEDDING_DIMENSIONS ||
      vector.some((n) => typeof n !== "number" || !Number.isFinite(n))
    ) {
      throw new Error(
        `Voyage returned an embedding that is not ${EMBEDDING_DIMENSIONS} numbers; batch left unwritten.`,
      );
    }
    vectors.push(vector);
  }
  return vectors;
}

/**
 * Whether a stored memory still needs embedding: it has no vector, or
 * the vector it has is not a full 1024-dimension one.
 */
function needsEmbedding(doc) {
  return (
    !Array.isArray(doc.embedding) ||
    doc.embedding.length !== EMBEDDING_DIMENSIONS ||
    doc.embedding.some((n) => typeof n !== "number" || !Number.isFinite(n))
  );
}

/**
 * Entry point: connect with a fresh client, embed every memory that
 * needs it, and always close the client. Exits non-zero without
 * connecting when a secret is missing, and non-zero when any batch
 * fails or any memory has no text to embed.
 */
async function main() {
  const uri = process.env.MONGODB_URI;
  const apiKey = process.env.VOYAGE_API_KEY;
  const missing = [];
  if (uri === undefined || uri === "") {
    missing.push("MONGODB_URI");
  }
  if (apiKey === undefined || apiKey === "") {
    missing.push("VOYAGE_API_KEY");
  }
  if (missing.length > 0) {
    console.error(
      `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set; refusing to embed without them.`,
    );
    process.exitCode = 1;
    return;
  }
  const dbName = process.env.MONGODB_DB ?? DEFAULT_DB_NAME;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const memories = client.db(dbName).collection(MEMORIES_COLLECTION);
    const docs = await memories
      .find({}, { projection: { _id: 1, text: 1, embedding: 1 } })
      .toArray();
    const toEmbed = [];
    const skipped = [];
    for (const doc of docs) {
      if (typeof doc.text !== "string") {
        skipped.push(doc._id);
      } else if (needsEmbedding(doc)) {
        toEmbed.push(doc);
      }
    }
    if (toEmbed.length === 0) {
      console.log(`All ${docs.length} memories already have embeddings.`);
    }
    let embedded = 0;
    for (const batch of chunk(toEmbed, BATCH_SIZE)) {
      const vectors = await embedBatch(apiKey, batch.map((doc) => doc.text));
      await memories.bulkWrite(
        batch.map((doc, index) => ({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { embedding: vectors[index] } },
          },
        })),
      );
      embedded += batch.length;
      console.log(`Embedded ${embedded} of ${toEmbed.length} memories.`);
    }
    console.log(
      `Embedded ${embedded} memories into "${dbName}.${MEMORIES_COLLECTION}".`,
    );
    if (skipped.length > 0) {
      console.error(
        `${skipped.length} ${skipped.length === 1 ? "memory has" : "memories have"} no text field and were not embedded: ${skipped
          .slice(0, MAX_SKIPPED_IDS_SHOWN)
          .join(", ")}${skipped.length > MAX_SKIPPED_IDS_SHOWN ? ", ..." : ""}`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Failed to embed memories: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

await main();
