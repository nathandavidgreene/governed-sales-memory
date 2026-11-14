/**
 * Create the database indexes defined in db/indexes.json.
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
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MongoClient } from "mongodb";

/** Bound on how long to wait for a server before failing honestly. */
const SERVER_SELECTION_TIMEOUT_MS = 10000;

/**
 * Read and parse db/indexes.json from the repository root.
 * The path is resolved from this script's location, so the script can
 * be run from any working directory.
 */
async function loadIndexDefinitions() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const raw = await readFile(path.join(root, "db", "indexes.json"), "utf8");
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
 * Entry point: connect with a fresh client, apply the indexes, and
 * always close the client. Exits non-zero without connecting when
 * MONGODB_URI is missing.
 */
async function main() {
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || uri === "") {
    console.error("MONGODB_URI is not set; refusing to guess a database.");
    process.exitCode = 1;
    return;
  }
  const definitions = await loadIndexDefinitions();
  const dbName = process.env.MONGODB_DB ?? definitions.database;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const applied = await applyIndexes(client.db(dbName), definitions);
    console.log(`Applied ${applied} indexes to database "${dbName}".`);
  } finally {
    await client.close();
  }
}

await main();
