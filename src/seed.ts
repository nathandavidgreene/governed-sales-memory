/**
 * Sample seed data for local development and tests.
 *
 * Everything here is fictional sample data, labelled as samples wherever a
 * price or an account appears. The fixtures mirror the shape of the
 * seeded database, so tests exercise the same records the app runs on
 * against the database:
 *
 * - Accounts carry NO stakeholder map and NO budget: those arrive in
 *   conversation and are written as governed memory items, never read
 *   off the account. No account is special; `acct_willow` is an
 *   ordinary account like the rest.
 * - `acct_harbor` ("Harbor Street Media") belongs to the first
 *   salesperson too, so the second salesperson is the one refused on
 *   it; the second salesperson's own account is `acct_cabot_shore`.
 * - Products carry their own price wording in `rate_label` /
 *   `sample_label`; there is no separate pricing collection.
 * - The accounts collection also holds the salesperson rows themselves
 *   (`kind: "salesperson"`), which are not client accounts and must
 *   never be treated as ones.
 *
 * Records that belong to one salesperson carry an
 * `owner_salesperson_id` so later work can prove one salesperson's data
 * never leaks into another's.
 */

import { MemoryStore, type Store } from "./store";

/** A salesperson. Their `id` is the `owner_salesperson_id` on everything they own. */
export interface Salesperson {
  id: string;
  displayName: string;
}

/**
 * A product in the shared catalogue. Its price wording lives on the
 * product itself: `rate_label` is the sample rate as displayed (for
 * example "$5 CPC (per click)") and `sample_label` is the label that
 * marks it as a sample (always "sample price" here — amounts are
 * labelled samples, never real prices).
 */
export interface Product {
  id: string;
  name: string;
  rate_label: string;
  sample_label: string;
}

/**
 * A customer account owned by exactly one salesperson, named by
 * `owner_salesperson_id`. `sample` is always `true`: accounts here are
 * fictional samples. An account deliberately carries no stakeholder map
 * and no budget — those live in governed memory, gathered in
 * conversation. `status` is the account's plain-word state when the
 * seed gives it one.
 */
export interface Account {
  id: string;
  owner_salesperson_id: string;
  name: string;
  status?: string;
  sample: true;
}

/** The full seed state: salespeople, shared catalogue, and owned accounts. */
export interface SeedState {
  salespeople: Salesperson[];
  products: Product[];
  accounts: Account[];
}

/**
 * Build a fresh copy of the seed state.
 *
 * Returns new objects on every call, so a caller that edits the result
 * cannot change what the next caller receives.
 */
export function seedState(): SeedState {
  return {
    salespeople: [
      { id: "acct_salesperson", displayName: "Salesperson 1" },
      { id: "acct_salesperson_2", displayName: "Salesperson 2" },
    ],
    products: [
      {
        id: "native-ads",
        name: "Managed Native Advertising",
        rate_label: "$5 CPC (per click)",
        sample_label: "sample price",
      },
      {
        id: "display-ads",
        name: "Managed Display Advertising",
        rate_label: "$25 vCPM (per 1,000 viewable impressions)",
        sample_label: "sample price",
      },
    ],
    accounts: [
      {
        id: "acct_willow",
        owner_salesperson_id: "acct_salesperson",
        name: "Willow & Co. (sample account)",
        sample: true,
      },
      {
        id: "acct_harbor",
        owner_salesperson_id: "acct_salesperson",
        name: "Harbor Street Media (sample account)",
        sample: true,
      },
      {
        id: "acct_cabot_shore",
        owner_salesperson_id: "acct_salesperson_2",
        name: "Cabot Shore (sample account)",
        sample: true,
      },
    ],
  };
}

/**
 * Load the seed state into a new in-memory store and return it.
 *
 * Each call builds an independent store, so per-request callers never see
 * each other's edits. Collections are named "salespeople", "products",
 * and "accounts". Every stored document is keyed by an `_id` field equal
 * to the record's `id`, matching the database seed. The salespeople are
 * written into the accounts collection as well, as rows with
 * `kind: "salesperson"`, mirroring the database seed — readers of the
 * accounts collection must skip those rows, as the chat does.
 */
export async function seededStore(): Promise<Store> {
  const state = seedState();
  const store = new MemoryStore();
  for (const person of state.salespeople) {
    await store.put("salespeople", person.id, { _id: person.id, ...person });
    await store.put("accounts", person.id, {
      _id: person.id,
      id: person.id,
      kind: "salesperson",
      name: person.displayName,
      owner_salesperson_id: person.id,
    });
  }
  for (const product of state.products) {
    await store.put("products", product.id, { _id: product.id, ...product });
  }
  for (const account of state.accounts) {
    await store.put("accounts", account.id, { _id: account.id, ...account });
  }
  return store;
}
