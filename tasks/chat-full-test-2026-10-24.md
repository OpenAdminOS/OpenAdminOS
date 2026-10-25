# Chat full test: user flow, functionality, and gaps (2026-10-24)

Scope: Intune Chat on `main` at `2c47e96` after fast-forward pull from `487c7a5` (18 commits, calm shell redesign included).
Method: six parallel read-only code auditors plus an independent critic, parent re-verification of every load-bearing claim in source, executed test suites, executed matcher probes against the real agent registry, and the Electron smoke harness.
No product code was changed by this test pass.

## Top finding

Chat is functional end to end for single-tenant read questions, but it is not yet trustworthy for multi-tenant use. Conversation history is not tenant-scoped, the Chat model picker cannot actually switch providers, one configured provider (Azure OpenAI) can never send from Chat, and the investigative loop accepts ungrounded model prose as a final answer with zero tool calls.

## Acceptance criteria and verdicts

| # | Criterion | Verdict |
|---|---|---|
| 1 | Conversation lifecycle works and stays tenant-scoped | FAIL: lifecycle works, scoping does not (F1) |
| 2 | Model selection in Chat changes what answers | FAIL: cross-provider pick is a dead switch (F2); Azure gated out (F3); Gemini unselectable (F4) |
| 3 | Answers are grounded in tenant evidence | FAIL: prose-only final accepted (F5); citations are planner-based, not per claim (F9) |
| 4 | Graph calls are read-only, complete, and recoverable on error | PARTIAL: GET-only proven; live lists truncate at 50 rows (F8); 403 recovery weak (F11) |
| 5 | Cache is fresh, tenant-isolated, and honest about age | PARTIAL: isolation proven in SQL; no invalidation after write runs (F6); freshness header masks stalest source (F9) |
| 6 | Agent recommendations are relevant and write-safe | PARTIAL: handoff is write-safe; matching is noisy and divergent (F7, executed probe below) |
| 7 | No silent failures and no dead ends | FAIL: non-send errors have no action (F12); provider fallback can degrade silently (F13) |
| 8 | Existing automated coverage passes | PASS with environment caveat: electron 452/452, renderer 34/35 on Node 26 with a storage flag, typecheck clean, smoke 19/19. CI on Node 22 is green. |

## Findings, ranked

### P0: fix before relying on Chat with more than one tenant

**F1. Conversations leak across tenants.**
`listConversations` and `searchConversations` in [sqlite-store.ts](/Users/ugurkoc/Desktop/GitHub/OpenAdminOS/apps/desktop/electron/intune-chat/sqlite-store.ts:412) have no `tenant_id` filter (verified by direct read: `SELECT ... FROM chat_conversations ORDER BY ...` at line 412, search at line 424). Message read, rename, pin, and delete have no tenant check either (`service.ts:418` to `service.ts:459`), and neither does export, which lives in [conversations.tsx](/Users/ugurkoc/Desktop/GitHub/OpenAdminOS/apps/desktop/src/state/conversations.tsx:269). The Sidebar renders every tenant's conversations with a tenant tile (`Sidebar.tsx:452,491`), which labels the leak but does not prevent it. Only follow-up send is tenant-checked (`assertConversationTenant`, `service.ts:1511,1790`). SPEC says shell conversation reloads follow active-tenant changes (SPEC.md:1905), so current behavior contradicts documented intent.
Failure scenario: an admin switches from Tenant A to Tenant B and can still open, search, and export Tenant A incident conversations, including full prompts and answers with tenant data.
Fix: add `tenant_id` filtering to every conversation query and mutation, decide explicitly whether the sidebar shows active-tenant only or all tenants with a deliberate cross-tenant view, and add a cross-tenant list/search/read/export test. Mid-stream tenant switch also needs handling: the stream pins the start tenant (`service.ts:1745`) and completion reopens the old-tenant conversation (`IntuneChat.tsx:1050`).

