# Engineering Principles

These rules apply to every change in this repository, whether a person or a coding assistant writes it.

## 1. Every function, class and test has a meaningful docstring
- Every new or modified function, method, class, nested helper and test gets a docstring.
- The docstring says what it does, why it exists, and anything surprising, such as side effects, failure behaviour or limits. Restating the name is not enough.
- A missing docstring is a review failure, not a style nit.

## 2. Changes are test-backed
- Every behaviour change ships with a test that fails without the change and passes with it.
- Bug fixes include a test that reproduces the bug.
- Tests run in CI on every pull request. Nothing merges with a red check.

## 3. Fail closed
- When something is missing, invalid, unapproved or unknown, the system refuses and says why. It never guesses or carries on.
- Missing config, a missing key or a failed check stops the action. It never falls back to a permissive default.
- Errors are visible to the user and recorded. They are never swallowed.

## 4. Bounded execution
- Every loop, retry, external call and background job has an explicit limit: a timeout, a maximum retry count, or a size cap.
- No unbounded queues, recursion or polling.
- Long-running work can be cancelled and reports its state.

## 5. Explicit authority
- Actions that change data, cost money or reach outside the system need an explicit approval. They don't proceed on an implied or assumed one.
- An approval covers exactly the action it names, once. If an approved action never actually started, it asks again instead of running later.
- Every approved or refused action is recorded with who decided and when.

## 6. Plain, human-readable names
- Names say what a thing does in everyday words: `approve`, `record`, `remember`, `forget`, `tool`.
- No internal code names, jargon or acronyms that a new reader would have to look up.
- User-facing messages are written in plain sentences.

## 7. Small, reviewable changes
- One change per branch and pull request, about 1,000 lines or less.
- Each pull request says what changed, why, and how it was tested.

## 8. No secrets in the repository
- Keys, tokens and passwords come from environment variables or the host's secret store. They never go in code, tests, fixtures, logs or commit history.
- `.env` files are git-ignored. An example file lists variable names only.
- Anything that costs money stays off unless it's explicitly enabled.
