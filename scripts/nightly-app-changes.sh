#!/usr/bin/env bash
# Lists the paths that change the installed app between the newest v* tag
# reachable from a commit (stable or nightly) and that commit:
#
#   bash scripts/nightly-app-changes.sh <commit>
#
# Prints one path per line, nothing when a nightly would ship no app change.
# The baseline goes to stderr. Shared by auto-tag.yml, which decides whether
# to dispatch a nightly, and release.yml, which checks again when the run
# starts, because a nightly queued behind another one may have nothing left
# to build once that one has published its tag.
# Needs a full clone with tags (fetch-depth 0).
set -euo pipefail

commit="${1:?usage: nightly-app-changes.sh <commit>}"
base="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$commit" 2>/dev/null || true)"
if [ -z "$base" ]; then
  echo "No v* tag is reachable from $commit." >&2
  exit 0
fi
echo "Comparing with $base." >&2

# Paths that never change the installed app. Everything else, including
# agents/, packages/, apps/ and build scripts, does.
git diff --name-only "$base" "$commit" -- . \
  ':(exclude)stats' \
  ':(exclude)web' \
  ':(exclude)docs' \
  ':(exclude)tasks' \
  ':(exclude)model' \
  ':(exclude)remotion' \
  ':(exclude).github' \
  ':(exclude,glob)*.md'