**F2. Chat model picker cannot switch providers.**
`handleModelSelect` in [IntuneChat.tsx](/Users/ugurkoc/Desktop/GitHub/OpenAdminOS/apps/desktop/src/pages/IntuneChat.tsx:1559) only calls `setActiveModel(providerId, model)` and never `setActiveProvider` (verified by direct read). Settings does it correctly (`Settings.tsx:704`). Picking another provider's model in Chat silently pins the model, leaves the active provider unchanged, and the next send still uses the old provider.
Fix: call `setActiveProvider` first, then `setActiveModel`, and add a renderer test for a cross-provider switch followed by a send.

**F5. Ungrounded prose ships as a final answer.**
`parseModelAction` in [agentic-loop.ts](/Users/ugurkoc/Desktop/GitHub/OpenAdminOS/apps/desktop/electron/intune-chat/agentic-loop.ts:412) returns `{kind:"final"}` for any response without a JSON object (verified by direct read), including iteration 1 with zero tool calls. The existing test `agentic-loop.test.ts:162` asserts a plain final answer is `ok:true`, but only as a second response after a `query_cache` tool call. The zero-tool-call iteration 1 case follows from `parseModelAction` plus the absence of any tool-count guard in the loop, and remains untested. Failed-query finals are blocked, but a first-turn hallucinated device count has no host check. Grounding is prompt-only (`state-helpers.ts:1000`).
Fix: require at least one successful evidence tool call before accepting a tenant-data final, or mark prose-only finals visibly as ungrounded and route them through the deterministic path. Add a test where the model answers a device count with no tool call.

### P1: broken or dead-end user-visible behavior

**F3. Azure OpenAI can never send from Chat.**
`checkAzureOpenAI` returns status `"available"` when fully configured and never `"connected"` ([provider-detail.ts](/Users/ugurkoc/Desktop/GitHub/OpenAdminOS/apps/desktop/electron/provider-detail.ts:209), verified by direct read). The Chat send gate `providerReadyForIntent` requires `status === "connected"` ([SetupFlowContext.tsx](/Users/ugurkoc/Desktop/GitHub/OpenAdminOS/apps/desktop/src/setup/SetupFlowContext.tsx:71), verified by direct read). Every Azure Chat send reopens setup in a Needs setup loop, although the host accepts Azure `"available"` (`state.ts:5339`). The renderer gate alone blocks a working provider.
Fix: align the gate with the host rule, or make Azure report `"connected"` after a successful Test.

**F4. Gemini is advertised but not selectable in Chat.**
The Gemini probe returns `models: []` and reports connected only after a prior successful request (`llm-gemini.ts:13`). The Chat picker requires `models.length > 0` (`IntuneChat.tsx:2393`), so Gemini never appears and no model can be pinned. While Gemini is `"available"` the host builds a no-op LLM (`state.ts:5342`), degrading to deterministic answers.
Fix: return a default model entry from the Gemini probe, or hide Gemini from provider marketing until it is selectable.

**F6. Write runs never invalidate the Graph cache.**
`runs.ts` contains zero cache references (executed: `grep -c -i cache` returned 0) and no invalidation hook exists. After a confirmed write agent retires devices or disables guests, Chat keeps answering from pre-write cache until TTL expiry, up to 24h for the 31 default-TTL resources (`state-helpers.ts:681`). Exact TTLs: 15m for sign-ins/audits/alerts/security incidents, 30m for troubleshooting/Autopilot events, 6h for devices/users/groups, 12h for detected apps/encryption/secure scores, 24h for the rest.
Fix: mark affected resources stale on confirmed write completion (agent manifests already declare scopes; map run to resource kinds), or show a "changed since snapshot" caveat when a write run completed after `refreshed_at`.

**F7. Two agent matchers disagree, and both are noisy.**
Host matcher `matchAgentsToQuestion` ([planner.ts](/Users/ugurkoc/Desktop/GitHub/OpenAdminOS/apps/desktop/electron/intune-chat/planner.ts:972)) and renderer matcher `suggestAgentForQuestion` ([agent-suggestions.ts](/Users/ugurkoc/Desktop/GitHub/OpenAdminOS/apps/desktop/src/shared/agent-suggestions.ts:176)) use different scoring, different thresholds, and different write suppression. The renderer has no write-intent filter. Executed probe against the real 16-agent registry (`/tmp/chat-probe.test.mjs`, run with `node --import tsx`):

