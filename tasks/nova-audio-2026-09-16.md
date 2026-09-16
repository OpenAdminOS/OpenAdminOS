# Nova audio acceptance, September 16, 2026

Latest result: a second signed build kept the audience greeting conversational,
but a repeated long-pause trial still submitted a noun-phrase prefix early. The
unrestricted live demo is not accepted. Earlier six-case success did not establish
repeatable complete-request capture.

## Setup and method

- Installed signed preview 0.6.3, runtime build `db19a6d`.
- Nova full screen with conversation panel visible throughout the voice session.
- Configured speech: OpenAI GPT-Live-1. Configured tenant reasoning: Ollama,
  `openadminos/openadmin-8b:latest`.
- Generated WAV clips with macOS Samantha speech, 165 words/minute normally and
  245 for the fast case. Pause labels describe the requested synthesis silence;
  they are not measurements of network transcript delivery gaps.
- Played each clip through QuickTime using Computer Use, the MacBook Air speakers
  and the built-in microphone. No virtual input or text injection into Nova.
- Compared Nova's visible transcript/activity with read-only SQLite records of
  questions actually submitted to Chat. Snapshot had nine device records, three
  unencrypted Windows devices and six unencrypted devices across all platforms.
- One trial per case, sequentially in the same session, after the prior answer.
  These synthetic-voice trials do not establish behavior across accents, ambient
  noise, human hesitations, barge-in or network conditions.

## Results

| Clip | Spoken input | Submitted request and observed outcome |
| --- | --- | --- |
| Normal, 165 wpm | Which Windows devices are not encrypted? | Complete request; three Windows matches. 06:02:44 UTC. |
| Fast, 245 wpm | Which Windows devices are not encrypted? | Complete request; three Windows matches. 06:03:26 UTC. |
| 350 ms pause | Which Windows devices are [pause] not encrypted? | Complete request; three Windows matches. 06:04:06 UTC. |
| 800 ms pause | Which Windows devices are [pause] not encrypted? | Complete request; three Windows matches. 06:05:07 UTC. |
| 1,400 ms pause | Which Windows devices are [pause] not encrypted? | **Fail:** submitted `Which Windows devices are` at 06:05:47 UTC. UI then showed `Question replaced`, followed by separate `not encrypted`. Nova asked to repeat the request as a single action. |
| Late platform, 800 ms pause | Which devices are not encrypted [pause] on Windows? | **Fail:** submitted only `Which devices are not encrypted` at 06:06:36 UTC and retrieved six all-platform matches. Visible transcript later contained the whole question. Spoken answer said six devices, with three Windows devices. The requested Windows filter was absent from the submitted query. |

## Interpretation and remaining work

The fast clip passed. Pauses before qualifiers exposed the failure, so fast speech
alone does not explain the report. Successful shorter-pause trials do not establish
a safe universal timing threshold: transcript delivery and delegation are streamed.

The renderer currently waits 300 ms without a new transcript delta for delegated
requests and has a 1,000 ms fallback. A separate executable replay of the actual
transcript collector also showed prefix consumption and timestamp-based exclusion
of a trailing fragment. Live audio confirms the externally visible early-submission
failure; it does not isolate which timer or provider event fired in each trial.

The correction must preserve a continuing utterance through delegation and fallback,
keep late qualifiers attached, and retain explicit stop/interruption behavior.
Repeat these clips after the correction and add delayed transcript/delegation
regressions. Do not treat a complete UI transcript as proof of a complete backend
request or mark the full-screen live demo ready on this evidence.

Private WAV fixtures and backend records are stored under the local review folder
`2026-09-16-nova-audio`, outside the repository. No tenant identifiers or raw result
lists are included in this report. Nova was stopped, microphone consent reset by
the app, and full-screen mode retained after testing. Runtime source was unchanged.

## Follow-up correction

Source now gives both delegation and fallback the same microphone/transcript gate,
retains words beyond the original delegation timestamp, and preserves pending
utterances across mm-hmm/okay. Ordinary requests use 650 ms transcript settlement
and 1,000 ms microphone quiet, with 2,500 ms for apparently unfinished clauses.
This honors the user's preference for fast replies over a blanket two-second delay.
The microphone check is an amplitude heuristic, not an authoritative speech detector.

The later reported stage greeting is also a regression case: stage context and
“I want you to say hello to them” remain conversational and preserve running tasks
and unapproved previews. An appended tenant question or app action must still route
normally. Renderer tests exercise the real event handler with controlled timestamps,
microphone samples, pauses, duplicate/late delegation, immediate Stop and cleanup.
Host tests preserve investigation and approval state across greetings.

