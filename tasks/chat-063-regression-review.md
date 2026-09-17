# Chat 0.6.3 regression review

Date: 2026-09-15. Scope: PR #88 source checkout on macOS, the reported Windows
encryption question, adjacent device queries and cache-query failure handling.

## Confirmed defects and fixes

- The persisted Chat trace filtered managed devices using `platform` and
  `deviceEncryptionState`, then reported no matches. The managed-device snapshot
  was complete and contained matching records under `operatingSystem` and
  `isEncrypted`. The aggregate cache warning did not explain that wrong answer.
- Common device lists and counts now apply host-owned predicates in streaming
  Chat, nonstreaming Chat and Nova. Supported OS filters remain part of the query.
  True, false and missing/null encryption states remain distinct. Compliance,
  grace-period and encryption criteria are separate.
- Cache tools reject invented fields, unsupported parameters and malformed or
  over-limit filters. Errors cannot masquerade as successful empty queries.
  Schema fields are available even when optional values are absent; fields on
  later cached rows are discoverable. Results include snapshot coverage.
- A failed cache lookup must be repaired before investigative Chat accepts a final
  answer. Exhausted repairs produce an explicit inability to verify the count.
- Security-incidents preload requested 250 records, but the endpoint rejected
  values above 50. The request now uses 50 and retains continuation paging.

## Verification scope

| Layer | Coverage | Result |
| --- | --- | --- |
| Real SQLite regression matrix | Windows, macOS, Android, Linux no-match; encryption true/false/null/missing; compliance and grace period; counts/lists; tenant isolation; 50-row caps | Passed |
| Coverage and error handling | Missing snapshot, partial pages, known incomplete total, failed refresh, invalid fields/types/parameters, malformed filter arrays, excessive predicates, optional fields absent from first/all rows | Passed |
| Scripted model behavior | False zero after invalid lookup, malformed replies after failure, missing/unknown resource, valid repair, Chat and voice modes | Passed |
| Desktop service | Reported question through Chat, Nova and nonstreaming send; saved evidence sources; no model calls for supported direct answers | Passed |
| Preload service | 51 incidents over two pages under endpoint limit; existing 1,200-device paging/failure/cancellation retention test | Passed |
| Repository suite | 614 Node tests plus 125 renderer tests passed; one runtime test skipped | Passed |
| Static checks | Repository typecheck; desktop production build; Graph QA | Passed; QA has four existing warnings for scope-free Team evidence/draft agents |

Focused Chat regression tests were rerun after the final guard changes. Source
checks and the production build do not update the installed application.

## Configured-cache and provider replay

The installed application's SQLite database was opened read-only and backed up
into a private review folder. The source code ran against that copy. Five direct
queries covered Windows encrypted/unencrypted/unknown states, Windows compliance,
and macOS encryption. Their answers matched the saved records.

An additional investigative replay used the configured local Ollama model,
`openadminos/openadmin-8b:latest`. Initially it used invalid filters, attempted a
live lookup, and failed to repair its query. The failure guard prevented a false
zero. After supplying the managed-device field meanings in its system context,
the same question queried the correct fields, returned every expected matching
device, and completed in approximately 21 seconds. Two additional real-model
queries for encrypted Windows devices and unencrypted macOS devices also returned
every expected matching name, in approximately 9 and 21 seconds respectively.

Live Graph was disabled in these cache-copy replays, and no tenant data was sent
to a hosted model. Private traces and answers remain outside the repository.
This is configured-cache and real-provider evidence, not an installed-app UI
rehearsal, a fresh tenant inventory or proof of general model accuracy.

## Remaining demo work

Install a build containing these changes, retry the incomplete cache collection,
and repeat the chosen Chat and Nova questions through the installed desktop UI.
Rehearse additional investigative topics and the complete Agent Team chain with
the intended providers. The earlier Agent Team draft-quality and timeout findings
remain tracked in [the installed-app review](agent-team-063-live-review.md).

## Expanded source review

A 21-question saved-cache matrix covered devices, Intune apps, users, groups,
app registrations, Conditional Access and licensing with the configured local model.
Device, user, group and policy counts matched their saved source rows. The first
app-registration total timed out; bounded field projection reduced its repeat to
approximately 11 seconds with the correct count. The filtered app-registration
question still failed endpoint selection and returned an explicit inability to verify.

The unused-license question exposed a second false-empty failure: failed live reads
were followed by an unrelated empty user filter. Failed Graph lookups now also block
unsupported final answers. Its repeat explicitly reported no verified count. User
license queries also remain unverified with this saved cache. These are unresolved
answer-coverage limits, not successful answers to the requested licensing questions.
The system now supplies resource labels and Graph paths alongside field schemas to
reduce app-registration versus managed-app-registration confusion.