| Prompt | Write intent | Host top suggestions | Renderer |
|---|---|---|---|
| Which devices have not synced in 45 days? | no | find-inactive-devices, posture auditor, Team PowerShell draft | find-inactive-devices (14.25) |
| Disable stale guest accounts that have not signed in | yes | stale-guest-cleanup, offboarding-agent (false positive), posture auditor | stale-guest-cleanup (36.5) |
| Why are sign-ins failing for finance users? | no | none | sign-in-failure-explainer (18) |
| Retire the 47 devices that are not encrypted | yes | offboarding-agent, Team PowerShell draft, find-inactive-devices | none |
| Grant the finance group access to the VPN app | no (miss) | dormant-app-registrations, sign-in explainer, license overview | none |
| Update the compliance policy to require encryption | no (miss) | os-update-posture first (substring "update"), compliance-overview, team-evidence-review | compliance-overview (13) |

The shipped screenshot `docs/screenshots/app/chat-transcript.png` shows the same noise in product: Team PowerShell draft is suggested for an inactive-devices question. Cards carry no read/write badge when collapsed; scopes hide behind Details (`IntuneChat.tsx:4372`). No-match renders nothing, with no honest "no matching agent" state and no create-agent path. Dismissal is per message only; host suggestions recompute on every assistant message. Handoff itself is safe: write suggestions route to `/agents/:slug/confirm` with typed confirmation intact (`IntuneChat.tsx:1319`, `RunResult.tsx:547`), but no conversation context (device ids, the 45-day threshold) is carried into the run.
Fix: keep one matcher (host), delete or subordinate the renderer matcher, add a read/write badge and scopes on the collapsed card, pass extracted entities into the run, and add an executed matcher test table like the probe above.

**F8. Live Graph lists silently truncate at 50 rows.**
`graph_get` issues a single request and never follows `@odata.nextLink` (`tools.ts:494`); `$skiptoken` is not allowlisted, so the model cannot page either. Truncation flags go to the model only. Cache refresh paging is correct by contrast (10 pages/1000 rows capped mode, unbounded complete mode with a 128 MiB guard). Tenant-wide live questions can therefore answer from the first 50 rows while looking complete.
Fix: follow nextLink inside `graph_get` up to the existing row budget, and surface "first 50 of N" in the answer sources when truncated.

**F12. Non-send Chat errors have no recovery action.**
Send failures keep the prompt and offer Retry (good). Load, preflight, multi-tenant, pin, export, model-select, and stop failures render prose with no action button (`IntuneChat.tsx:1747,1979,2507`). This violates the no-silent-failures rule in spirit: visible, but not actionable in place.
Fix: give `ChatNotices` a per-error action (retry, open Settings, dismiss) instead of wiring retry only to `failedRequest`.

**F13. Provider misresolution degrades silently.**
The host falls back to `providers[0]` when the persisted provider is missing from the probe list (`service.ts:1045`), and unready providers build a no-op LLM (`state.ts:5342`). Combined, a broken provider setup can produce deterministic answers that look like model answers. Inferred from code, not runtime reproduced.
Fix: fail closed with a provider error naming the expected provider, and stamp deterministic fallback visibly on the message (partially exists as a collapsed notice, see F14).

**Follow-up questions have no memory.**
The non-voice prompt contains only the current question plus the answer pack (`service.ts:1604`); prior messages are read only for voice. "Show only the Windows ones" after a device answer gets no history. Edit only refills the composer and Regenerate appends a duplicate pair instead of replacing (`IntuneChat.tsx:1363,1372`). There are no history caps: `listMessages` is unbounded and every open reloads the full conversation.
Fix: include a bounded, redacted conversation window (last N turns or a host summary) in the prompt, and state the policy in SPEC.