The six live trials above describe the old installed runtime. They are not evidence
that the new code passes audio acceptance. Repeating them on the corrected desktop
remains a separate gate.

Local validation: full workspace tests passed, including 130 renderer tests;
typecheck, desktop build, docs check and QA passed (181 pass, 4 warn, 0 fail).
The timing policy is application-owned: [Live client delegation](https://developers.openai.com/api/docs/guides/live-delegation)
requires the app to maintain transcript context, and the [official evaluation guide](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation)
notes the absence of authoritative turn/audio-done events. No Realtime-only VAD
configuration was added to the Live session protocol.


## Corrected signed build: quiet-room retest

Installed runtime `3e251b0`, packaging run `35063781806`, tested through the same
QuickTime speaker-to-built-in-microphone path with Nova full screen. An earlier
trial was inconclusive because competing speech entered the microphone. After the
user confirmed quiet surroundings, a new session began at 10:22 UTC.

| Clip | Backend request time (UTC) | Outcome |
| --- | --- | --- |
| 1,400 ms pause | 10:22:59 | Complete Windows encryption question; three Windows matches. |
| Late platform, 800 ms pause | 10:23:45 | Complete request including `on Windows`; three Windows matches. |
| Stage greeting | Between 10:24 and 10:25 | Both user sentences appeared in the transcript. Nova greeted the audience, then app task routing returned an unwanted clarification. **Fail.** |
| Normal, after greeting | 10:25:27 | Complete request; three Windows matches; normal task routing still worked. |
| Fast, 245 wpm | 10:26:26 | Complete request; three Windows matches. |
| 350 ms pause | 10:27:18 | Complete request; three Windows matches. Output transcript contained a Georgian word inside the English answer. |
| 800 ms pause | 10:28:22 | Complete request; three Windows matches. Same output-language anomaly. |

Read-only Chat records confirm six complete user requests and six completed
answers. No shortened prefix, all-platform count, or replaced-question activity
was observed in these six trials. Each clip was played once. This establishes
complete-request acceptance for these cases, not unrestricted audio quality.
The snapshot used by the answers was refreshed at 07:47 UTC and contained nine
managed devices. Nova was stopped after the final answer; microphone consent reset.

Follow-up code review reproduced a remaining fragment-grouping gap: a brief spoken
`Hi folks` or `Oh, hello everyone` between user fragments splits an unconsumed
sentence. This is consistent with the visible greeting failure; raw Live event
timings were not recorded, so it is not proof of that trial's exact event order.
Regression tests now retain pending input across these brief audience greetings,
avoid an extra supplied greeting, and preserve the next tenant question. Full
answers still separate turns. Audience instructions apply only to that turn.
Speech instructions now ask for the current request's language without mixed
translations; this is model guidance, not a guarantee of audio-language accuracy.
The follow-up fix still requires installed-build audio acceptance.


## Second signed build: repeated timing failure

Runtime `575febf`, packaging `35085627357`, passed all CI and signing checks and
was installed after backups. The 10:49 UTC microphone session used the same setup.
The stage greeting preserved both user sentences, greeted the audience and produced
no backend Chat records or UI task activity. Nova repeated greeting wording.

The next 1,400 ms pause clip failed: Chat received only `Which Windows devices`
at 10:51:43.422 UTC. The UI later showed the complete sentence, `Question replaced`
and an app clarification. This prefix lacked even the verb `are`, so the existing
unfinished-ending check did not recognize it. The microphone session was stopped.
These results show why a single passing trial is insufficient.

A further correction treats `which`/`what` question prefixes without a recognized
predicate as unfinished. Complete encryption questions and `How many` counts keep
the ordinary short delay; the existing 2,500 ms allowance applies to the prefix.
A renderer regression now exercises delegation before the verb arrives. Longer
spoken introductions count as already-greeted responses, avoiding another supplied
greeting. These remain bounded heuristics and require repeated installed audio tests.

Code review also found that microphone activity sampling depended on the orb's
animation frames. A session-scoped sampler now runs independently every 50 ms and
at dispatch, with cleanup on Stop. The renderer regression delivers no animation
frames while testing microphone activity and late qualifiers. This removes the
visual-frame dependency; event-loop delays and audio recognition remain limitations.
The live trial did not record frame delivery, so this finding is not claimed as
its verified cause.
