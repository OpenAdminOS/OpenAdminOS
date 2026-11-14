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

## Quote a project rule instead of citing it by number

**Pattern:** When a recommendation depends on a project rule, quote the rule and say where it lives. Do not write "hard constraint 1" or "§8b" as if the reader has the numbering in their head.

**Why:** On 2026-11-13, while assessing hosted runs, I told the maintainer the idea needed "a second exception to hard constraint 1". They replied that they did not understand and asked which constraint I meant, which cost a round trip on a decision that was theirs to make.

**How to apply:** In any summary, question or decision list for the maintainer, state the rule in one sentence with a file link the first time it appears, then refer to it by what it says.

---

## Social images: product UI first, few words, no "concept" or "mockup" labels

**Pattern:** For a LinkedIn or other social image, lead with large product UI, keep copy to a headline and one line, and never label it a concept or a mockup. Keep the examples about agents doing work in general, not one vendor or one admin task.

**Why:** On 2026-11-13 the first hosted-runs image was a diagram with a log and three fact columns, tagged "Concept, in design". The maintainer asked for less text, more UI, no concept or mockup wording, and an image that builds anticipation by itself. The second version used a retire-devices example and Intune wording; they asked to drop that example and not to focus on Intune or Microsoft.

**How to apply:** Build social images as layered UI fragments at a type size readable in a feed, under one headline. Use a status such as "Coming soon" for unreleased work so nothing claims it has shipped. Check every claim on the image against decisions actually made.
