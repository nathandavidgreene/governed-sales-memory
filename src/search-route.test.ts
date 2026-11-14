/**
 * Tests for the read-only search route, with an injected search
 * function so no database or Voyage is needed.
 */

import { describe, expect, it } from "vitest";

import type { MemoryHit } from "./search";
import { handleSearch, searchRoute, SEARCH_ROUTE_LIMIT } from "./search-route";

/** Harbor's CMO note, owned by Salesperson 1. */
const HARBOR_CMO: MemoryHit = {
  id: "mem_harbor_cmo",
  owner_salesperson_id: "acct_salesperson",
  text: "Harbor's chief marketing officer is Jordan Hale.",
  account_id: "acct_harbor",
};

/** Cabot Shore's CMO note, owned by Salesperson 2: the look-alike. */
const CABOT_CMO: MemoryHit = {
  id: "mem_cabot_cmo_near_miss",
  owner_salesperson_id: "acct_salesperson_2",
  text: "Cabot Shore Advisors' chief marketing officer is Dana Whitfield.",
  account_id: "acct_cabot_shore",
};

describe("search route", () => {
  /**
   * SP2 never gets Harbor: the owner passed to search is the ?as=
   * caller, and even a leaking search layer has the foreign hit dropped.
   */
  it("never returns Harbor's memory to Salesperson 2", async () => {
    const owners: string[] = [];
    const response = await handleSearch(
      new URL("https://x.test/search?as=acct_salesperson_2&q=who%20is%20the%20CMO"),
      async (owner, _query, k) => {
        owners.push(owner);
        expect(k).toBe(SEARCH_ROUTE_LIMIT);
        return [HARBOR_CMO, CABOT_CMO];
      },
    );
    expect(owners).toEqual(["acct_salesperson_2"]);
    const body = (await response.json()) as { hits: { id: string }[] };
    expect(body.hits.map((hit) => hit.id)).toEqual(["mem_cabot_cmo_near_miss"]);
  });

  /** A missing requester is refused before any search runs. */
  it("refuses a search with no requester", async () => {
    let called = false;
    const response = await handleSearch(
      new URL("https://x.test/search?q=cmo"),
      async () => {
        called = true;
        return [];
      },
    );
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  /** An empty query is refused before any search runs. */
  it("refuses an empty query", async () => {
    const response = await handleSearch(
      new URL("https://x.test/search?as=acct_salesperson&q=%20"),
      async () => [],
    );
    expect(response.status).toBe(400);
  });

  /** Without a database configured the route fails closed with a 503. */
  it("fails closed without a database", async () => {
    const response = await searchRoute(
      new URL("https://x.test/search?as=acct_salesperson&q=cmo"),
      {},
    );
    expect(response.status).toBe(503);
  });
});
