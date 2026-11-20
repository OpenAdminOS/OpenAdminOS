# Chat: local model accuracy (workstreams B and C)

Two customer demos on 2026-11-24 use the local OpenAdmin 8B model in Intune Chat. Tester findings from 2026-11-18: wrong noncompliant counts, no per OS split, Entra devices mixed into Intune lists, follow-ups re-run from scratch, auto mode burning up to about 22 model calls before a fallback whose notice blamed the format.

Branch: `chat/local-model-accuracy`. `packages/runtime/src/llm-ollama.ts` is not touched.

## Plan

- [x] Store: `countGraphCache` (exact total and per field breakdowns under filters, optional row id restriction) and a per conversation `chat_result_context` row.
- [x] Tools: `count_cached {resource, where?, filters?, groupBy?, list?}` returning exact totals, breakdowns and, when asked and small, the matching rows. Prompt steers counts to it.
- [x] Structured questions (`structured-question.ts`): parse device questions into resource, filters (OS, compliance state, sync window), breakdowns and a list; detect follow-ups ("only Windows", "which of those synced this month") and narrow the stored result; device "why is X not compliant" lookups that say what the cache does not hold.
- [x] Planner: Intune, managed device, compliance and OS wording plans `managedDevices` only; `entraDevices` only for Entra, directory, join or registration wording. Search terms drop question words.
- [x] Deterministic pack: an authoritative `computedResult` (exact counts, the full filtered list, plain fact lines) replaces unfiltered samples for that resource.
- [x] Local answers from code: a local model never writes the answer to a question code has computed; code renders the facts with no model call (auto and deterministic mode). An earlier answer check that replaced prose missing a fact was dropped after review rounds 1 and 2 kept finding contradictions it let through.
- [x] Follow-ups: the last structured result per conversation is stored and narrowed by a follow-up; follow-ups are planned with the previous question as context.
- [x] Loop: a compact budget for local Chat (few repairs, no classification repair, fewer iterations), a `failureReason` (`malformed`, `thinking-only`, `context-too-small`, `iteration-cap`, `no-evidence`, `empty-answer`, `unfinished`, `provider-unavailable`) for workstream E, plain fallback notices for local models, and an honest per model failure memory notice. Hosted behaviour unchanged.
- [x] Docs: SPEC.md chat section, CHANGELOG [Unreleased].
- [ ] PR, reviews (Codex gpt-6.2-sol, Muse Wonder Full 1.0, Claude code reviewer), fixes until clean.

## Acceptance criteria

1. Seeded fixture: 9 managed devices (Windows 5, macOS 2, Android 2), 6 noncompliant (Windows 4, macOS 1, Android 1), 22 Entra devices, 33 users. Q1 "how many devices are there in Intune? show per OS, and show which are not compliant" yields total 9, per OS 5/2/2 and exactly the 6 noncompliant managed devices by name, none Entra-only, in deterministic mode and in auto mode with a scripted weak model. Tests for both.
2. A follow-up "only Windows" returns the 4 noncompliant Windows devices from the stored result without a new full plan. Tested.
3. Q2 "why is <device> not compliant?" states the failing rule is not in the cached data and names the last sync date, with no invented reasons. Tested.
4. A scripted failing local model reaches the deterministic fallback in at most 4 model calls with the designed notice. Tested.
5. Hosted provider paths unchanged: existing tests pass. All desktop electron and renderer tests pass under Node 22, typecheck passes, the Intune Chat smoke passes.
6. Live check with a hosted provider on a seeded cache if feasible, provider and model named.

## Review

- Review rounds: Sol (Codex gpt-6.2-sol, high) rounds 1 and 2 and Claude feature-dev:code-reviewer rounds 1 and 2; findings and fixes in the PR commits "review round 1 fixes", "Claude review round 2 fixes" and the round 2 Sol fix commit. Muse could not run: its SDK could not read the model catalog on this host (`muse login` needed).
- AC1 to AC4: `electron/intune-chat/local-model-accuracy.test.ts` (seeded ground-truth tenant, scripted weak models; deterministic and auto; follow-up "only Windows"; Q2; failing local model at most 4 calls with the designed notice).
- AC5: under Node 22, electron 1534 of 1534, renderer 814 of 814, runtime 347 passed and 0 failed (2 skipped), typecheck clean; Intune Chat smoke passed (its first run caught the list-answer check, fixed in 72dcae40).
- AC6: live service check with Claude Code (claude-sonnet-5) on the seeded cache. Auto: Q1 exact via two `count_cached` calls (11 s), Q2 says the rule is not cached and names the 2026-05-18 sync. Deterministic: Q1, the "only Windows" follow-up (the 4 noncompliant Windows devices) and Q2 exact. A hosted model in auto mode answers "only Windows" with its own loop (all 5 Windows devices, 4 noncompliant named); stored-result narrowing reaches the model only on the deterministic path and as host facts for local models.
- No local model was loaded: tests and the smoke use mocks, and `ollama ps` was empty after every run.
