#!/usr/bin/env bash
# Fail if any tracked file's contents or path contains a blocked term.
# Terms come from the BLOCKED_TERMS env var (comma-separated), set from a
# repository Actions variable so the terms never appear in the repo itself.
# Fails closed: a missing or empty list is an error.
set -euo pipefail
if [[ -z "${BLOCKED_TERMS:-}" ]]; then
  echo "BLOCKED_TERMS is not set; refusing to pass." >&2
  exit 1
fi
pattern=$(printf '%s' "$BLOCKED_TERMS" | tr -d ' ' | sed 's/,/|/g')
fail=0
if git ls-files | grep -Eiq "$pattern"; then
  echo "Blocked term found in a file path:" >&2
  git ls-files | grep -Ei "$pattern" >&2
  fail=1
fi
if git grep -IEil "$pattern" -- . >/dev/null 2>&1; then
  echo "Blocked term found in these files:" >&2
  git grep -IEil "$pattern" -- . >&2
  fail=1
fi
[[ $fail -eq 0 ]] && echo "Name check passed."
exit $fail
