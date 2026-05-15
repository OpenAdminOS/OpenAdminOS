#!/usr/bin/env bash
# Resolve the msgraph skill location used by `npm run qa`.
#
# Order of resolution:
#   1. $MSGRAPH_SKILL_DIR if already set and points at a valid skill directory.
#   2. $HOME/.claude/skills/msgraph if present locally.
#   3. Clones github.com/microsoft/msgraph-mcp-skill into .qa-cache/msgraph
#      (override via $OPENAGENTS_QA_SKILL_REPO and $OPENAGENTS_QA_SKILL_REF).
#
# The script prints `MSGRAPH_SKILL_DIR=<resolved-path>` on stdout so a caller
# can `eval $(scripts/setup-qa.sh)` to export the variable.

set -euo pipefail

skill_repo="${OPENAGENTS_QA_SKILL_REPO:-https://github.com/merill/msgraph.git}"
skill_ref="${OPENAGENTS_QA_SKILL_REF:-main}"
clone_dir="$(pwd)/.qa-cache/msgraph"
# The merill/msgraph repo bundles the skill at skills/msgraph inside the clone.
cache_dir="$clone_dir/skills/msgraph"

is_valid() {
  [[ -d "$1" ]] && [[ -d "$1/scripts" ]]
}

resolved=""
if [[ -n "${MSGRAPH_SKILL_DIR:-}" ]] && is_valid "$MSGRAPH_SKILL_DIR"; then
  resolved="$MSGRAPH_SKILL_DIR"
elif is_valid "$HOME/.claude/skills/msgraph"; then
  resolved="$HOME/.claude/skills/msgraph"
elif is_valid "$cache_dir"; then
  resolved="$cache_dir"
else
  echo "msgraph skill not found locally; cloning $skill_repo@$skill_ref into $clone_dir" >&2
  mkdir -p "$(dirname "$clone_dir")"
  # All clone/checkout output is routed to stderr so callers can capture only
  # the final MSGRAPH_SKILL_DIR=... line via `eval $(scripts/setup-qa.sh)`.
  git clone --quiet --depth 1 --branch "$skill_ref" --filter=blob:none --no-checkout "$skill_repo" "$clone_dir" >&2
  (
    cd "$clone_dir"
    git sparse-checkout init --cone >&2
    git sparse-checkout set skills/msgraph >&2
    git checkout --quiet "$skill_ref" >&2
  )
  resolved="$cache_dir"
fi

if ! is_valid "$resolved"; then
  echo "Resolved msgraph skill dir is invalid: $resolved" >&2
  exit 1
fi

echo "MSGRAPH_SKILL_DIR=$resolved"
