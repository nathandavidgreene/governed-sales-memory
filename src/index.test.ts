/**
 * Tests for the Worker skeleton: the health route, the seed route, the
 * owner-scoping shape of the seed data, and the 404 refusal for anything
 * else.
 */

import { describe, expect, it } from "vitest";

import worker from "./index";
import { seedState, type Account } from "./seed";

describe("worker", () => {
  /** GET /health answers 200 with { ok: true } so callers can check liveness. */
  it("answers the health route with ok", async () => {
    const response = await worker.fetch(new Request("https://x.test/health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  /** An unknown route is refused with a JSON 404 rather than guessed at. */
  it("refuses unknown routes with a 404", async () => {
    const response = await worker.fetch(new Request("https://x.test/nope"));
    expect(response.status).toBe(404);
  });

  /** GET /seed serves both sample salespeople in its response body. */
  it("serves the seed state with both salespeople", async () => {
    const response = await worker.fetch(new Request("https://x.test/seed"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      salespeople: { id: string }[];
      accounts: Account[];
    };
    expect(body.salespeople.map((person) => person.id).sort()).toEqual([
      "sp-1",
      "sp-2",
    ]);
    expect(body.accounts).toHaveLength(2);
  });
});

describe("seed data", () => {
  /** The seed defines both sample salespeople, sp-1 and sp-2. */
  it("contains both salespeople", () => {
    const ids = seedState().salespeople.map((person) => person.id);
    expect(ids).toEqual(["sp-1", "sp-2"]);
  });

  /**
   * Every seeded account carries an owner_salesperson_id that names one
   * of the seeded salespeople — the ownership shape the no-leak proof
   * later relies on.
   */
  it("gives every account an owner_salesperson_id matching a salesperson", () => {
    const state = seedState();
    const salespersonIds = new Set(state.salespeople.map((person) => person.id));
    expect(state.accounts.length).toBeGreaterThan(0);
    for (const account of state.accounts) {
      expect(salespersonIds.has(account.owner_salesperson_id)).toBe(true);
    }
    const owners = new Set(
      state.accounts.map((account) => account.owner_salesperson_id),
    );
    expect(owners).toEqual(salespersonIds);
  });
});
