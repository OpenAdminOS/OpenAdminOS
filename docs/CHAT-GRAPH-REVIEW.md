# Chat: how Graph data is fetched, and where it breaks

> **Status: all findings below are fixed.** Each section keeps the
> original diagnosis and records what changed. A seventh problem, found
> only by running the pipeline against a real 8B model, is in section 9.

A review of the Chat answer path, focused on the Graph fetch layer. Chat is
the feature admins will use most, so the failure modes below matter more than
their line count suggests.

Every claim here was checked against the code, and the planner findings were
produced by running `planChatContext` against real question phrasings rather
than by reading the rules.

## How it works today

A question goes through five stages:

1. `planChatContext(question)` picks which Graph resources are relevant, by
   substring-matching the question against keyword lists.
2. Any picked resource whose cache is empty or older than 6 hours is
   refreshed from Graph.
3. `fetchGraphCachePages` pages each resource: up to 10 pages, hard stop at
   1,000 rows, `$top=250` on most resources.
4. Rows land in SQLite. An answer pack is built from at most 40 rows per
   resource, of which at most 20 are shown to the model.
5. The model answers from that pack, plus retrieved documentation.

The design is sound. The problems are concentrated in stages 1, 3, and 4.

---

## 1. Aggregate questions are answered from a 20-row sample

**Severity: high. This is the most serious finding.**

"How many devices are non-compliant?" is the archetypal admin question, and
the pipeline cannot answer it correctly on any tenant above ~1,000 objects.

Three truncations stack:

| Stage | Cap | Set in |
| --- | --- | --- |
| Tenant to cache | 1,000 rows | `GRAPH_CACHE_ROW_LIMIT` |
| Cache to answer pack | 40 rows | `intuneChatProviderBudget` |
| Answer pack to prompt | 20 sample rows | `maxSampleRowsPerResource` |

`buildBreakdowns` computes `complianceState` counts over the **selected rows**,
not the cached set and not the tenant. On a tenant with 3,000 devices of which
400 are non-compliant, the model receives a breakdown like
`{compliant: 33, noncompliant: 7}` derived from 40 rows.

There is no true total anywhere in the pipeline to correct it with: the
sqlite store contains **zero `COUNT(*)` queries**, and no request sends
`$count=true`.

The model is told `cachedRows` and `pageLimitReached`, and the system prompt
tells it to disclose partial data, so a well-behaved model says "I cannot
determine this". That is the *best* case, and it is still a non-answer to the
most common question. A weaker local model reports 7.

**Fix.** Two changes, both small:

- Send `$count=true` with `ConsistencyLevel: eventual` on the directory
  resources that support it (users, groups, devices, applications, service
  principals) and read `@odata.count`. That is an exact tenant total in one
  request, with no paging.
- Add `COUNT(*)` and `GROUP BY` aggregate reads to the sqlite store for the
  fields already in `buildBreakdowns`, and put the true counts in the answer
  pack alongside the sample. The model then has an exact number to quote and
  the sample only serves as illustration.

This turns "I cannot determine this" into "412 of 3,000 devices are
non-compliant" without enlarging the prompt.

---

## 2. Keyword planning fetches the wrong resources, and far too many

**Severity: high.**

`matchesAny` is a plain substring test:

```ts
function matchesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
```

With no word boundaries, short needles match inside unrelated words. Measured
output from the current rules:

| Question | Resources planned | Problem |
| --- | --- | --- |
| "Please respond with a list of our conditional access policies" | **17** | `resp`**`ond`** contains `esp`, pulling in the whole Autopilot group |
| "Summarize what happened in the tenant this week" | 3, all wrong | `h`**`app`**`ened` matches `app`; `summarize` never matches `summary`; the audit rules need the literal phrase "what changed" |
| "What is the cost of our licenses?" | 3 | `c`**`os`**`t` matches `os` |
| "What does Autopilot pre-provisioning require?" | 7 | A documentation question that fetches seven tenant resources |
| "hi" | 3 | A greeting triggers a Graph refresh |

The first row is the expensive one: 17 resources for a question that needs
exactly one. The second is the dangerous one, because it is not merely
wasteful, it is **wrong**: an admin asking what happened in the tenant gets
app inventory instead of audit logs, and nothing in the answer signals that
the relevant data was never fetched.

**Fix**, in increasing order of effort:

- Match on word boundaries rather than substrings, and drop needles shorter
  than four characters (`os`, `esp`, `dem`, `mam`, `asr`) or anchor them.
  This alone removes every false positive in the table above.
- Add the missing synonyms the rules already imply: `summarize`, `what
  happened`, `recent activity`.
