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
