/**
 * Tests for the Worker skeleton: the health route, the removed seed
 * route, the owner-scoping shape of the seed data, and the 404
 * refusal for anything else.
 */

import { describe, expect, it } from "vitest";

import worker from "./index";
import { seedState } from "./seed";

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

  /**
   * With no database configured and no explicit in-memory allowance,
   * a /memory route fails closed: a JSON 500, never a silently
   * in-memory answer and never a thrown stack trace.
   */
  it("answers /memory with a JSON error when no store is configured", async () => {
    const response = await worker.fetch(
      new Request("https://x.test/memory/anything?as=acct_salesperson"),
      {},
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "internal error",
    });
  });

  /**
   * The seed route is gone: it returned both owners' accounts to
   * anyone who asked, so GET /seed is refused with the same 404 as
   * any unknown route.
   */
  it("refuses the removed seed route with a 404", async () => {
    const response = await worker.fetch(new Request("https://x.test/seed"));
    expect(response.status).toBe(404);
  });
});

describe("seed data", () => {
  /** The seed defines both sample salespeople of the demo story. */
  it("contains both salespeople", () => {
    const ids = seedState().salespeople.map((person) => person.id);
    expect(ids).toEqual(["acct_salesperson", "acct_salesperson_2"]);
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

  /**
   * No seeded account is marked as a special starting point: none
   * carries the old "ready_for_intake" status or a demo note, so
   * acct_willow is an ordinary account like the rest.
   */
  it("marks no account ready for intake and carries no demo note", () => {
    for (const account of seedState().accounts) {
      expect(account.status).not.toBe("ready_for_intake");
      expect(account).not.toHaveProperty("note");
    }
    const willow = seedState().accounts.find((account) => account.id === "acct_willow");
    expect(willow).toBeDefined();
    expect(willow).not.toHaveProperty("status");
  });
});