- Cap planned resources at roughly 5, ranked by how many rules matched, so
  no question can trigger 17 refreshes.
- Skip the refresh entirely for messages with no admin intent, so "hi" and
  "thanks" do not hit Graph.

Longer term the right answer is to let the model choose resources through the
existing tool layer rather than guessing ahead of it, keeping keywords only as
the fallback for models too small to call tools reliably.

---

## 3. A single network blip discards the whole refresh

**Severity: high. Most likely cause of real-world failure reports.**

`graphRequest` retries thoroughly on HTTP status: 429 always, 5xx when the
request is idempotent, honouring `Retry-After`, up to 3 attempts. That part is
well built.

But the `catch` around `fetch` **throws immediately**:

```ts
} catch (error) {
  ...
  throw new Error(message);   // no retry
}
```

Timeouts and network errors are never retried. The target user is an admin on
a laptop, frequently behind a VPN, who closes the lid. On a question that
planned 17 resources, one dropped connection on request 40 of 68 fails that
resource outright, and the answer is silently built from less data.

**Fix.** Retry transient network errors and timeouts with the same attempt
budget and exponential backoff. Keep the current behaviour for non-idempotent
methods. This is a handful of lines in the existing loop and is the single
highest reliability return in this document.

---

## 4. Refreshes run strictly serially

**Severity: medium, and it is what makes every other latency issue visible.**

`refreshGraphCacheInternal` is a plain `for` loop, and `fetchGraphCachePages`
pages serially inside it. Worst measured case, the 17-resource question, is up
to 68 sequential round trips before the model produces a single token. Graph
list calls routinely take 30 to 45 seconds, which is why the adapter timeout
is 60 seconds.

**Fix.** Run resource refreshes with bounded concurrency, 4 to 6 at a time.
Graph throttles per resource unit, so modest parallelism across different
resources is well within normal limits, and the existing 429 handling already
covers the case where it is not. Combined with finding 2 this turns a
multi-minute wait into a few seconds.

Paging within a resource should stay serial, since `nextLink` is inherently
sequential.

---

## 5. Stop does not stop anything

**Severity: medium, user-visible.**

In the streaming path, cancellation is checked before the refresh block
(line 1664) and after it (line 1783), but never inside. `options.signal` is
never passed into `refreshGraphCacheInternal`, `fetchGraphCachePages`, or the
Graph adapter.

So pressing Stop during "Refreshing Intune managed devices" lets all remaining
resources fetch to completion, then discards the result. On a large tenant the
UI claims to have stopped while minutes of work continue in the background.

**Fix.** Thread the `AbortSignal` through the refresh into `graphRequest`,
which already builds an `AbortController` per request and only needs the
caller's signal chained to it. Check the signal between resources and between
pages.

---

## 6. Freshness is invisible until it is wrong

**Severity: medium, UX.**

The cache TTL is 6 hours, hard-coded in two places (`service.ts:1345` and
`service.ts:1720`). An answer built from data 5 hours and 59 minutes old is
presented identically to one built from data fetched a second ago. The
`refreshedAt` timestamp reaches the model, and the sources row carries it, but
nothing in the answer itself states the age.

For a question like "which devices are non-compliant", six hours is often
fine. For "did the policy I just deployed apply", it is completely wrong, and
the admin has no signal that they are reading stale state.

**Fix.**

- Show the data age next to the answer, not only in the sources detail.
- Offer a one-click "refresh and re-answer" on any answer built from cached
  data, rather than requiring the admin to know the cache exists.
- Vary the TTL by resource. Audit logs and sign-ins age in minutes; compliance
  policies and Autopilot profiles age in days. One constant for both is wrong
  in both directions.

---

## 7. Smaller items

- **Silent row loss.** `fetchGraphCachePages` truncates the final page to the
  1,000 row cap but only sets `pageLimitReached` when a `nextLink` is present.
  A single page overflowing the cap with no `nextLink` drops rows and reports
  the result as complete. Narrow, but it is a silent failure, which the
  project's constraints forbid.
- **No delta queries.** `managedDevices`, `users`, and `groups` all support
  Graph delta queries. Every refresh currently re-reads the full collection.
  Delta would make the 6-hour TTL cheap enough to shorten substantially.
- **`$select` but no `$filter`.** Requests trim fields but never rows, so a
  "stale devices" question downloads all 1,000 devices and filters locally.
  Pushing the obvious predicates into Graph would cut both latency and the
  truncation exposure in finding 1.
- **Non-streaming path has no progress.** `sendIntuneChatMessage` calls
  `refreshGraphCache` without the progress callback the streaming path uses,
  so any consumer on that path waits with no feedback at all.

---

