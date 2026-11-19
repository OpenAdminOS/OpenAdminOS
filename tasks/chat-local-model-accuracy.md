# Chat: local model accuracy (workstreams B and C)

Two customer demos on 2026-11-24 use the local OpenAdmin 8B model in Intune Chat. Tester findings from 2026-11-18: wrong noncompliant counts, no per OS split, Entra devices mixed into Intune lists, follow-ups re-run from scratch, auto mode burning up to about 22 model calls before a fallback whose notice blamed the format.

Branch: `chat/local-model-accuracy`. `packages/runtime/src/llm-ollama.ts` is not touched.

## Plan

- [ ] Store: `countGraphCache` (exact total and per field breakdowns under filters, optional row id restriction) and a per conversation `chat_result_context` row.
- [ ] Tools: `count_cached {resource, where?, filters?, groupBy?, list?}` returning exact totals, breakdowns and, when asked and small, the matching rows. Prompt steers counts to it.
- [ ] Structured questions (`structured-question.ts`): parse device questions into resource, filters (OS, compliance state, sync window), breakdowns and a list; detect follow-ups ("only Windows", "which of those synced this month") and narrow the stored result; device "why is X not compliant" lookups that say what the cache does not hold.
- [ ] Planner: Intune, managed device, compliance and OS wording plans `managedDevices` only; `entraDevices` only for Entra, directory, join or registration wording. Search terms drop question words.
- [ ] Deterministic pack: an authoritative `computedResult` (exact counts, the full filtered list, plain fact lines) replaces unfiltered samples for that resource.
- [ ] Answer check: on a local provider, an answer that misses the computed facts is replaced by the computed answer, with a notice that says so.
- [ ] Follow-ups: the last structured result per conversation is stored and narrowed by a follow-up; follow-ups are planned with the previous question as context.
- [ ] Loop: a compact budget for local Chat (few repairs, no classification repair, fewer iterations), host-run facts seeded for local providers, a `failureReason` (`malformed`, `thinking-only`, `context-too-small`, `iteration-cap`, `no-evidence`, `empty-answer`, `unfinished`, `provider-unavailable`) for workstream E, plain fallback notices for local models, and an honest per model failure memory notice. Hosted behaviour unchanged.
- [ ] Docs: SPEC.md chat section, CHANGELOG [Unreleased].
- [ ] PR, reviews (Codex gpt-6.2-sol, Muse Wonder Full 1.0, Claude code reviewer), fixes until clean.

## Acceptance criteria

1. Seeded fixture: 9 managed devices (Windows 5, macOS 2, Android 2), 6 noncompliant (Windows 4, macOS 1, Android 1), 22 Entra devices, 33 users. Q1 "how many devices are there in Intune? show per OS, and show which are not compliant" yields total 9, per OS 5/2/2 and exactly the 6 noncompliant managed devices by name, none Entra-only, in deterministic mode and in auto mode with a scripted weak model. Tests for both.
2. A follow-up "only Windows" returns the 4 noncompliant Windows devices from the stored result without a new full plan. Tested.
3. Q2 "why is <device> not compliant?" states the failing rule is not in the cached data and names the last sync date, with no invented reasons. Tested.
4. A scripted failing local model reaches the deterministic fallback in at most 4 model calls with the designed notice. Tested.
5. Hosted provider paths unchanged: existing tests pass. All desktop electron and renderer tests pass under Node 22, typecheck passes, the Intune Chat smoke passes.
6. Live check with a hosted provider on a seeded cache if feasible, provider and model named.

## Review

(filled in at the end)
