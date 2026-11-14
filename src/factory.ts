/**
 * Choosing the store the Worker runs on.
 *
 * When the `MONGODB_URI` secret is set, the app persists to the database
 * through `AtlasStore`. When it is not set — local development, tests —
 * the app uses the in-memory store, which keeps no state between
 * instances. The choice is made from the environment alone, in one
 * place, so no route decides for itself where data lives.
 */

import { AtlasStore } from "./atlas-store";
import { MemoryStore, type Store } from "./store";

/** The database the app uses when `MONGODB_DB` does not name one. */
export const DEFAULT_DB_NAME = "sales_memory";

/**
 * The Worker's environment bindings this app reads.
 * `MONGODB_URI` is a secret and is never set in config files;
 * `MONGODB_DB` is a plain variable naming the database.
 */
export interface WorkerEnv {
  /** Connection string for the database, from the secret store. */
  MONGODB_URI?: string;
  /** Database name; defaults to `DEFAULT_DB_NAME` when unset. */
  MONGODB_DB?: string;
}

/**
 * Build the store for one environment.
 * A non-empty `MONGODB_URI` selects the database-backed store (building
 * it does not connect — connections happen per operation); anything
 * else selects a fresh in-memory store.
 */
export function createStore(env: WorkerEnv | undefined): Store {
  const uri = env?.MONGODB_URI;
  if (typeof uri === "string" && uri !== "") {
    return new AtlasStore(uri, env?.MONGODB_DB ?? DEFAULT_DB_NAME);
  }
  return new MemoryStore();
}