## Suggested order

Ranked by reliability gained per unit of work:

1. Retry network errors and timeouts (finding 3). Smallest change, largest
   reliability gain.
2. Word-boundary keyword matching and a resource cap (finding 2). Removes the
   17-resource case and the wrong-context case.
3. True counts via `$count` and sqlite aggregates (finding 1). Makes the most
   common question class answerable.
4. Bounded-concurrency refresh (finding 4).
5. Honour the abort signal (finding 5).
6. Freshness surfacing and per-resource TTL (finding 6).

Items 1, 2, and 4 together should take the 17-resource question from minutes
to seconds. Item 3 is what makes the answers trustworthy enough to act on.

---

## 8. Coverage: which questions can Chat answer at all?

Measured against the bundled Graph catalog, not estimated.

There are three ceilings, and they bind in this order:

**Ceiling 1, the model.** If the provider is local and the model name suggests
a small model, or if the model has failed the investigative format twice in
this session, `resolveAgenticCapability` disables tool calling entirely. Chat
then answers only from the 45 pre-defined cached resources. This is the
default experience for a local-first user, and it is by far the tightest
limit. The demotion counter is in-memory, so it resets on restart.

**Ceiling 2, the endpoint allowlist.** With tool calling active, `graph_get`
can reach:

| | Count |
| --- | --- |
| GET endpoints in the catalog | 16,684 |
| GET endpoints with delegated-scope metadata | 2,730 |
| **Reachable through `validateGraphGetPath`** | **879 (5.3%)** |
| Rejected for having no scope metadata | 13,954 |

The 13,954 are not blocked because the tenant lacks permission. They are
blocked because `api-docs-index.json` carries permission data for only a
fraction of the catalog, and `validateGraphGetPath` treats "no known scope"
as "outside the allowlist".

**Ceiling 3, consent.** 21 read scopes are requested. Widening the allowlist
from the 18 scopes the cached resources happen to use to all 21 consented
scopes adds only 29 endpoints (879 to 908), so consent is not the binding
constraint today.

### What "answer any question" would require

The allowlist is a second enforcement layer sitting behind a token that
already cannot exceed what the tenant consented to. Graph itself rejects
anything outside the granted scopes, and `graph_get` is already restricted to
GET, so the allowlist is not what keeps writes or unconsented data out.

Replacing "reject unless the catalog knows a matching scope" with "attempt any
GET the token permits and let Graph's own 403 be authoritative" moves
coverage from 879 endpoints to every read endpoint the consented scopes
cover, without widening what the app can actually see. The catalog stays
useful for path validation, suggestions, and scope hints; it stops being a
gate.

That plus finding 1 (true counts) and finding 2 (resource planning) is what
turns Chat from a good answerer of anticipated questions into one that
handles arbitrary ones.


---

## 9. The finding that only appeared under a real small model

Everything above was found by reading the code. Running 50 unanticipated
questions through the real pipeline against `openadmin-8b` surfaced a
problem no amount of reading would have shown, and it made the coverage
work in section 8 irrelevant for local models.

**Investigative mode never ran.** The model would emit a correct tool
choice with slightly malformed JSON, twice, and the loop abandoned the
investigation and fell back to keyword-planned context. The measured
failure was consistent and structural rather than random:

- The model dropped a closing brace on an otherwise correct call.
- Given a `filters: [{field, op, value}]` schema, it wrote bare
  `{"field": "value"}` pairs inside the array, which is not valid JSON
  at all and so could not be repaired by balancing brackets.
- After a filter matched nothing, it had no way to learn which fields
  the rows actually had, so it concluded the tenant had none of whatever
  was asked about.

Three changes, in the order they mattered:

1. **Repair structural slips.** A tool call missing a closing brace is
   completed rather than discarded. Repairs are structural only, so no
   key, value, or tool name is ever invented.
2. **Simplify the schema.** `where` accepts a plain field-to-value map,
   which is the shape a small model reaches for and can emit correctly.
   The explicit `filters` form stays for other operators, and bare pairs
   inside it are read as equality rather than rejected.
3. **Make a dead end teachable.** A filter matching nothing returns the
   field names the cached rows actually have, so the next call can be
   corrected.

The retry budget also went from one to three, since a single slip used
to end the investigation.

Before: two malformed replies, investigation abandoned, deterministic
fallback, no answer. After: the model self-corrects across turns and
answers from the data it gathered.

The general lesson is that the tool contract, not the model size, was
the limit. A schema an 8B can express correctly is worth more than
tolerant parsing, and an error that teaches is worth more than both.


---

## 10. Measured against a real 8B model

