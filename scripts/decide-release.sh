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
      printf '%s\n' channel=stable create_tag=true >> "$GITHUB_OUTPUT"
      exit 0
    fi
    echo "::notice::Stable $version is waiting for approval: set the STABLE_RELEASE_APPROVED repository variable to $version"
  else
    # Load a tag that arrived after checkout for both recovery and the nightly baseline.
    git fetch origin "$ref:$ref"
  fi
fi

if [ "${STABLE_RELEASE_APPROVED:-}" = "$version" ] &&
   git show-ref --verify --quiet "$ref" &&
   [ "$(git rev-parse "$ref^{commit}")" = "$(git rev-parse HEAD)" ]; then
  # A draft may be left behind by an interrupted upload. Only a published
  # release blocks recovery. Let API failures stop the decision.
  published_release="$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"v$version\" and .draft == false) | .id")"
  if [ -z "$published_release" ]; then
    echo "::notice::Retrying the approved stable release for existing tag v$version."
    printf '%s\n' channel=stable create_tag=false >> "$GITHUB_OUTPUT"
    exit 0
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
