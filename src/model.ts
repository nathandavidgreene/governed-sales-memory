/**
 * The model client: one chat-completions call with function tools.
 *
 * The chat agent (see `chat.ts`) sends the conversation and the
 * governed tool definitions here and gets back one assistant message:
 * either reply text or a list of tool calls. The provider's
 * chat-completions endpoint is OpenAI-compatible and supports function
 * tools with `tool_choice: "auto"`, so tool calls arrive natively as a
 * `tool_calls` array whose arguments are JSON strings. This module only
 * moves messages; it runs no tool, stores nothing, and decides nothing.
 * `createModelClient` returns a client only when the `MODEL_API_KEY`
 * secret is present; without one the chat fails closed with an error.
 */

import type { WorkerEnv } from "./factory";

/** One function call the model asked for; `arguments` is a JSON string. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * One message in a chat-completions conversation. Assistant messages
 * may carry `tool_calls`; each tool result answers one call by
 * `tool_call_id`. Stored as-is on the session so history replays.
 */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** One function tool definition, in the chat-completions format. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** The assistant's answer to one call: reply text and/or tool calls. */
export interface AssistantTurn {
  content: string | null;
  tool_calls: ToolCall[];
}

/**
 * A model that answers one conversation turn, optionally with tools.
 * Implementations throw on any failure; the chat turns a throw into a
 * plain "model unavailable" error and never into a canned reply.
 */
export interface ModelClient {
  /** Send `messages` with `tools` and return the assistant's turn. */
  chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantTurn>;
}

/** The chat-completions endpoint of the model provider. */
const MODEL_ENDPOINT = "https://api.meta.ai/v1/chat/completions";

/** The model the Meta-backed client asks for. */
const MODEL_NAME = "muse-spark-1.3";

/**
 * Read a tool-call list out of a raw response message, keeping only
 * well-formed function calls (string id, name, and arguments). A
 * malformed entry is dropped rather than guessed at.
 */
function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    const call = entry as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    if (
      typeof call?.id === "string" &&
      typeof call.function?.name === "string" &&
      typeof call.function.arguments === "string"
    ) {
      calls.push({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments },
      });
    }
  }
  return calls;
}

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
   * Send one chat completion with function tools and return the
   * assistant's turn. Throws on a network failure, a non-200 answer,
   * or an answer with neither text nor a usable tool call.
   */
  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): Promise<AssistantTurn> {
    const response = await fetch(MODEL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages,
        tools,
        tool_choice: "auto",
      }),
    });
    if (!response.ok) {
      throw new Error(`model call failed with status ${response.status}`);
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
    };
    const message = body.choices?.[0]?.message;
    const content =
      typeof message?.content === "string" && message.content !== ""
        ? message.content
        : null;
    const toolCalls = parseToolCalls(message?.tool_calls);
    if (content === null && toolCalls.length === 0) {
      throw new Error("model call returned no text and no tool call");
    }
    return { content, tool_calls: toolCalls };
  }
}

/**
 * Build the model client for one environment.
 * A non-empty `MODEL_API_KEY` secret selects the Meta-backed client;
 * anything else returns `undefined`, which the chat answers with a
 * "model unavailable" error. Building the client makes no network call.
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
