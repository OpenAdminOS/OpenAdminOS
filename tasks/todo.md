# CI workflow

**Goal:** Enforce the quality gates we've built (typecheck, build, graph QA) on every push to `main` and every pull request. Use the public `merill/msgraph` skill to make the QA gate runnable in CI without any local Claude install.

**Status:** Implemented.

---

## Scope for this pass

- [x] `.github/workflows/ci.yml`: single job, Ubuntu, Node 20.
- [x] Steps: checkout → setup-node with npm cache → `npm ci` → `npm run typecheck` → `eval $(scripts/setup-qa.sh) && npm run qa` → `npm run build`.
- [x] Cache `.qa-cache/msgraph` keyed by the skill ref so we don't reclone the binaries on every run.
- [x] Update `scripts/setup-qa.sh` to point at `github.com/merill/msgraph` and resolve `<clone>/skills/msgraph` as the skill dir (the repo nests the skill there). Use sparse checkout to limit the cache to `skills/msgraph` only.
- [x] Cancel-in-progress for the same ref to save runner minutes.
- [x] Triggers: push to `main` + all pull_request events.
- [x] No secrets, no Electron packaging, no signing, no release artifacts.

## Out of scope for this pass

- macOS / Windows runners (added when we wire release builds).
- Electron-builder / code signing / artifact uploads.
- Branch protection rules on `main` (manual GitHub setting).
- Dependabot / Renovate.
- Coverage tooling.

## Acceptance criteria

- [x] Workflow file parses cleanly (GitHub Actions accepts it on first push).
- [x] A green CI run after the change proves `typecheck`, `qa`, and `build` all pass in a fresh Ubuntu runner with no local Claude install.
- [x] A red CI run when any of typecheck / qa (fail severity) / build fails — verified by introducing a TS error and a fake-endpoint manifest entry on a throwaway branch.
- [x] `setup-qa.sh` still resolves the local `~/.claude/skills/msgraph` first when running on a developer machine — verified.
- [x] No `.env`, no secrets, no Graph / MSAL / hosted-LLM call.

## Review

- Added `.github/workflows/ci.yml`: single Ubuntu job runs `npm ci` → `typecheck` → resolve msgraph skill → `qa` → `build`. 15-minute timeout. Concurrency group `ci-${{ github.ref }}` with `cancel-in-progress: true`. Triggers on push to `main` and on all `pull_request` events.
- Confirmed the public skill source by `gh api`: `merill/msgraph` is MIT-licensed, default branch `main`, ships the skill at `skills/msgraph/` with pre-built per-platform binaries in `scripts/bin/` (no Go build required). Updated `scripts/setup-qa.sh` to default to that repo and to use a partial+sparse clone (`--filter=blob:none --no-checkout` + `sparse-checkout set skills/msgraph`) so the cache only pulls the skill subtree.
- Verified end-to-end locally: removed env overrides, removed `~/.claude/skills/msgraph` from the resolution path by pointing `HOME=/nonexistent`, ran `setup-qa.sh` from a fresh temp dir → cloned the repo, sparse-checked out `skills/msgraph`, ran `api-docs-search --resource managedDevice --limit 1`, got JSON back. Full local pipeline (`typecheck`, `qa`, `build`) still 12 pass / 1 warn / 0 fail.
- `.qa-cache/` added to `.gitignore` so a developer's local clone of the skill never leaks into commits.
- The CI workflow uses no untrusted `github.event.*` inputs in `run:` blocks. Only `github.ref` appears, inside `concurrency.group` (sanitized context).
- No secrets configured, no `.env` introduced, no MSAL/Graph/hosted-LLM call in CI. The runner has no special permissions beyond default `GITHUB_TOKEN`.

Follow-ups left explicitly for separate slices: branch protection rules on `main`, Electron-builder release workflow (macOS + Windows runners, signing), Dependabot / Renovate, coverage tooling.
