# Nova tenant context and setup review

Reviewed against PR #86 after the user reported that OpenAI voice denied having a connected tenant and devices.

## Confirmed causes and fixes

- The Live session instructions did not include the selected tenant. They now include a bounded tenant name/ID and explain that the app connection exists independently of cache contents. A delegated tenant-identity question also has a deterministic answer without Graph or an LLM call.
- The delegation policy was a single generic instruction. It now lists actual backend capabilities and explicitly delegates device visibility, counts and tenant-evidence questions before answering.
- Nova called Chat with `refreshIfStale: false`. It now uses normal on-demand refresh of the resources relevant to the question. Manual preloading is optional.
- The setup flow conflated speech credentials with tenant reasoning. It now names the reasoning provider/model, checks readiness before microphone access, keeps voice-provider selection visible, remembers that choice, and offers a connection check and Cache/Settings links.
- Local speech checks whisper.cpp health and Kokoro model availability. Ollama alone is not a speech input/output installation. OpenAI's optional model-access check is separate from starting a session, so a restricted key that lacks Models API access is not automatically blocked from Live.
- Long backend answers are capped at 2,000 characters for voice. The full answer and evidence remain in Chat. Each Live commentary event remains limited to 100 Unicode code points.

## Cache size versus context size

The SQLite cache is application storage, not a prompt. The deterministic answer path reads bounded evidence (normally 40 rows per relevant resource, 20 sample rows in the answer pack), with SQL counts/breakdowns across all cached rows. Investigative tools return at most 50 rows and Graph tool output is capped at 24,000 bytes. The investigative loop has a 36,000-character observation budget. These are character/row budgets, not a guarantee that every local model's token window will fit.

Remaining risks: many distinct aggregate buckets, several resources in one answer, documentation and assistant history can still exceed a small model's input window. Budgeting should account for the selected model's actual context capacity and reserve output space. Broad refreshes may take time on large tenants; preloading improves latency without injecting all data into Nova. Live transcript history and delegated-task correlation also need real conversation evaluation, especially interruptions and pronoun-heavy follow-ups. An instruction alone does not guarantee delegation.

## What Nova should know

Always: selected tenant, current page, reasoning provider, available backend capabilities and write-approval limits. On demand: permitted devices, OS/encryption/compliance summaries, users/groups, policies/apps and supported security data, with timestamps, coverage and permission failures. Full records, secrets and unrelated tenant data do not belong in the initial voice prompt. Office missions, team findings and run history should get explicit read tools before Nova advertises access to them.

## Evidence and limits

Regression coverage includes tenant identity without a cache, device questions requesting refresh, bounded spoken output, unavailable reasoning before microphone activation, local service failures and API credential errors. Read-only Lokka `/beta` verification checked managed-device OS/encryption/compliance fields, followed a continuation link, and confirmed a structured 400 for an invalid selected property. This was endpoint verification, not proof of the Mac app's delegated token permissions. A live GPT-Live WebRTC test then reproduced the user's two questions using synthesized microphone input, the production renderer/Nova service, and the actual Chat backend with Ollama. The selected-tenant answer succeeded without cached records. The device question delegated, fetched the relevant snapshots into the cache, returned their counts and produced an acknowledged commentary result plus a spoken output transcript with those counts. The Graph adapter in this isolated review used freshly fetched Lokka snapshots; this was not an end-to-end test of desktop MSAL authentication. The test credential was held only in the isolated review server's memory, not committed or embedded in the renderer.

The first audio fixture stopped generating frames after its utterance, which stalled Live context injection. Continuous input corrected the fixture and result delivery succeeded. Separately, the live test exposed speaker-label batching and a waiting indicator that reverted to listening during backend work. Both renderer issues now have fixes, with a regression test covering transcript labels, waiting state and the delegated-result handoff.

The CPU-only local reasoning model took several minutes and returned an irrelevant inventory of unrelated uncached resources. Live spoke the correct device counts but repeated an overly broad incomplete-cache caveat. This remains an answer-quality/latency limitation, not evidence that preloading every resource is necessary. Before a conference, evaluate the chosen reasoning model on the actual hardware and questions. The revised setup was also checked at a compact viewport, including the live unavailable-Whisper recovery message. Local Whisper/Kokoro connectivity has failure-path regression coverage; this review did not run a complete local speech conversation.

References: [OpenAI delegation](https://developers.openai.com/api/docs/guides/live-delegation), [OpenAI prompting](https://developers.openai.com/api/docs/guides/live-prompting#delegation), [whisper.cpp server](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/server.cpp), [Kokoro API examples](https://github.com/remsky/Kokoro-FastAPI/blob/master/debug.http).