**Concurrent and quit behavior is untested and partly unsafe.**
The renderer single `sending` state blocks a second send in the main window (`IntuneChat.tsx:653,888`, resolved during this pass), but `cancelIntuneChatStream` cancels every stream in the renderer (`preload.cts:137`), the menu-bar companion is a second surface calling it (`MenuBarCompanion.tsx:227`), and no `before-quit` handler exists, so quit-mid-stream persistence is unverified.
Fix: scope cancel to one stream id, persist cancelled state on quit, and add tests for two surfaces and quit during stream.

### P2: correctness polish, provenance, and coverage

**F9. Sources describe the plan, not what ran.**
Answer sources are built from planner-planned resources on all three send paths (`service.ts:1580,1856,2033`), so resources fetched mid-investigation via `refresh_resource` or `graph_get` get no source badge, and planned-but-unused resources can appear as sources. There are no per-claim citations for tenant data. The header shows only the newest `refreshedAt` (`IntuneChat.tsx:4002`), masking the stalest source.
Fix: build sources from executed tool traces, and show oldest-source age in the header.

**F10. Model-facing staleness contradicts host policy.**
`list_cached_resources` uses a flat 6h staleness rule (`tools.ts:296`), while the host uses per-resource TTLs. The model can be told a 23h-old profile is stale and a 20-minute-old sign-in snapshot is fresh, the opposite of host policy. Multi-tenant preflight also uses the flat 6h rule and never retries errored resources (`state-helpers.ts:297` vs `:681`).

**F11. Graph 403 in live calls names no missing scope.**
Cache refresh 403s name scopes with recovery (`service.ts:1367`); live `graph_get` 403s surface a generic HTTP 403 plus 200 chars of body (`graph-adapter.ts:490`) unless pre-flight validation catches them. Scope validation itself was widened beyond SPEC: undocumented-permission endpoints in the bundled catalog are attempted relying on Graph to refuse (`tools.ts:590`, blessed by `tools.test.ts:417`).
Graph verification note: per project Graph rules, endpoint shapes here were checked against the repo catalog and tests only. Only about 6 paths are exercised in `tools.test.ts`; roughly 50 planner `$select` paths (`planner.ts:560`) are validated for label/scope presence, never against live Graph. A Lokka MCP end-to-end pass over the planner resource table is still owed before claiming live Graph correctness.

**F14. Fallback honesty is buried.**
Deterministic fallback and repair notices render only inside the collapsed "How I checked" details (`IntuneChat.tsx:4010`), and repair attempts emit no progress. Token usage is plumbed by adapters but dropped before Chat (zero `tokenUsage` references in Chat/service/loop), so no usage or cost is ever shown or persisted. There is no reasoning-effort control anywhere; Codex hardcodes `model_reasoning_effort: low` and Ollama hardcodes `think: false`.

**Write-intent vocabulary is 11 verbs.**
`WRITE_INTENT_TERMS` ([planner.ts](/Users/ugurkoc/Desktop/GitHub/OpenAdminOS/apps/desktop/electron/intune-chat/planner.ts:265), verified by direct read) covers retire, offboard, delete, disable, enable, wipe, revoke, remove, create, change, assign. Executed probe confirms "grant" and "update" requests are not detected, so they are neither blocked with the write message nor routed to a write agent. Execution remains impossible (no write tools, GET-only), so this is a routing and honesty gap, not a safety hole.

**Streaming accessibility is thin.**
The transcript has no `role="log"` or live region; only phase words (Sending, Generating, Complete) are announced, and the failed phase is blanked (`IntuneChat.tsx:1985`, `chat-send-state.ts:40`). Answer arrival is never announced. No composer autofocus on mount or new chat was found.

**Export misattributes the provider.**
Export stamps the currently active provider, not the provider that produced the messages (`conversations.tsx:275`). Export is Markdown only, capped at 1.9 MB, includes full prompt and answer text plus tool summaries. There is no import, no in-conversation search, no undo delete, no file attachments, and no conversation search input in the Sidebar (search exists only in the command palette).

