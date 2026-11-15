# Architecture

Everything runs in one Cloudflare Worker (`src/index.ts`). Each request picks
its store from the environment (`src/factory.ts`), builds the governed
services over it, and closes any database client when the request finishes.

```mermaid
flowchart LR
    Page["App page<br/>GET /"] -->|"?as=owner"| Worker["Worker router<br/>src/index.ts"]
    Worker --> Sessions["SessionService"]
    Worker --> Chat["ChatService<br/>tool-calling loop"]
    Worker --> Memory["MemoryService"]
    Worker --> SearchRoute["GET /search"]
    Chat --> Model["Model client<br/>chat completions"]
    Chat --> Memory
    Chat --> Sessions
    Memory --> Log["ChangeLog<br/>hash-chained"]
    Sessions --> Log
    Memory --> Outbox["Outbox<br/>CRM stand-in"]
    Memory --> Voyage["Voyage<br/>document embeddings"]
    SearchRoute --> Search["searchMemories"]
    Chat --> Search
    Search --> Voyage
    Memory --> Store[("Store<br/>Atlas or in-memory")]
    Sessions --> Store
    Log --> Store
    Outbox --> Store
    Search --> Store
```

## Request flow

A salesperson opens a blank session, then chats. Each chat turn sends the saved
conversation plus the new message to the model, with the tool definitions. The
model replies with text or with tool calls. Each tool call is run as the
`?as=` owner and its result is fed back, for at most **6 model calls** per turn
(`MAX_MODEL_CALLS`). Approval is a separate human request.

```mermaid
sequenceDiagram
    actor SP as Salesperson (page)
    participant W as Worker
    participant S as SessionService
    participant C as ChatService
    participant M as Model
    participant MS as MemoryService
    participant O as Outbox

    SP->>W: POST /session?as=owner
    W->>S: open(owner)
    S-->>W: empty session (no account, no history)
    W-->>SP: 201 session

    SP->>W: POST /chat?as=owner {sessionId, text}
    W->>C: handle(owner, sessionId, text, search)
    C->>S: get(sessionId, owner)
    loop at most 6 model calls
        C->>M: system prompt + history + tools
        alt tool calls
            M-->>C: tool_calls
            C->>MS: run each tool as owner
            MS-->>C: result or "not found"
        else text
            M-->>C: reply
        end
    end
    C->>S: saveHistory(conversation, proposal ids)
    W-->>SP: reply + pending approval, or 503 "model unavailable"

    SP->>W: POST /approve/:id?as=owner (Approve button)
    W->>MS: approve(owner, id)
    MS->>O: write outbox entry first
    MS-->>W: approval marked approved
    W-->>SP: 200 approval
```

### The tool-calling loop

```mermaid
flowchart TD
    Start(["POST /chat"]) --> Load{"Session found<br/>for this owner?"}
    Load -- no --> NF["404 not found"]
    Load -- yes --> Open{"Session open?"}
    Open -- no --> NO["409 not open"]
    Open -- yes --> HasModel{"Model configured?"}
    HasModel -- no --> MU["503 model unavailable"]
    HasModel -- yes --> Call["Call the model<br/>(call n of 6)"]
    Call -- "call fails" --> Fail
    Call --> Kind{"Tool calls?"}
    Kind -- "no, non-empty text" --> Save["Save history"] --> Reply(["200 reply<br/>+ pending approval"])
    Kind -- "no, empty text" --> Fail
    Kind -- yes --> Validate{"Known tool and<br/>exact arguments?"}
    Validate -- no --> Invalid["Result: invalid arguments<br/>or unknown tool"]
    Validate -- yes --> Run["Run tool as the ?as= owner"]
    Invalid --> More
    Run --> More{"Under 6 calls?"}
    More -- yes --> Call
    More -- no --> Fail["Save history if a tool ran<br/>503 model unavailable"]
```

### The governed tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `list_my_accounts` | none | The owner's own client accounts (id, name, status) |
| `list_products` | none | Products with their sample price wording, read-only |
| `search_memories` | `query` | Up to 5 of the owner's memories, by meaning |
| `remember` | `account_id`, `text`, `kind` | Saves a memory on one of the owner's accounts |
| `correct` | `item_id`, `text` | Replaces a memory's text; the old text stays in its history |
| `forget` | `item_id` | Replaces a memory's content with a tombstone |
| `propose` | `account_id`, `summary` | Stores a pending approval; nothing changes until a human approves |

No tool takes an owner argument, and a call with any extra argument key is
rejected as `invalid arguments` before it runs. There is no approve tool.

## Owner scoping

The owner is always the `?as=` caller. Every check that fails answers with the
same generic refusal, so a missing item and someone else's item look the same.
Cross-owner attempts are logged.

```mermaid
flowchart TD
    Req["Request with ?as=owner"] --> HasAs{"?as= present?"}
    HasAs -- no --> R400["400 missing requester"]
    HasAs -- yes --> Lookup["Load the item, account,<br/>session, or approval"]
    Lookup --> Exists{"Exists and<br/>not forgotten?"}
    Exists -- no --> Generic["Generic refusal<br/>not found (404)"]
    Exists -- yes --> Owner{"Owned by the<br/>?as= caller?"}
    Owner -- no --> Refuse["Append 'refuse' entry<br/>to the change log"] --> Generic
    Owner -- yes --> Act["Run the action and<br/>append its change log entry"]
```

Search applies the same rule twice. The database query filters on
`owner_salesperson_id` and `forgotten: false`, and every returned hit is checked
against the owner again in code. The chat's `search_memories` tool filters the
hits a third time before handing them to the model.

## Embed on write, search with a fallback

`remember` and `correct` embed the memory text with Voyage (`voyage-3`, 1024
dimensions) when the Voyage key is set. Embedding fails soft: if it fails, the
memory is stored without a vector rather than not at all. Search tries the
vector path first and falls back to keywords.

```mermaid
flowchart TD
    subgraph Write ["Write: remember or correct"]
        W1["Memory text"] --> W2{"Voyage key set?"}
        W2 -- no --> W4["Store without a vector"]
        W2 -- yes --> W3{"Embedding succeeds?"}
        W3 -- yes --> W5["Store with embedding"]
        W3 -- "no (rate limit, outage)" --> W4
    end
    subgraph Read ["Search: search_memories or GET /search"]
        S1["Query"] --> S2["Embed the query with Voyage"]
        S2 -- ok --> S3["Atlas Vector Search<br/>owner + not forgotten"]
        S3 --> S4{"Any hits?"}
        S4 -- yes --> S6["Owner check in code<br/>return hits"]
        S2 -- fails --> S5["Keyword search<br/>text index, same owner filter"]
        S3 -- fails --> S5
        S4 -- no --> S5
        S5 --> S6
    end
```

In local development, with no database, the chat's search is a simple keyword
match over the in-memory store instead.

## Approval and the outbox

```mermaid
stateDiagram-v2
    [*] --> pending: propose (agent tool)
    pending --> pending: approve fails (outbox write failed)
    pending --> approved: approve by owner (outbox entry written first)
    approved --> approved: approve again gives 409 already decided
    approved --> [*]
```

## Choosing the store

```mermaid
flowchart TD
    E{"MONGODB_URI set?"} -- yes --> A["AtlasStore<br/>new client per request"]
    E -- no --> F{"ALLOW_IN_MEMORY_STORE<br/>is exactly true?"}
    F -- yes --> M["Shared in-memory store<br/>started from the sample seed"]
    F -- no --> X["Refuse: fail closed<br/>JSON 500"]
```
