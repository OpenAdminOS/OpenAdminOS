#!/usr/bin/env bash
# Select the release channel for the current green main checkout.
set -euo pipefail

version="$(node -p "require('./package.json').version")"
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "::error::package.json contains an invalid stable release version: $version" >&2
  exit 1
fi
echo "version=$version" >> "$GITHUB_OUTPUT"

ref="refs/tags/v$version"
if ! git show-ref --verify --quiet "$ref"; then
  # Recheck origin in case the tag was pushed after checkout. A failed lookup
  # must stop the decision rather than treating the tag as missing.
  remote_tag="$(git ls-remote --refs --tags origin "$ref")"
  if [ -z "$remote_tag" ]; then
    if [ "${STABLE_RELEASE_APPROVED:-}" = "$version" ]; then
      echo "channel=stable" >> "$GITHUB_OUTPUT"
      exit 0
    fi
    echo "::notice::Stable $version is waiting for approval: set the STABLE_RELEASE_APPROVED repository variable to $version"
  fi
fi

changed="$(bash scripts/nightly-app-changes.sh HEAD)"
if [ -z "$changed" ]; then
  echo "::notice::No app changes since the newest v* tag; skipping the nightly build."
  echo "channel=none" >> "$GITHUB_OUTPUT"
  exit 0
fi

# sed consumes all input under pipefail, even when more than 50 paths changed.
echo "App changes:"
printf '%s\n' "$changed" | sed -n '1,50p'
echo "channel=nightly" >> "$GITHUB_OUTPUT"
