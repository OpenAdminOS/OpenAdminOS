---
title: "Documentation automation"
description: "How OpenAdminOS keeps GitBook documentation current."
---

# Documentation Automation

GitBook reads from `docs/gitbook`, configured by the root `.gitbook.yaml` file.

```yaml
root: ./docs/gitbook
```

Hand-authored pages live directly under `docs/gitbook`. Generated pages live under `docs/gitbook/generated` and should not be edited manually.

## Commands

```sh
npm run docs:generate
npm run docs:check
```

`docs:generate` refreshes `agents/index.json`, rebuilds the GitBook summary, and regenerates agent/reference pages from manifests.

`docs:check` runs the generator and fails if the checked-in docs are stale.

## GitHub Action

The documentation workflow runs on commits to `main` that touch app, package, agent, docs, or workflow files. If generated docs change, the workflow opens a pull request instead of pushing directly to `main`.

That keeps the docs self-updating while preserving human review.
