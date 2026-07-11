#!/usr/bin/env bash
# One-shot: initialize git here and push to GitHub.
# Run locally:  bash init-git.sh
set -euo pipefail

cd "$(dirname "$0")"

REMOTE="https://github.com/long-vo/meso.utilities.git"

# A previous sandbox run may have left a partial .git that couldn't be cleaned.
if [ -d .git ]; then
  echo "Removing existing .git ..."
  rm -rf .git
fi

git init -b main
git config user.name "Long Vo"
git config user.email "long.vo@mesoneer.io"
git config core.hooksPath .githooks  # pre-commit: fmt --check, type check, lint, tests
git remote add origin "$REMOTE"

git add -A
git commit -F - <<'MSG'
Add sanitize-text Deno web app

Port the Slack /sanitize-text command to a Deno Deploy-ready website: a shared
masking module used by both server and browser, a Deno.serve entrypoint with a
JSON API and static hosting, an interactive single-page UI, and parity tests.
MSG

git push -u origin main
echo "Done — pushed to $REMOTE"
