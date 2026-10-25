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

# A release already contains this commit when a v* tag sits on it or on a
# descendant. That happens when a newer nightly published first (GitHub does
# not order dispatched runs) or when a superseded run is re-run. Building it
# then would ship older code under a newer nightly version.
containing="$(git tag --contains "$commit" --list 'v[0-9]*' | head -n 1 || true)"
if [ -n "$containing" ]; then
  echo "$containing already contains $commit." >&2
  exit 0
fi

base="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$commit" 2>/dev/null || true)"
if [ -z "$base" ]; then
  echo "No v* tag is reachable from $commit." >&2
  exit 0
fi
echo "Comparing with $base." >&2

# Paths that never change the installed app. Everything else, including
# agents/, packages/, apps/ and build scripts, does. The scripts listed here
# are contributor tooling (docs generation, screenshot capture, smoke tests,
# QA setup, script tests); a new script counts until it is added here.
changed="$(git diff --name-only "$base" "$commit" -- . \
  ':(exclude)stats' \
  ':(exclude)web' \
  ':(exclude)docs' \
  ':(exclude)tasks' \
  ':(exclude)model' \
  ':(exclude)remotion' \
  ':(exclude).github' \
  ':(exclude,glob)*.md' \
  ':(exclude)scripts/*.test.mjs' \
  ':(exclude)scripts/capture-screenshots.mjs' \
  ':(exclude)scripts/docs-site-routes.mjs' \
  ':(exclude)scripts/generate-gitbook-docs.mjs' \
  ':(exclude)scripts/publish-docs-index.mjs' \
  ':(exclude)scripts/render-office-rehearsal.mjs' \
  ':(exclude)scripts/setup-qa.sh' \
  ':(exclude)scripts/smoke-*.mjs' \
  ':(exclude)scripts/verify-nova-command-routing.ts')"

# The root package.json also holds contributor npm scripts. It counts only
# when something outside those changed: the build scripts below, the
# version, workspaces, or engines.
app_manifest() {
  git show "$1:package.json" 2>/dev/null | node -e '
    const manifest = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const build = new Set(["build", "dist:desktop"]);
    manifest.scripts = Object.fromEntries(
      Object.entries(manifest.scripts ?? {}).filter(([name]) => build.has(name)),
    );
    process.stdout.write(JSON.stringify(manifest));
  '
}
if printf '%s\n' "$changed" | grep -qx 'package.json' &&
  [ "$(app_manifest "$base")" = "$(app_manifest "$commit")" ]; then
  changed="$(printf '%s\n' "$changed" | grep -vx 'package.json' || true)"
fi

# .gitattributes can change checked-out bytes (line endings of agent
# manifests). Lines that only set linguist-* attributes change how GitHub
# displays files, not what ships.
app_attributes() {
  git show "$1:.gitattributes" 2>/dev/null |
    grep -vE '^[[:space:]]*(#|$)' |
    grep -vE '^[^[:space:]]+([[:space:]]+-?linguist-[^[:space:]]*)+[[:space:]]*$' || true
}
if printf '%s\n' "$changed" | grep -qx '.gitattributes' &&
  [ "$(app_attributes "$base")" = "$(app_attributes "$commit")" ]; then
  changed="$(printf '%s\n' "$changed" | grep -vx '.gitattributes' || true)"
fi

if [ -n "$changed" ]; then
  printf '%s\n' "$changed"
fi
