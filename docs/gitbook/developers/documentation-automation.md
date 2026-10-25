---
title: "Documentation automation"
description: "How OpenAdminOS keeps its documentation current."
---

# Documentation Automation

The documentation at docs.openadminos.com is built from `docs/gitbook` by the website in `web/`. `docs/gitbook/SUMMARY.md` sets the sidebar groups and page order.

Hand-authored pages live directly under `docs/gitbook`. Generated pages live under `docs/gitbook/generated` and should not be edited manually.

The website build only sees the `web/` folder, so the generator also copies every page listed in `SUMMARY.md` into `web/content/docs`, together with a `manifest.json` of page URLs and redirects for older URLs. Edit `docs/gitbook`, not the copy.

## Commands

```sh
npm run docs:generate
npm run docs:check
```

`docs:generate` refreshes `agents/index.json`, rebuilds the summary, regenerates agent/reference pages from manifests, and refreshes the copy in `web/content/docs`.

`docs:check` runs the generator and fails if the checked-in docs or the copy are stale.

## GitHub Action

The documentation workflow runs on commits to `main` that touch app, package, agent, docs, or workflow files. If generated docs change, the workflow opens a pull request instead of pushing directly to `main`.

That keeps the docs self-updating while preserving human review.