**SPEC drift list (reconcile docs or code).**
Code ships 7 chat tools, SPEC lists 5 (SPEC.md:1097). Cache now covers 45 resource kinds, SPEC lists 32 paths. Cache controls live both in Settings and a Data page, SPEC names one home. Per-resource freshness is single-tenant only, SPEC states it generally. Failed streams persist partial content (`service.ts:2276`) while SPEC says partial answers are not stored and the stop announcement copy says partial output is preserved (`chat-send-state.ts:46`), contradicting both SPEC and the actual cancel path. SPEC describes agent hints as presentation-only and never persisted (SPEC.md:1877); host suggestions persist, enter the prompt, and drive write blocking. SPEC omits Copilot, Gemini, and Apple Foundation as live providers.

**Test coverage gaps (concrete untested behaviors).**
Stop mid-stream click and stop-failed path; tenant switch with an open other-tenant conversation (the test titled "reloads for tenant and search changes" never switches tenant, `conversations.test.tsx:23`); cross-provider model switch; Azure send; stale-cache display and refresh failure; failed-send Retry button; suggestion Run agent click-through; merged host-plus-renderer suggestion disagreement; cross-tenant conversation isolation; cross-tenant cache isolation (SQL is correct, no test); quit mid-stream; two concurrent surfaces. The smoke test asserts real content but with seeded tenant, 2 canned Graph endpoints, and a fixed-answer LLM, so it cannot catch MSAL, provider-down, Graph-error, hosted-consent, or fresh-install failures. Screenshot fixtures wait for the string "Ollama" which now passes only via hidden menu DOM, so they no longer assert visible trust copy.

**Local test environment is broken on Node 26.**
Every renderer test fails out of the box on Node 26: `window.localStorage` is undefined in `src/test/setup.ts:33` because Node 26 exposes an experimental storage global that shadows jsdom. With `NODE_OPTIONS=--localstorage-file=/tmp/...` the Chat files pass 34/35; the remaining rename-modal test failure (`conversations.test.tsx:79`) does not reproduce in CI, which pins Node 22 and is green on this commit. `engines` says `>=22` and there is no `.nvmrc`, so contributors on current Node get a red suite with no explanation.
Fix: pin Node 22 in `.nvmrc` and `engines`, or make the test setup storage access defensive and verify the suite on Node 26 in CI.

## What works (verified)

- Happy path: fresh install opens Chat-first, Send gates on tenant plus provider with the draft preserved, setup resumes the pending send explicitly once, answers stream with visible progress steps, Stop persists a cancelled entry, failed sends offer Retry with the prompt restored.
- Read-only guarantee: `graph_get` rejects non-GET and hardcodes GET (`tools.ts:470`), the tool switch is closed with no write tool, and write agents from Chat always route to the confirm screen. No chat path bypasses diff confirmation.
- Tenant pinning for execution: send and tool contexts bind one tenant and refuse to run with none. Cache SQL filters `tenant_id` on every graph read and write, and tenant disconnect purges chats, cache, drift, and schedules in one transaction.
- Trust messaging: the composer always states the data boundary (local stays on device, hosted names the provider), the first hosted send per tenant and provider pauses for consent, and remote non-loopback Ollama/LM Studio endpoints are reclassified as not local.
- Cache mechanics: capped refresh never downgrades a complete snapshot, drift infers no removals from capped snapshots, refreshes are serialized, first question on an empty cache auto-refreshes before answering, and per-source freshness details exist (badge, rows, pages, error).
- Answer rendering safety: Markdown renders as a React tree with no `innerHTML`, links are http/https only, new Electron windows are denied, external opens go through an allowlist, and in-app navigation to external origins is blocked (`main.ts:4922,3081,3097`, verified during this pass).
- Conversation basics: new chat, pin, rename (modal plus F2), delete with confirm, Markdown export, workspace move/pin, copy, draft preservation per conversation, Enter to send with IME safety, and an explicit recovery state for deleted conversation links.

## Executed verification log (this machine, 2026-10-24)

