/**
 * The model seam: where the chat would make a model call.
 *
 * The chat's governed intents — intake, correct, forget, propose, and
 * every refusal — are scripted and deterministic, and never touch this
 * seam. Only free-form replies may go to a model, and only when one is
 * configured: `createModelClient` returns a client when the
 * `MODEL_API_KEY` secret is present and `undefined` otherwise, and the
 * chat falls back to its scripted replies whenever there is no client
 * or the call fails. A model therefore can never break the demo path,
 * and nothing here is on the governed path — the model sees a prompt
 * and returns text; it stores nothing and decides nothing.
 */

import type { WorkerEnv } from "./factory";

/**
 * A model that can complete one prompt with one reply.
 * Implementations throw on any failure; callers treat a throw as "no
 * model answer" and fall back, never as an error worth surfacing.
 */
export interface ModelClient {
  /** Complete `prompt` and return the model's reply text. */
  complete(prompt: string): Promise<string>;
}

/** The chat-completions endpoint of the model provider. */
const MODEL_ENDPOINT = "https://api.meta.ai/v1/chat/completions";

/** The model the Meta-backed client asks for. */
const MODEL_NAME = "muse-spark-1.3";

/**
 * A `ModelClient` backed by the Meta model API.
 * The API key comes from the Worker's secret store (see
 * `createModelClient`); it is held only in memory, sent only as the
 * authorization header of the completion call, and never logged.
 */
export class MetaModelClient implements ModelClient {
  /** Wrap the API key from the `MODEL_API_KEY` secret. */
  constructor(private readonly apiKey: string) {}

  /**
   * Send one chat completion and return the reply text.
   * Throws on a network failure, a non-200 answer, or an answer with
   * no text in it — the chat treats every throw as "fall back".
   */
  async complete(prompt: string): Promise<string> {
    const response = await fetch(MODEL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      throw new Error(`model call failed with status ${response.status}`);
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content === "") {
      throw new Error("model call returned no text");
    }
    return content;
  }
}

/**
 * Build the model client for one environment.
 * A non-empty `MODEL_API_KEY` secret selects the Meta-backed client;
 * anything else returns `undefined`, which the chat reads as "scripted
 * replies only". Building the client makes no network call.
 */
export function createModelClient(
  env: WorkerEnv | undefined,
): ModelClient | undefined {
  const key = env?.MODEL_API_KEY;
  if (typeof key === "string" && key !== "") {
    return new MetaModelClient(key);
  }
  return undefined;
}
