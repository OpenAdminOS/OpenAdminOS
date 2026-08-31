# v0.5 feature review

Reviewed 2026-08-31 against branch `0.5` (commit `b84cdc1`). Method: the real Electron app was launched under the screenshot-capture harness (synthetic Graph, seeded two-tenant fixture) and every route was rendered and captured at 900 / 1100 / 1600 px; the fine-tuned `openadminos/openadmin-8b` model was exercised against the app's actual chat prompts through Ollama; and the code for each feature was read directly.

**Scope note, stated honestly.** Two things could not be exercised:

- **No live tenant.** Every Graph call in this review was served by the harness stub, so findings about *rendering, wiring, state, and copy* are direct observations, while findings about *live Graph behaviour* (throttling, paging at scale, real 403s) are code-reading only and are labelled as such.
- **Codex was unavailable.** `codex exec` hung with zero output across four attempts today (the same intermittent fault seen earlier in the day; CLI 0.151.0, logged in). This review is therefore Claude's, not Codex's. Re-running the Codex pass later would be a useful second opinion, not a repeat of this one.

Severity: **broken** (does not work / violates a stated constraint) · **risk** (works but will fail or mislead under plausible conditions) · **improvement** (works, meaningfully better possible) · **polish** (cosmetic).

---

## Summary of what needs fixing

| # | Severity | Finding | Area |
|---|---|---|---|
| 1 | broken | Fleet table overflows horizontally below ~1180 px | Fleet |
| 2 | risk | The project's own 8B model is routed into agentic mode it cannot drive | Chat / model |
| 3 | risk | Small-model heuristic misses every 7B and 8B model | Chat / model |
| 4 | improvement | Native `<select>` elements break the design system in 4 places | Fleet, Settings, Changes |
| 5 | improvement | Agent detail stacks a warning card per unconfigured connector | Agents |
| 6 | improvement | Large vertical dead space on Fleet, Gateway, and other short pages | Layout |
| 7 | polish | Fleet nav badge repeats the tenant count with no label | Fleet |

Nothing found violates the four hard constraints. Write confirmation, tenant scoping, local-first handling, and designed error states all held everywhere they were checked.

---

## 1. First-run setup and tenant connect

**Works.** A zero-tenant launch opens the setup dialog unprompted; permissions are grouped with per-scope rationales; sign-in cancels cleanly; the flow continues into provider selection when no provider is connected. The new app-registration choice renders as designed: the OpenAdminOS registration is the default, with "Connect with your own app registration" directly beneath it collecting only a client ID and optional directory ID.

**Verified by test, not just eye:** the dialog never renders a client-secret field (`SetupFlowContext.test.tsx`), which is the security-relevant property.

- **[risk] Tenants connected before v0.5 cannot refresh tokens after the client-ID change.** Where: `state.ts` `msalClientForTenant`. Tokens are bound to the issuing client ID, and existing tenant records have no `appRegistration`, so they fall back to the new default client and silent refresh will fail. The code pins registrations correctly *going forward*, but there is no designed "reconnect required" state for the pre-existing records. Why it matters: every existing 0.4.3 install hits this on upgrade. Fix: detect the missing `appRegistration` on a refresh failure and route to the existing reconnect UI with copy explaining the app-identity change. This is the migration item already flagged in the plan; it is not yet implemented.

## 2. Chat

**Works.** Single-tenant and multi-tenant chat, tool tracing, streaming, conversation lifecycle (rename/pin/delete), source disclosure, workspace pinning, and hosted-provider consent all render and behave correctly under the harness. The smoke test asserts 19 distinct behaviours and passes.

- **[risk] The flagship OpenAdmin 8B model is routed into investigative mode it cannot drive.** Where: `service.ts` `modelSuggestsSmallLocalModel`. Evidence: asked for the app's tool-call JSON, `openadminos/openadmin-8b` returned `{"tool":"query_managedDevices","params":{"filter":...,"select":...},"limit":10`: an invented tool name (the real set is `list_cached_resources`, `query_cache`, `graph_get`, `query_drift`), invented parameters, and malformed JSON (unclosed brace). The app recovers via one repair attempt then the deterministic fallback, so it degrades rather than crashes, but every such question burns a wasted round trip and shows a fallback notice. Fix: either add the OpenAdmin family to the deterministic list until the tool protocol is trained in, or (better) treat repeated JSON-protocol failure for a given model as a sticky signal and stop retrying agentic mode for it.
- **[risk] The small-model heuristic misses the entire 7B/8B class.** Where: `service.ts`, regex `(?:^|[^0-9])([1-6](?:\.\d+)?)\s*b`. Verified: `llama3.1:8b`, `qwen2.5:7b`, and `openadminos/openadmin-8b` all return `false` and are therefore treated as agentic-capable. Why it matters: 7B/8B is the most common local-model size on admin laptops, so the most likely local setup is also the one most likely to fall back. Fix: raise the bound, and stop inferring capability from the name alone.