| Check | Command | Result |
|---|---|---|
| Pull | `git pull --ff-only origin main` | `487c7a5` to `2c47e96`, 18 commits |
| Electron tests | `npm run test -w @openadminos/desktop` | 452 pass, 0 fail |
| Renderer Chat tests | `test:renderer` on IntuneChat, conversations, agent-suggestions | Node 26 plain: 35 fail (storage setup). With `--localstorage-file`: 34 pass, 1 fail (rename modal, CI-green on Node 22) |
| Typecheck | `npm run typecheck -w @openadminos/desktop` | exit 0 |
| Live Electron smoke | `npm run smoke:intune-chat` (after `npm install` for new font deps) | passed, 19/19 checks true including answer, agent suggestion, stop, source details, multi-tenant scope review and result |
| Matcher probe | `node --import tsx /tmp/chat-probe.test.mjs` | executed table in F7; confirms matcher divergence and write-intent misses |
| Grep negatives re-run | `grep -c -i cache apps/desktop/electron/runs.ts` | 0 (no cache invalidation on write runs) |
| Local providers | Ollama `/api/tags` | running, `openadminos/openadmin-8b` present |
| Real app database | read-only count queries | not inspected: database file is locked by the running app; no copy was made of tenant data |

Not verified: a live question against the real tenant through the dev app (the smoke harness with seeded Graph and LLM is the executed live flow), Nova voice handoff into Chat, long-conversation reload cost, and quit-mid-stream persistence. These need a device rehearsal, consistent with the still-open items in `tasks/demo-readiness-063-plan.md`.

## Recommended fix order

1. Tenant-scope conversations end to end (F1) with a cross-tenant isolation test.
2. Fix the model picker provider switch (F2) and the Azure send gate (F3); make Gemini selectable or hide it (F4).
3. Require evidence before tenant-data finals (F5) and build sources from executed traces (F9).
4. Invalidate or flag cache after confirmed write runs (F6); page `graph_get` (F8).
5. Collapse to one agent matcher with badges, context carryover, and an executed test table (F7).
6. Actionable error notices (F12), fail-closed provider resolution (F13), bounded conversation memory.
7. Pin the Node version for contributors and close the listed test gaps.
8. Reconcile the SPEC drift list, then run the Lokka Graph verification pass over planner resources.

## Live addendum: installed nightly (2026-10-25)

Environment: installed nightly `0.7.2-nightly.20261024212442`, tenant ugurlabs.com (Microsoft Entra ID P2), starting provider OpenAI Codex `gpt-6-sol` hosted. Driven through the real UI with hardware-level synthetic input (Electron AX clicks hang from shell automation: a separate tooling note, not a product verdict). Screenshots: `/tmp/oa-live-*.png` on the test machine. State was restored after testing: `activeProviderId` is `openai` again, verified in `state.json`. Two test conversations and one zero-proposal offboarding run remain in local history (see incident note).

### Live results by flow