50 questions, none drawn from the in-app prompt suggestions or the
researched question bank, run through the real pipeline with
`openadmin-8b` via Ollama. Tenant data was synthetic, so this measures
whether the pipeline works end to end, not answer quality against a real
tenant.

| | Before the protocol fixes | After |
| --- | --- | --- |
| Questions using investigative tools | 0 | 47 of 50 |
| Fell back on malformed JSON | every question | 2 of 50 |
| Answered | via keyword-planned context only | 49 of 50 |

Tool usage across the run: `query_cache` 62, `find_graph_endpoint` 36,
`graph_get` 12, `query_drift` 1, `list_cached_resources` 1. The
discovery tool being the second most used confirms the diagnosis in
section 8: the model does not know Graph paths, and given a way to look
them up it uses it constantly.

Re-running only the questions that failed, after the repair-budget fix
in section 9, 5 of the 8 completed a full investigation (3 to 5 tool
calls each) rather than falling back. Of the 3 that still fall back:

- One genuinely exhausted the six-call budget on a question that needs
  cross-referencing app inventory against deployment records. Raising
  the cap would fix it at a cost in latency.
- Two are open-ended synthesis questions ("summarise our posture for the
  board", "what would an auditor find missing") where the model produced
  malformed JSON repeatedly. Both still answered through the
  deterministic path, so the fallback is doing its job.

Remaining weaknesses, honestly recorded:

- **Latency.** Median 54 seconds per question, one timeout at 240s. An
  8B doing four sequential turns is inherently slow; concurrency helps
  the fetch, not the reasoning.
- **Arithmetic.** At least one answer stated a total that disagreed with
  the list it then printed. Exact counts are now in the context, but
  nothing forces the model to use them over its own counting.
- **Coverage of the fixture.** 33 answers declined for lack of data.
  Most of those questions genuinely could not be answered from the
  synthetic tenant, so this number says more about the fixture than the
  pipeline, and should be re-measured against a real tenant.


---

## 11. What a real tenant showed that synthetic data could not

The 50 questions were re-run against a read-only snapshot of a real lab
tenant. The pipeline held up: 44 of 50 answered, 39 investigated with
tools, only 2 protocol fallbacks. It also exposed a failure class the
synthetic fixture had hidden completely.

**Five answers asserted the tenant had none of something it had.** The
clearest: "the tenant has no managedDevices, so the count is 0", against
a tenant holding nine. The model had run a filtered query, matched
nothing, and reported that as absence.

Three things were wrong at once, and only the first was obvious:

1. `query_cache` reported rows matching the filter with no indication of
   how many existed unfiltered, so "0 matched" and "0 exist" were
   indistinguishable.
2. The one-line trace summary said "0 of 0 cached rows returned",
   because the count it quoted was also filtered. This is the most
   salient line in the observation, and it actively contradicted the
   corrective note added to fix (1).
3. Field names were advertised only after a query had already failed,
   so the model had to guess field names on its first attempt and
   frequently guessed a plausible but non-existent nested field.

All three are fixed. Empty results now carry the unfiltered count, the
summary reports "no rows matched this filter; N rows are cached", and
field names are advertised on every read.

The false absence claims are gone. Correctness on these questions is
not solved: asked which laptops are unencrypted, the model now retries
rather than answering "none", but still does not pick `isEncrypted` out
of forty field names, and answers a related question instead. That is a
model field-selection limitation rather than a pipeline defect, and it
belongs in the evaluation and fine-tuning programme rather than in more
prompt scaffolding.

The eval harness lives outside this repository, at
`eval/chat-tenant/` in the model pipeline, because its fixture holds
real tenant data that must never be committed.


---

## 12. A caveat that invalidates part of the method above

Running one question three times against the same fixture, same model,
same code produced three materially different answers: a fabricated
count of iPhones in a tenant with none, a statement about unsupported
OS versions, and a refusal for lack of matching records.

The model is not stable enough for a single run to measure anything at
the level of an individual question. That undermines the before-and-after
comparisons made on single questions earlier in this document: where a
question was re-run once and looked fixed, the change may have been
variance rather than the fix.

What remains reliable:

- Structural measurements that do not involve the model at all:
  endpoint reachability, keyword planning, retry behaviour, refresh
  concurrency, SQL aggregate counts. These are deterministic and covered
  by tests.
- Large aggregate effects across all 50 questions, such as tool usage
  going from zero to forty-seven, which is far too big to be variance.

What is not reliable, and was previously presented as if it were:

- Any claim that a specific question was fixed on the strength of one
  re-run.

Evaluating this model properly needs several runs per question and a
comparison of distributions, not single samples. That belongs in the
eval programme, which is why the harness now lives there.