**What the model is good at.** Worth recording, because it is the trained behaviour and it works: given cached device rows it answered correctly and concisely ("1 of 2 devices are noncompliant: WIN-01"), and with no context it abstained cleanly in two separate cases rather than inventing tenant state. Abstention is the property the trust story depends on, and it held.

## 3. Agents (list, hub, detail, run, schedules)

**Works.** All 14 shipped manifests parse; every one invokes the LLM at least once (`stale-guest-cleanup` does so inside a `map` step, which a flat scan misreads as missing: it is correct). Both write agents (`offboarding-agent`, `stale-guest-cleanup`) declare a typed `confirmationPhrase` and `severity: destructive`. Agent detail renders scopes, pipeline, configurable settings, schedule, and delivery.

- **[improvement] The delivery rail stacks one warning card per unconfigured connector.** Where: agent detail right rail. On a fresh install the page shows a "Connect and test X before enabling delivery" banner for Teams, WhatsApp, and each remaining connector, which is repetitive noise dominating the rail. Fix: collapse unconfigured connectors into a single "Set up run delivery" entry point and only expand configured ones.

## 4. Agent builder

Reviewed by code only; the guided draft flow could not be exercised end-to-end without a working agentic model. Validation, one LLM repair pass, and the disabled-until-revalidated save gate are present as specified. **Recommend re-testing this specifically once finding 2 is resolved**, since the builder depends on exactly the JSON-emission behaviour the 8B model currently fails.

## 5. Changes: drift, baselines, compare, rollback

**Works.** Timeline, Baselines, and Compare segments render; baseline create/rename/retire and the rollback pre-flight are wired; rollback plans route through the standard typed confirmation. Engine correctness is covered by unit tests including adversarial cases (pruning must not delete baseline-pinned versions; apply must stop at first failure and never fire later requests).

- **[improvement] Rollback is whole-drift only.** The engine already accepts a `selections` subset, but the UI cannot express it, so an admin who wants to revert one policy must revert everything or nothing. Fix: per-entry checkboxes feeding the existing `selections` parameter.

## 6. Fleet

- **[broken] Horizontal overflow below roughly 1180 px.** Where: `apps/desktop/src/pages/Fleet.tsx:265`, `className="w-full min-w-[900px]"` on the table. Measured by the capture harness: `1080px > 900px` at a 900 px viewport. The 900 px table minimum plus the ~240 px sidebar and page padding cannot fit, so the whole page scrolls sideways. Every other route passes the same check. Why it matters: 900 px is a supported width (the harness enforces it for all other screens) and side-scrolling a status table is the exact opposite of an at-a-glance fleet view. Fix: drop `min-w-[900px]`, let columns truncate (tenant name already truncates), or wrap the table in its own horizontally scrollable container so the page itself never scrolls.
- **[polish] The nav badge shows a bare tenant count.** "Fleet 2" reads as "2 alerts" at a glance. Consider showing the count of tenants *with drift* instead, which is the number an MSP actually watches, or dropping the badge.

## 7. MCP gateway

**Works.** Settings → Gateway renders the off state, tenant binding, optional port, and honest trust copy ("Reads are scoped to the selected tenant. Every write is only a proposal that requires typed confirmation in this app."). Proposal-only writes, catalog validation of proposed endpoints, and loopback-only binding are covered by tests.

- Not exercised live: no external MCP client was paired against a running gateway in this review. The unit tests cover plan construction and the confirmation gate, but an end-to-end pairing test with a real client is still owed before release.

## 8. Retrieval

