/**
 * Sample seed data for the skeleton.
 *
 * Everything here is fictional sample data, labelled as samples wherever a
 * price or an account appears. Two sample salespeople each own their own
 * sample account; the product list and its sample pricing are shared.
 * Records that belong to one salesperson carry an `ownerId` so later work
 * can prove one salesperson's data never leaks into another's.
 */

import { MemoryStore, type Store } from "./store";

/** A salesperson. Their `id` is the `ownerId` on everything they own. */
export interface Salesperson {
  id: string;
  displayName: string;
}

/** A product in the shared catalogue. Prices live in `Pricing` records. */
export interface Product {
  id: string;
  name: string;
  description: string;
}

/**
 * A price for one product. `sample` is always `true`: amounts here are
 * labelled samples, never real prices.
 */
export interface Pricing {
  id: string;
  productId: string;
  /** How the price is charged, for example "CPC" or "vCPM". */
  model: string;
  /** What one unit is, for example "per click". */
  unit: string;
  amountUsd: number;
  sample: true;
}

/** A named contact at a sample account. */
export interface Stakeholder {
  name: string;
  role: string;
}

/**
 * A customer account owned by exactly one salesperson, named by `ownerId`.
 * `sample` is always `true`: accounts here are fictional samples.
 */
export interface Account {
  id: string;
  ownerId: string;
  name: string;
  stakeholders: Stakeholder[];
  sample: true;
}

/** The full seed state: salespeople, shared catalogue, and owned accounts. */
export interface SeedState {
  salespeople: Salesperson[];
  products: Product[];
  pricing: Pricing[];
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
      { id: "sp-1", displayName: "Riley Park" },
      { id: "sp-2", displayName: "Jordan Lee" },
    ],
    products: [
      {
        id: "native-ads",
        name: "Managed Native Advertising",
        description:
          "Native ad campaigns planned, run, and reported on for the client.",
      },
      {
        id: "display-ads",
        name: "Managed Display Advertising",
        description:
          "Display ad campaigns planned, run, and reported on for the client.",
      },
    ],
    pricing: [
      {
        id: "price-native-cpc",
        productId: "native-ads",
        model: "CPC",
        unit: "per click",
        amountUsd: 5,
        sample: true,
      },
      {
        id: "price-display-vcpm",
        productId: "display-ads",
        model: "vCPM",
        unit: "per 1,000 viewable impressions",
        amountUsd: 25,
        sample: true,
      },
    ],
    accounts: [
      {
        id: "acct-north-bakery",
        ownerId: "sp-1",
        name: "North Bakery (sample account)",
        stakeholders: [
          { name: "Priya", role: "Marketing lead" },
          { name: "Dan", role: "Owner" },
        ],
        sample: true,
      },
      {
        id: "acct-harbour-bikes",
        ownerId: "sp-2",
        name: "Harbour Bike Shop (sample account)",
        stakeholders: [{ name: "Mina", role: "Operations lead" }],
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
 * "pricing", and "accounts", keyed by each record's `id`.
 */
export async function seededStore(): Promise<Store> {
  const state = seedState();
  const store = new MemoryStore();
  for (const person of state.salespeople) {
    await store.put("salespeople", person.id, { ...person });
  }
  for (const product of state.products) {
    await store.put("products", product.id, { ...product });
  }
  for (const price of state.pricing) {
    await store.put("pricing", price.id, { ...price });
  }
  for (const account of state.accounts) {
    await store.put("accounts", account.id, { ...account });
  }
  return store;
}
