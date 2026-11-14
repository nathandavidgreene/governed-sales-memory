# AGENTS.md: Rules for coding assistants

This file is the rulebook for every coding assistant working in this repository. Read it before every task. If anything here conflicts with a prompt, this file wins. Ask Flint if you're unsure.

Also follow [ENGINEERING-PRINCIPLES.md](ENGINEERING-PRINCIPLES.md).

## Who's who
- **Nathan** owns the project and approves every merge.
- **Flint** is the repo manager. Flint reviews every pull request, does the merge after Nathan approves, and is your contact when you're blocked.
- **Chet** is Nathan's coding assistant (Muse Code). Chet's work counts as Nathan's, and Chet is not a team member. Chet follows every rule here, including review before merge.
- **Greg** is Mike's coding assistant and works alongside Mike.

## Event rules
These come from the event and break the submission if ignored:
- **No pre-existing code.** Everything here is written after hacking starts at 10:45. The only exception is official MongoDB templates and starters. The demo must clearly show what was built during the event, or the team is disqualified.
- **Build on the event's MongoDB Atlas sandbox.** Use only the event-provided Atlas project and cluster. A project on any other Atlas account can't be judged in the final.
- **No Streamlit.**
- **No dashboard as the main feature.** A UI can show what's happening, but the core of the project is the agent and its memory.
- **Submissions are due at 5:00 PM ET.** Code freeze is at 3:15 PM.

## What we're building
Problem Statement 2, **Memory You Can Govern**: who can read each memory, how long it lives, and how it's corrected or forgotten. Every feature should help answer the two judging questions:
1. How do we keep one client's memory from leaking into another's?
2. How do we prove memory changed the agent's behaviour, rather than just filling the prompt?

## Stack and commands
- **Runtime:** Cloudflare Workers, connecting directly to MongoDB Atlas. This setup has been tested end to end.
- **Database:** MongoDB Atlas (the event sandbox only), using the official `mongodb` Node.js driver.
- **Worker setup:**
  - Enable `nodejs_compat` in the Wrangler config.
  - Create a new `MongoClient` per request and close it when the request finishes. Don't share a client across requests.
  - Expect roughly 0.8 s for a cold request and 0.5 s for a warm one, and keep queries lean.
- **Database user:**
  - Use one app user, created fresh, with `readWrite` on the app's own database only.
  - Store its connection string as a Worker secret (`wrangler secret put MONGODB_URI`), never in code or config files.
  - If you ever run `atlas dbusers update`, always pass `--role`. A password-only update wipes the user's roles: logins still succeed, but every query fails.
- **Indexes:**
  - Keep index definitions, including the Vector Search index JSON, in the repo.
  - Create indexes early, since vector index builds take time.
  - Use unique indexes to enforce no-duplicate rules in the database, not only in code.
- **Language:** TODO after 10:45 (TypeScript or JavaScript, once the skeleton exists)

Commands, to be filled in once the skeleton exists after 10:45:
```sh
# install
TODO
# run locally
TODO
# test
TODO
# lint
TODO
```
Run test and lint before every push.

## 1. Work only on what you're assigned
- Work from the [team roadmap](https://hackathon-roadmap.nathandavidgreene.workers.dev). It's sign-in only, for team members. If you can't open it, ask Flint.
- Take only the items assigned to you there.
- If you think something is missing or should change, tell Flint. Don't start unassigned work.
- Do one roadmap item per branch and one branch per pull request.
- Name branches `<your-name>/<short-item-name>`, for example `nathan/onboarding-seed`.

## 2. Never push to main
- `main` is protected, and every change goes through a pull request.
- Never force push, rebase shared branches or rewrite history.
- Don't merge your own pull request or anyone else's. Flint merges after Nathan approves.

## 3. Pull request requirements
Every pull request must:
- Use the PR template: what changed, why, which roadmap item, how it was tested, and screenshots for UI changes.
- Be small, about 1,000 lines or less. Split anything bigger.
- Include tests for every behaviour change, and docstrings on every new or changed function, class and test.
- Pass lint and all tests locally before you open it, and pass CI after.
- Nothing merges red. If CI fails, fix it on your branch.
- Stay current with `main`. Merge `main` into your branch if it falls behind; don't rebase.

Flint aims to review within about 10 minutes. Respond to review comments on the same branch.

## 4. No secrets, ever
- Never put keys, tokens, passwords, personal data or real customer data in code, tests, fixtures, logs, screenshots or commits.
- Read secrets from environment variables only. Add new variable names (never values) to `.env.example`.
- If you accidentally commit a secret, stop and tell Flint right away. Don't try to fix the history yourself.

## 5. Generic vocabulary only
- Use plain, generic names for interfaces and concepts: `approve`, `record`, `remember`, `forget`, `tool`.
- No internal project code names in code, comments, docs or commit messages.
- Sample prices and data must be clearly labelled as samples.
- **A CI check blocks internal project names.** It fails the build if any tracked file contains a term from a private blocklist. The check is case-insensitive and covers code, docs and file names. The list lives in a repository Actions variable, not in any file, so the repo never contains those words. If the check fails, rename the offending term to a plain generic one. Commit messages and PR text must stay clean too; Flint checks those in review.

## 6. Timeline and freeze
- Hacking starts at 10:45. Nothing written before then goes in this repo.
- **5:00 PM ET is the submission deadline. 3:15 PM is code freeze.** After 3:15, only fixes that Flint approves and that are needed for the demo get merged.
- If your item won't make the freeze, tell Flint by 2:45 so it can be cut or reassigned.

## 7. When you're blocked
Reach Flint in one of two places, and only these:
- **A comment on your pull request**, for anything about that PR.
- **The pinned GitHub issue titled "Blockers"**, for anything else. Add a comment there. Flint watches it all day.

Escalate to Flint as soon as you're blocked for more than about 10 minutes, or right away if:
- a test or CI failure isn't caused by your change,
- you need a secret, permission or decision,
- your item depends on someone else's unmerged work, or
- the assignment is unclear.

When you escalate, say what you were doing, what failed (with the exact error), and what you need.
