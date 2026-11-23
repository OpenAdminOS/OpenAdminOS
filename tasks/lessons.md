# Lessons

Patterns learned from corrections during this project. Reviewed at the start of each session. Each lesson should describe the mistake, the rule that prevents it, and the context that makes the rule load-bearing.

Format:

```
## Lesson title

**Pattern:** What the mistake or correct approach is, in one sentence.

**Why:** The reason — usually a specific incident or stated preference.

**How to apply:** When and where this rule kicks in.
```

---

## JSON Schema in `schemas/` is a separate source of truth — update it whenever the manifest shape changes

**Pattern:** When extending the agent-template manifest shape (new `descriptor` field, new skill `format`, new step settings), update `schemas/agent-template.schema.json` in the same commit as the runtime / SDK change. The TypeScript types and the JSON Schema are independent — strict typechecks pass even when the schema is wrong.

**Why:** v0.1.5 work shipped `format: connector` skills and `descriptor.connectors` end-to-end. The runtime parsed and ran them fine, but CI's qa-graph gate (which validates every `agents/<slug>/manifest.yaml` against the schema) rejected `tenant-health-report` with 28 issues — unknown property `connectors`, unknown skill format `connector`. Required a follow-up commit ([bd3435d](https://github.com/OpenAdminOS/OpenAdminOS/commit/bd3435d)) and a CI reroll.

**How to apply:** Before committing any change that touches `packages/agent-sdk/src/index.ts` template types, `packages/runtime/src/agent-template.ts` parsing, or any `agents/<slug>/manifest.yaml` that uses a new shape — run `npm run qa` locally first. The qa-graph gate validates the same way CI does. It's also worth adding a row to `stats/agents.json` for any new bundled agent at the same time, since the same gate warns when coverage is missing.

---

## Read the user's name from the system context, not from email prefixes

**Pattern:** When you need to refer to the user by name (signing emails, drafting copy, attributing actions), look at unambiguous signals first: the home directory path (`/Users/<name>/`), explicit corrections, the GitHub login, prior commits authored by them. Don't infer from the email-address prefix.

**Why:** During the v0.1.8 launch email draft I signed it "— Uli" because I extrapolated from the email username `ulimuli92@googlemail.com`. The user's actual name is **Ugur** (clearly visible in `/Users/ugurkoc/`, the `ugurkocde` GitHub login, and every prior commit's author). The test email went out with the wrong sign-off; the user caught it.

**How to apply:** Before putting a name into any user-visible artifact (emails, READMEs, commit co-authorship, social copy), do a 5-second cross-check against `pwd`, `git config user.name`, `gh api user --jq .login`, or recent `git log --format='%an %ae'`. If any of those disagree with the email prefix, the path/git/gh signal wins.

---

## Mockups for new product surfaces must be designed, not wireframed

**Pattern:** When asked for a mockup of a new user-facing surface (marketplace, store, showcase pages), deliver a finished visual design with a clear point of view: distinctive imagery, strong type hierarchy, and real visual polish. A grid of uniform text cards with filter controls is a wireframe, not a mockup.

**Why:** The first marketplace mockup (`docs/mockups/25-marketplace.html`, 2026-11-03) was a plain card grid with dropdowns and a placement toggle. The user rejected it as bad UI and asked for something eye-catching. They also wanted Marketplace as its own sidebar item, not a tab inside Agents.

**How to apply:** Before building, load the `frontend-design` skill and write a short design plan (palette, type, layout, the one memorable element). Keep the restrained brand for the app chrome, and let the content carry the visual weight (cover art, large serif headings). Check the result in a browser at desktop and narrow widths before showing it. Treat open product questions as questions for the user, not as toggles inside the mockup.

---

## Read vendor plan and pricing tables from the source, not from a page summary

**Pattern:** When copy states which plan, tier or price includes a feature, verify the table from the page's source (for GitHub docs, `gh api repos/github/docs/contents/<path>`) or a rendered screenshot, never from a WebFetch summary alone.

**Why:** For PR #205 two WebFetch summaries of docs.github.com said Fusion Max was not included in Copilot Pro+. The github/docs source shows Pro+ includes it. The wrong plan names shipped in the unavailable-tier reason and the docs until a reviewer (Muse, round 2) checked the source; a Pro user would have been told to buy a larger plan than needed.

**How to apply:** Any user-facing sentence naming plans, tiers, prices or regions gets a source-level check, and a test that asserts the exact sentence.

---

## Never load a local model on the maintainer's Mac, even for a live check

**Pattern:** Live checks of the app use a hosted provider (Claude Code or Codex CLI). A local model and its context window are mocked in tests; nothing sends a request to Ollama's `/api/chat` or `/api/generate`, runs `ollama run`, or points the app at a local model.

**Why:** During the model fit work (PR #213, 2026-11-19) I probed Ollama with a chat request and then ran the dev app against a small-context copy of OpenAdmin 8B to trigger a real overflow. Loading the model made the machine unusable, and the maintainer had already asked for hosted-only live checks.

**How to apply:** Before any live check, confirm the app profile has a hosted provider active and no local one that could answer or embed. To show a local-model failure state, inject it in tests, not on the machine. Check `ollama ps` afterwards and run `ollama stop <model>` if anything is loaded. Pass this rule to every reviewer or implementer subagent.

## Never load a local model on the maintainer's Mac

**Pattern:** Tests and live checks never load a model in Ollama or LM Studio: no `ollama run`, no requests to `/api/chat` or `/api/generate` on localhost:11434. Tests use scripted mock models, and tokenizer or model metadata work uses recorded counts or mocked `/api/show` and `/api/tags`. Live app checks use a hosted provider (Claude Code or Codex CLI), and end-to-end profiles are seeded with a hosted provider or none, never a local provider that could answer or embed.

**Why:** Loading a local model makes the machine unusable. On 2026-11-19 the prompt size estimator was calibrated by sending synthetic prompts to OpenAdmin 8B and gpt-oss 20B through the local Ollama, and the maintainer forbade it during the local model accuracy work for the 8B demos. The PR #212 end-to-end check also launched a dev build whose seeded profile had Ollama active.

**How to apply:** Before an end-to-end or smoke run, confirm its provider is a mock or a hosted CLI. Run `ollama ps` afterwards (it reads status and loads nothing); if a model is listed, run `ollama stop <model>` at once. Name the provider and model used in every hand-back, and pass this rule to every delegated child and reviewer.

---

## Do not edit a worktree while a reviewer is reading it

**Pattern:** While a delegated reviewer reviews a commit in the shared worktree, keep the tree at that commit: write fixes for findings from other reviewers into a patch outside the tree (or wait), and apply them after every reviewer of the round has reported.

**Why:** In PR #212 I edited files during Muse's rounds 8, 10 and 15 although the brief promised an untouched tree; Muse saw mixed states, one test run failed on a half-applied change, and its results had to be qualified.

**How to apply:** After starting a review round, do not touch tracked files until all reviewers of that round report. If a finding arrives early, save the fix with `git diff > <scratchpad>/patch` and `git checkout -- .`, or prepare it only in notes. Before the first edit after any reviewer reports, list which reviewers of the round are still running and edit only when none is; it slipped again in round 26 when one report arrived and the fix felt ready.