Engine correct and tested (cosine ranking, provenance, dimension-mismatch rejection, loopback-only enforcement). The Settings panel shows the honest "Not documentation-grounded yet" state.

- **[risk] The feature is inert in practice.** No index ships and no downloader exists, so every install shows the not-grounded state. This is the documented plan, but it means the measured 129→162 improvement is not available to any user yet. It is the largest gap between what v0.5 claims and what it delivers.

## 9. Telemetry

**Works, and is honest.** Off by default; the Privacy panel shows the exact payload; tests assert zero collector calls when disabled and byte-identical preview-versus-wire payloads. Counts are bucketed so an exact fingerprint is never sent. Inert without a configured collector, which is currently the case.

## 10. Workspaces, Connectors, Activity, Run result

All render correctly with seeded data. Run history filters (All/Manual/Scheduled/Failed/Needs confirmation) work; the awaiting-confirmation run surfaces correctly. Run result correctly labels system runs ("Baseline rollback", "External proposal from X") and hides the rerun action for them.

- **[polish] `/activity` is titled "Run history" but reached via a route named activity** and is absent from the sidebar (demoted in v0.4). Harmless, but the naming mismatch makes the route hard to find deliberately.

## 11. Cross-cutting

- **[improvement] Four native `<select>` elements bypass the design system.** Where: `Fleet.tsx` (tenant filter), `Settings.tsx` ×2 (bound tenant, and one other), `Changes.tsx` ×4 (compare pickers). They render with the OS default arrow and focus ring, visibly different from every other control. Fix: one styled select primitive, reused.
- **[improvement] Short pages leave large vertical dead space.** Fleet, Gateway, and other sparse settings sections top-align a small amount of content in a 1000 px-tall window, leaving over half the viewport empty. Fix: either centre sparse content or give these pages a useful secondary panel (for Fleet, the drift-over-time summary would be a natural fit).
- **Responsive:** every route except Fleet passes the 900 px overflow check at all three widths, in both default and reduced-motion modes.
- **Accessibility:** skip-to-main-content link present; modals use the accessible `Modal`; segmented controls expose `aria-pressed`; drift counts carry descriptive `aria-label`s. No violations found, though no screen-reader pass was performed.

---

## Status of the findings (updated after the fix pass)

Fixed in commit `6361e10`, all verified:

- **1 Fleet overflow** - fixed and *empirically re-verified*: the capture harness now passes the same strict 900 px assertion for `/fleet` that every other route passes. The first two attempts (grid column sizing, then removing the table min-width) reduced but did not eliminate it; the fix that worked was folding the two lowest-value columns away below large widths.
- **2 and 3 model routing** - replaced name-guessing with observed capability: a model that fails the investigative JSON format twice stops being retried, and a later success clears the record. Covered by three tests, including that an explicit user setting is never overridden.
- **4 native selects** - one `Select` primitive now backs all seven call sites.
- **5 delivery rail** - collapsed behind a single "Set up run delivery" entry until delivery is configured.
- **6 per-entry rollback** - checkboxes on drift entries feed the engine's existing `selections` parameter; empty selection still means roll back everything.
- **7 Fleet badge** - removed.
- **App-identity migration** (from section 1) - solved better than proposed: rather than prompting everyone to reconnect, tenants connected before v0.5 are pinned to the app identity that issued their tokens, so they keep refreshing silently. Only new connections use the OpenAdminOS registration.

Deliberately not changed:

- **8 vertical dead space** - left alone. The pages are short because the data is short; padding them out would be decoration, and the honest fix is more useful content, which is a design decision rather than a defect.
- **9 `/activity` naming** - left alone. The route is reachable from the status strip, run results, and the menu-bar companion, and the page is titled clearly. Renaming it would break existing links for no user benefit.

Still open and owned elsewhere: retrieval index hosting, telemetry collector hosting, the 8B tool-format training, and an end-to-end gateway pairing test with a real MCP client.

## Recommended order

1. Fleet overflow (finding 1): the only outright broken thing, and a one-line fix.
2. Model routing (findings 2 and 3): decides whether the project's own model is usable in its flagship surface.
3. Native selects (finding 4): small, visible, affects three screens.
4. Reconnect migration for pre-v0.5 tenants (section 1): required before shipping the app-identity change to existing users.
5. Retrieval index distribution (section 8): the biggest claim-versus-delivery gap.
