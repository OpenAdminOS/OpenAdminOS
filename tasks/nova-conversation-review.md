# Nova conversation and activity review

## Reproduced failure

Read-only inspection of saved voice requests on the Mac confirmed that earlier greetings and identity questions were concatenated with a device-count request. A later request combined waiting chatter, a joke request and another device-count question. The model answered the unrelated conversation, suggested unrelated agents and searched for product information instead of returning the count.

## Changes

- Keep original Live transcript fragments and their session timestamps. Capture the current unconsumed question at the delegation boundary, with bounded prior turns passed separately as reference context.
- Keep greetings, identity questions, jokes and waiting checks conversational. They do not supersede an existing backend request. Actual new questions still replace pending work.
- Answer common unfiltered counts from cache aggregates without a reasoning call. Standalone questions do not inherit unrelated history. Follow-ups retain bounded reference context.
- Give spoken answers Nova's identity, remove unsolicited agent suggestions, and mention source links only when a successful search produced sources.
- Retry progress-only model finals twice, then report an unfinished investigation with a recovery path. This does not guarantee arbitrary models will reason correctly.
- Replace Captions on/off with an optional Conversation panel, hidden by default with a saved visibility preference. Speech uses chat bubbles. Cache, Graph, search and answer-preparation activity comes from request-scoped backend events, not model tokens or fabricated animation sequences.
- Preserve audio when the panel is hidden or the view changes. Discard stale events, remove IPC listeners on settlement, and label completed, failed, stopped and replaced tasks distinctly.

## Verification

- Replayed the reported greeting/count/waiting/joke/repeated-count sequence through transcript capture and the production Chat/cache path against isolated synthetic tenant data. Both counts completed with zero reasoning calls and zero web searches.
- Regression checks cover out-of-order and overlapping transcript intervals, duplicate events, consumed questions, small-talk interruptions, replacement, late activity, output chunk bounds, unfinished model finals and truthful source notices.
- Browser review used the production React components with a fixture bridge at 1280×720, 1000×500 and 375×812. Checked the optional panel, running/completed activity, separate bubbles, scrolling, resize, hiding/showing and full-window transitions. The reference is `docs/mockups/23-nova-conversation.html`.
- Read-only Lokka Graph `/beta` verification checked managed-device response fields, continuation paging and an invalid-field rejection. Graph fixture tests supplement that live check.
- Repository tests, TypeScript checks, Graph QA, documentation generation and the desktop build passed before the first preview build. Follow-up boundary and overlapping-bubble regressions are also required on the final commit.
- A fresh GPT-Live WebRTC replay used OpenAI-generated speech and the production Nova renderer/service/Chat/cache path with a synthetic tenant. The device-count delegation included the final word after correcting an inclusive timestamp boundary. The first lookup was deliberately held for 25 seconds to exercise intervening speech; it completed with zero reasoning-model calls, and GPT-Live spoke the correct count and repeated it correctly on a follow-up. An active inbound audio track and advancing audio playback were observed.
- The first audio harness attempt failed because its synthetic provider disagreed with the Chat scope. Aligning the fixture provider resolved that test-only mismatch. Continuous synthetic room noise was needed to keep the test audio source streaming between prerecorded phrases.

## Limits

This pass does not constitute a fresh real-microphone GPT-Live conversation on the Mac. The fresh hosted audio replay used generated input speech and synthetic tenant records. GPT-Live misheard an interruption and emitted one unrelated refusal before correctly speaking the device count; this remains a provider speech-quality limitation, not a fully passed natural-conversation claim. The selected reasoning model can still make incorrect research decisions or factual inferences. Live transcript deltas have intervals rather than authoritative completed-turn IDs, so grouping remains an approximation; the original fragments are retained within a bounded session buffer. Full local Whisper/Kokoro speech and live target-device microphone behavior remain hands-on checks.
