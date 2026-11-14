/**
 * Create the database indexes defined in db/indexes.json, plus the
 * Atlas Vector Search index defined in db/vector-index.json.
 *
 * This script runs outside the Worker, by a person who holds the
 * database secret: it reads MONGODB_URI (required) and MONGODB_DB
 * (optional, defaults to the database named in db/indexes.json) from
 * the environment, creates every listed index, and prints what it did.
 * It fails closed: no connection string in the environment means no
 * indexes and a non-zero exit, never a guess at where to connect.
 *
 * Run it once when the database is first set up, and again after the
 * index definitions change; creating an existing index is a no-op.
 * The vector search index is applied with createSearchIndex, which
 * only Atlas supports; if that fails the script says so and exits
 * non-zero, because a silently missing search index would hide behind
 * the keyword fallback.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";

/** Bound on how long to wait for a server before failing honestly. */
const SERVER_SELECTION_TIMEOUT_MS = 10000;

/**
 * Read and parse a JSON definition file from the repo's db/ folder.
 * Paths are resolved from this script's location, so the script can
 * be run from any working directory.
 */
async function loadDefinition(fileName) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const raw = await readFile(path.join(root, "db", fileName), "utf8");
  return JSON.parse(raw);
}

/**
 * Create every index in the definitions against the connected database.
 * Returns the number of indexes applied. Creating an index that already
 * exists is fine, so a re-run is safe.
 */
async function applyIndexes(db, definitions) {
  let applied = 0;
  for (const [collection, indexes] of Object.entries(definitions.collections)) {
    for (const index of indexes) {
      const { key, ...options } = index;
      const name = await db.collection(collection).createIndex(key, options);
      console.log(`${collection}: ${name}`);
      applied += 1;
    }
  }
  return applied;
}

/**
 * Create the Atlas Vector Search index from db/vector-index.json.
 * Search indexes are created differently from regular indexes, so
 * this goes through createSearchIndex with the definition's name,
 * type and fields. Returns the index name. Creating an existing
 * search index is a no-op on Atlas.
 */
async function applyVectorIndex(db, definition) {
  const name = await db.collection(definition.collection).createSearchIndex({
    name: definition.name,
    type: definition.type,
    definition: definition.definition,
  });
  console.log(`${definition.collection}: search index ${name}`);
  return name;
}

/**
 * Entry point: connect with a fresh client, apply the indexes, and
 * always close the client. Exits non-zero without connecting when
 * MONGODB_URI is missing, and non-zero if any index fails to apply.
 */
async function main() {
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || uri === "") {
    console.error("MONGODB_URI is not set; refusing to guess a database.");
    process.exitCode = 1;
    return;
  }
  const definitions = await loadDefinition("indexes.json");
  const dbName = process.env.MONGODB_DB ?? definitions.database;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const db = client.db(dbName);
    const applied = await applyIndexes(db, definitions);
    console.log(`Applied ${applied} indexes to database "${dbName}".`);
    const vector = await loadDefinition("vector-index.json");
    await applyVectorIndex(db, vector);
    console.log(`Applied the vector search index to database "${dbName}".`);
  } catch (error) {
    console.error(`Failed to apply indexes: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

await main();