| Flow | Live verdict |
|---|---|
| New chat empty state | PASS: tenant name, "Graph data from 1 hour ago", hosted trust line, Needs-you findings list |
| Grounded read question on Codex | FAIL: refused, claiming "the tenant query tool is unavailable in this session" |
| Same question on local Ollama (`openadmin-8b`) | PASS with quality caveats: correct "8 of 9" count covering all 8 noncompliant devices, but 10 tokens for 8 devices (seven tokens are the actual serial-like `deviceName` values, one device is identified by UPN instead of name, and that UPN token repeats three times) |
| Tool trace | Codex recorded zero investigative tool calls across all live turns (the whole `chat_tool_calls` table is 5 `graph-cache-refresh` rows plus 1 `query_cache` row, and that row joins to the Ollama answer). Trace expansion click did not visibly render; trace contents verified in the database instead |
| Sources | FAIL as predicted (F9): refusal answers still list 4 to 7 planner sources with row counts. Q1 header said "data from just now" while its device rows were 1 hour old; the same rows were honestly "2 hours ago" on the follow-up |
| Follow-up memory | FAIL as predicted: "Show only the Windows ones." answered "The supplied context contains no tenant device results to filter." |
| Stop mid-stream | PASS: "Response stopped by user before a final answer was saved.", persisted with status `cancelled`, no partial answer |
| Write intent ("Retire all noncompliant devices.") | PASS on safety: blocked, routed to Offboarding agent with Review change. FAIL on latency: cache refresh and model path ran for about 50 seconds first (sign-ins refreshed 87 to 231 rows), so the block is not a pre-refresh short-circuit on the streaming path |
| Write handoff | PASS: Review run modal pins tenant, provider, model, mode "Write with confirmation", lists scopes, warns hosted, promises diff plus typed confirmation |
| Agent suggestions in product | FAIL as predicted (F7): Team PowerShell draft first for the compliance question, compliance-overview absent, fourth card (Tenant health report) shows its raw description as the reason, and collapsed cards carry no read/write badge element (the words "read agent" and "write agent" appear only inside the reason prose) |
| Model picker cross-provider (F2) | FAIL, live-proven: picked `claude-sonnet-5`; composer and top bar still showed `gpt-6-sol` and OpenAI Codex. `state.json` confirms `activeProviderId: openai` with `activeModelByProviderId.anthropic: claude-sonnet-5` pinned. Narrower send claim: no Anthropic-produced message exists in the database (assistant rows are 7 `openai` completed, 1 `openai` cancelled, 1 `ollama`) |
| Provider statuses in Settings | Ollama Connected, Apple Foundation Connected, Anthropic Connected, OpenAI Codex Connected, LM Studio / Copilot / Gemini / Azure OpenAI Not installed. F3 (Azure) could not be live-tested without configuring Azure credentials |
| Cache and freshness UI | PASS: Data page shows Ready, last refresh time, Refresh now, Preload all 45 resources, Manual only schedule, 9,920 rows at end of testing, per-resource rows/pages/last-refresh/permission with a Needs attention filter. All 45 resources `ok`, no page limits hit |
| Tenant switch vs conversation list (F1) | NOT TESTED live: only one tenant is connected. Code verdict stands |
| Quit mid-stream, Nova voice handoff | NOT TESTED: would close the user's app / needs microphone session |

### New P0 from live testing: investigative Chat is broken on the Codex provider

The same question that the local 8B model answered correctly through `query_cache` failed on `gpt-6-sol`: the model replied in prose that the tenant query tool was unavailable, the host accepted that prose as a clean completed final (no `engine_notice`), attached planner sources anyway, and persisted zero tool calls. Across the live Codex turns (two context refusals, one clarification, one intended write block, one user-stopped) the database shows zero investigative tool calls. The earlier greeting answers in the user's own history show the same pattern, including a confabulated "[1] about Configuration Manager's Query1 element" reply to the message "1".
Ground truth from the local cache: `managedDevices` compliance states are 8 `noncompliant`, 1 `inGracePeriod`, which the local answer matched.
Probable mechanism (hypothesis, needs adapter logging to confirm): the Codex CLI adapter answers in its own agent voice instead of emitting the host's fenced JSON tool protocol, so the loop never executes a tool. The host-side defects are independent of the mechanism: prose finals need an evidence guard (F5), and repeated protocol failures should have flipped this provider to the deterministic path with a visible notice instead of repeating the same refusal (the in-memory failure memory at `service.ts:2700` evidently does not catch prose finals because the loop reports success).
Fix priority: this becomes item 0 in the fix order. Add a live-provider contract test that runs one investigative question per advertised provider and asserts at least one `chat_tool_calls` row of an investigative type.

### Incident note (tester error, no tenant impact)

While cancelling out of the Review run modal, a mis-aimed synthetic click started the Offboarding agent run (`run_mvmyfkmt_cy3iwu`). It completed in 12.0s with "No retirement action is proposed" and 0 candidates at the default 180-day threshold. No write was proposed, confirmed, or applied. The write-plan pause was therefore not reached in live testing; it remains code-verified and smoke-verified.
