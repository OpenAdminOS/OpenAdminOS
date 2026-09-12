# Nova evidence, interruption and connector review

Implements the six findings from the September 12 voice transcript on PR #86.

- Fleet non-compliance/encryption lists read filtered SQLite records directly, disclose freshness, partial snapshots and a 50-row list cap. Unknown encryption is excluded from reported-false results.
- Fleet cause questions query per-device compliance policy states and setting states, with paging, cancellation and explicit per-device errors. Ten devices and ten pages/1,000 rows per collection bound the investigation; unverified causes are not replaced with plausible guesses.
- Follow-up context includes “they”, “it”, “its” and “why”. Spoken Stop is consumed independently of a following question. Hosted Stop answer gates playback and aborts the backend while retaining the microphone; session Stop releases it. Local voice remains recording-based.
- Activity distinguishes retrieved backend results from speech. Waiting questions after retrieval re-supply the completed result rather than initiate a lookup.
- Explicit delivery requests prepare the complete last successful backend answer for existing WhatsApp, Outlook/Exchange, Teams, Slack, Discord and Signal connectors. Self delivery is explicit for WhatsApp and email. Defaults are shown before sending; no model-selected recipients.
- Agent launch requests resolve installed names and use ordinary startRun. Each action has a five-minute, one-use visual approval tied to session scope. Connector settings are rechecked and the normal wrapper records success/failure in the local audit export. No retry loop sends uncertain messages again.

Validation:

- Real Chat service + SQLite integration replays list, why, encryption, and WhatsApp preview with fixture Graph responses and zero reasoning calls. Unknown encryption stays unknown; only completed evidence is shared.
- Unit/regression checks cover all connector mappings, exact agent lookup, absent evidence, full-body previews, duplicate decisions, interrupted previews, tenant changes, combined Stop/follow-up, policy paging and unavailable causes.
- Renderer tests exercise hosted interruption without closing microphone/peer, approval before execution, and suppression of late connector replies after Stop answer. Browser screenshots inspect production Nova with synthetic transport/bridge data at wide and narrow window sizes, including the visible destination/body review.
- Read-only live Lokka beta checks verify inventory compliance/encryption fields, continuation links, policy-state fields and setting-state failure values. These are endpoint checks, not desktop MSAL verification.
- Full repository tests, typecheck, desktop build and Graph QA are run before push. Graph QA uses the installed msgraph reference directory.

Limits: no external message was sent to a user's account in this pass. Connector acceptance is not delivery proof. Existing in-flight connector sends cannot necessarily be recalled by interruption. Hosted speech uses OpenAI's documented instructions.append plus application playback gating; exact speech wording and real-device microphone latency require live testing. The Mac was unavailable over SSH during the initial review. No new Mac/Windows hands-on result is claimed.
