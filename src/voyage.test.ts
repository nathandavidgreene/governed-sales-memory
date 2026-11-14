/**
 * Tests for the Voyage embedder that run without a key or network:
 * fetch is stubbed, so the failure behaviour and the response checks
 * are verified for real. Live embedding is covered by
 * search.integration.test.ts, which skips without secrets.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EMBEDDING_DIMENSIONS,
  VOYAGE_MAX_TEXTS_PER_CALL,
  embedQuery,
  embedTexts,
} from "./voyage";

/** A well-formed Voyage response carrying the given vectors. */
function voyageResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ embedding, index })),
      model: "voyage-3",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** One 1024-dimension vector, every element the same value. */
function flatVector(value: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => value);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedTexts", () => {
  /** No key, or a batch over the limit, means no request is made. */
  it("refuses to call Voyage with a missing key or an over-limit batch", async () => {
    const fetchMock = vi.fn(async () => voyageResponse([flatVector(0.1)]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(embedTexts("", ["hello"])).rejects.toThrow("API key is missing");
    const texts = Array.from(
      { length: VOYAGE_MAX_TEXTS_PER_CALL + 1 },
      () => "hello",
    );
    await expect(embedTexts("test-key", texts)).rejects.toThrow("limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** Vectors come back in the order the texts went in. */
  it("returns vectors in the order given", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => voyageResponse([flatVector(0.1), flatVector(0.2)])),
    );
    const vectors = await embedTexts("test-key", ["first", "second"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0][0]).toBe(0.1);
    expect(vectors[1][0]).toBe(0.2);
  });

  /** A short response is refused: vectors must match the request. */
  it("refuses a response with the wrong number of embeddings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => voyageResponse([flatVector(0.1)])),
    );
    await expect(embedTexts("test-key", ["first", "second"])).rejects.toThrow(
      "unexpected number",
    );
  });

  /** A wrong-dimension vector is refused, never stored or searched with. */
  it("refuses a vector with the wrong dimensions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => voyageResponse([[0.1, 0.2, 0.3]])),
    );
    await expect(embedTexts("test-key", ["hello"])).rejects.toThrow(
      "dimension",
    );
  });

  /** A failed request throws with its status and no vectors. */
  it("throws with the status when Voyage fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("slow down", { status: 429 })),
    );
    await expect(embedTexts("test-key", ["hello"])).rejects.toThrow(
      "HTTP 429",
    );
  });
});

describe("embedQuery", () => {
  /** A query is embedded as a "query", and the key stays in the header. */
  it("embeds one query as a query", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        voyageResponse([flatVector(0.5)]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const vector = await embedQuery("test-key", "who is the CMO");
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      model: string;
      input: string[];
      input_type: string;
    };
    expect(body).toEqual({
      model: "voyage-3",
      input: ["who is the CMO"],
      input_type: "query",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
  });
});
