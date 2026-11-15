# Governed Sales Memory

A sales assistant whose memory is governed. Each salesperson talks to a
model-driven agent that can read and change **only that salesperson's own**
accounts and memories, and every change it makes is recorded. Anything that
would leave the system needs a human to approve it first.

It runs as a single Cloudflare Worker backed by MongoDB Atlas, with Atlas
Vector Search and Voyage embeddings for meaning-based recall. All data in it
is sample data.

## What it does

- **Owner-scoped memory.** Every memory and account belongs to exactly one
  salesperson. A read, correction, or deletion of someone else's item gets one
  generic `not found` refusal. That refusal is identical to the one for an item
  that doesn't exist, so outsiders can't learn what exists. The attempt is
  written to the change log as a `refuse` entry.
- **A dynamic agent, not a script.** `POST /session` opens an empty session,
  and `POST /chat` runs the model in a tool-calling loop over seven governed
  tools. There are no scripted replies: without a model the turn fails closed
  with `model unavailable`.
- **Correct and forget.** A correction keeps the previous value in the item's
  own history. Forgetting replaces the content with a tombstone.
- **Human approval.** The agent can only *propose* a change. Approving is the
  page's Approve button (`POST /approve/:id`), never a tool. An approval is
  handed to the outbox, a stand-in for a CRM, before it's marked decided.
- **A tamper-evident change log.** Every governed action appends an entry to
  an append-only, SHA-256 hash-chained log.
- **Meaning-based search with a fallback.** Memories are embedded with Voyage
  when they're written. Search uses Atlas Vector Search and falls back to a
  keyword search when embedding fails or finds nothing.

See [Architecture](architecture.md) for diagrams of each flow, and the
[API reference](api/index.md) for every module, generated from the docstrings.

## Routes at a glance

| Method and path | What it does |
| --- | --- |
| `GET /` | The app page: chat, approval card, change log, and outbox |
| `GET /health` | Reports that the Worker is up |
| `POST /session?as=<id>` | Opens an empty session for a known salesperson |
| `GET /session/:id?as=<id>` | Reads a session back (owner only) |
| `POST /session/:id/close?as=<id>` and `/resume` | Closes or resumes a session (owner only) |
| `POST /chat?as=<id>` | Runs one message through the agent and its tools |
| `POST /approve/:id?as=<id>` | Approves a pending proposal (owner only) |
| `GET /search?as=<id>&q=<query>` | Read-only, owner-scoped memory search |
| `POST /memory?as=<id>` and `GET /memory/:id?as=<id>` | Stores or recalls one memory item |
| `GET /change-log?as=<id>` | The requester's change log entries, plus system entries |
| `GET /outbox?as=<id>` | The requester's own outbox entries |

The caller's identity comes only from the `?as=` query parameter, never from
the request body.

## Working on the docs

The API pages are generated from the JSDoc docstrings in `src/` and `scripts/`
by `scripts/gen-api-docs.mjs`, into `docs/api/` (gitignored). To build the site:

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-docs.txt
PATH="$PWD/.venv/bin:$PATH" npm run docs:build   # writes site/ (gitignored)
PATH="$PWD/.venv/bin:$PATH" npm run docs:serve   # live preview
```

`npm run docs:deploy` builds the site and deploys `site/` as the static-assets
Worker described in `docs/wrangler.docs.jsonc`.
