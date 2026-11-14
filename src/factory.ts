/**
 * Choosing the store the Worker runs on.
 *
 * When the `MONGODB_URI` secret is set, the app persists to the
 * database through `AtlasStore`. When it is not set, the app refuses
 * to choose a store at all — failing closed — unless the environment
 * explicitly allows the in-memory store by setting
 * `ALLOW_IN_MEMORY_STORE` to exactly "true". That flag exists for
 * local development and tests only: a deployment missing its database
 * secret must stop, not silently keep the day's governed memory in
 * process memory. The choice is made from the environment alone, in
 * one place, so no route decides for itself where data lives.
 */

import { AtlasStore } from "./atlas-store";
import { MemoryStore, type Store } from "./store";

/** The database the app uses when `MONGODB_DB` does not name one. */
export const DEFAULT_DB_NAME = "sales_memory";

/**
 * The Worker's environment bindings this app reads.
 * `MONGODB_URI` and `MODEL_API_KEY` are secrets and are never set in
 * config files; `MONGODB_DB` is a plain variable naming the database;
 * `ALLOW_IN_MEMORY_STORE` is the local-dev escape hatch described in
 * the module docs.
 */
export interface WorkerEnv {
  /** Connection string for the database, from the secret store. */
  MONGODB_URI?: string;
  /** Database name; defaults to `DEFAULT_DB_NAME` when unset. */
  MONGODB_DB?: string;
  /**
   * API key for the model the chat may use for free-form replies,
   * from the secret store. Unset means scripted replies only; the
   * governed intents never depend on it (see `model.ts`).
   */
  MODEL_API_KEY?: string;
  /**
   * Exactly "true" allows the in-memory store when no connection
   * string is set. Any other value — "TRUE", "1", unset — does not.
   */
  ALLOW_IN_MEMORY_STORE?: string;
  /** Voyage API key for query embeddings; unset means keyword search only. */
  VOYAGE_API_KEY?: string;
}

/**
 * Build the store for one environment.
 * A non-empty `MONGODB_URI` selects the database-backed store
 * (building it does not connect — the client connects lazily, once,
 * on first use). Without one, an explicit `ALLOW_IN_MEMORY_STORE` of
 * exactly "true" selects a fresh in-memory store; anything else
 * throws, failing closed.
 */
export function createStore(env: WorkerEnv | undefined): Store {
  const uri = env?.MONGODB_URI;
  if (typeof uri === "string" && uri !== "") {
    return new AtlasStore(uri, env?.MONGODB_DB ?? DEFAULT_DB_NAME);
  }
  if (env?.ALLOW_IN_MEMORY_STORE === "true") {
    return new MemoryStore();
  }
  throw new Error(
    "no database configured: MONGODB_URI is unset and " +
      'ALLOW_IN_MEMORY_STORE is not "true"; refusing to run without a store',
  );
}
