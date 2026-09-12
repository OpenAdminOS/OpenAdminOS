# Cache and Nova

## Prepare your tenant cache

Open **Cache** in the sidebar. All supported resources are selected by default.
Choose **Preload all** to collect every page of each selected resource, including
available log history. You can deselect resource types or search the list. Search
and **Needs attention** filter the list without changing your selections.

The page shows resource counts, collected pages, snapshot timestamps, required
read permissions and refresh errors. **Retry incomplete** retries selected resources
that are missing, partial or failed. **Cancel refresh** stops new requests and keeps
previous complete snapshots for unfinished collections. Resources that already
finished remain updated.

“All” means the app's supported resource catalogue. It does not include every
Microsoft Graph endpoint, property, relationship or action. Microsoft retention,
licensing and permissions determine what is available. Collection limits and
failures are shown explicitly. A fresh cache does not imply a recent device check-in.

Automatic refresh preloads all supported resources while the app is running, this
device is awake and the tenant is signed in. Choose an hourly, six-hourly or daily
schedule. The cache is shared with Chat and Agent Team.

## Talk to Nova

Nova knows the selected tenant before you preload anything. For device and other
tenant questions it asks the app to retrieve missing or stale relevant data.
An empty cache does not mean there are no devices. Permission failures and partial
coverage still need to be resolved through the tenant connection and Cache page.

Voice and reasoning have separate setup. The OpenAI key enables hosted speech and public web research;
tenant answers use the reasoning provider and model shown in Nova. Connect that
provider in Settings. Local voice needs a local reasoning model plus Whisper for
recognition and Kokoro for speech output. Use **Check voice setup** to check key/model
access or local service availability. Starting hosted voice separately checks the
actual Live connection and billing, so a restricted key need not allow model listing.

Large cache collections stay in the local database. Nova gets selected evidence and
short answers, with full results available through **Open evidence in Chat**.
Preload before a presentation to reduce retrieval time; it is not required for Nova
to recognize your tenant. Basic device counts, reported encryption and OS-version
summaries come directly from the snapshot, avoiding a model round trip. More complex
questions use the selected reasoning model. Freshness and partial coverage remain
visible in the answer.

Nova carries recent conversation context into follow-up questions. If a question
needs too much context, narrow it or continue in Chat. Stop cancels pending tenant
work as well as audio; a new delegated question replaces the previous pending one.
Changing the reasoning model or its local/hosted status ends the voice session.

Use **Full screen** to fill the app window with Nova. During a conversation, only
the animated orb remains after three seconds without interaction. Move the pointer,
tap the view or use the keyboard to reveal the controls. Captions start hidden in
this view and can be enabled independently. **Exit full screen** returns to the
compact panel without interrupting the conversation. Setup and errors stay visible;
**Escape** still ends the session. **Mute mic**
keeps the conversation connected while disabling microphone audio; **Stop** ends
the session and releases the microphone. Captions can be hidden independently.
The orb responds to microphone and hosted playback audio, with distinct waiting
and speaking states. Reduced-motion settings disable animated movement.
Open **Voice settings** while idle to change providers or the greeting name.

Choose **Talk to Nova** from any app page, or press **Alt+V**. Choose your voice
provider, select a tenant, and click the orb to start the microphone. The orb
responds to your voice volume; captions show the conversation. **Stop**, **Escape**,
closing the panel or changing the tenant/provider ends the session. Backgrounding
the app also stops microphone use.

You can say “Hey Nova” during a running session. Set a greeting name in the panel.
The app does not listen for a wake word in the background.

Ask about your tenant or say “Open Cache”, “Open Agent Team” or “Open Settings”.
Tenant questions use the existing Chat tools and the active agent model. Preload
Cache before asking questions that need broad coverage. Open **evidence in Chat**
to inspect the answer and its sources. Missing data is not proof of a healthy state.
Voice does not approve or execute tenant writes; use the existing visual review.

### OpenAI voice

Choose **OpenAI · GPT-Live-1**, enter your API key and choose **Save key**. The key
is kept in OS-secured storage. GPT-Live API access and billing are separate from
ChatGPT or Codex CLI subscriptions.

Before starting, acknowledge that audio, shared tenant answers and public research
queries are sent to OpenAI. The agent model may use a different provider; its normal hosted-context
consent also applies. A local agent model does not make OpenAI voice local.
Remove the saved key from the panel whenever you no longer need it.

If the connection fails, check API access, billing, network access and microphone
permissions. On macOS, allow OpenAdminOS under Privacy & Security → Microphone.

### Public web research

In OpenAI Voice, Nova can choose tenant data, public web research, or both for a
question. For example, ask about your device versions and compare them with current
vendor guidance, or ask about a recent product announcement. This is general web
research, not a predefined OS lookup. Simple tenant counts still use your cache
without a paid search. Natural requests such as “What are the currently installed
OS versions on my devices?” and “What is the encryption status of my devices?”
also skip the reasoning-model round trip. Speech recognition and voice generation
still add latency; cache access is only one part of response time.

The selected reasoning model decides when to search. Public research uses OpenAI's
Responses API and GPT-4.1 mini with the same saved Nova key. Your API project needs
access to that model and Responses; search and model usage incur API charges.
Use a reasoning model capable of tool use. Nova uses its investigation loop for
hosted research regardless of Chat's separate investigation preference.

Open **evidence in Chat** for clickable public sources and **What ran** for search
queries, timing and failures. Public sources describe external facts, not your
tenant's state. Missing or failed search evidence is reported explicitly. Each
question permits up to three searches; narrow the question if research exceeds
that limit or the voice context budget. Stop cancels pending research.

Research queries should contain public product names and versions, not tenant
names, user details, device identifiers or credentials. The app sends the research
query, rather than the full cache, to OpenAI. Local voice and ordinary typed Chat
do not use this hosted search capability.

### Local voice

Choose **Local · whisper.cpp + Kokoro**, and select a local agent provider such as
Ollama. Local voice uses two separately installed speech services:

- [whisper.cpp server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server),
  listening on `127.0.0.1:8080`, with a downloaded transcription model.
- [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), listening on
  `127.0.0.1:8880`, with the `kokoro` model and `af_heart` voice available.

Follow those projects' installation instructions for your operating system.
OpenAdminOS connects to these services; it does not bundle or install their
runtimes or models. Keep them bound to loopback. Model downloads need internet
access during setup; local voice itself has no automatic cloud fallback.

Click the orb, speak, then choose **Finish speaking**. A recording is limited to
one minute. Nova transcribes it locally, asks your local agent model, and speaks
the result locally. If a service is unavailable, the panel reports the error so
you can start that service and retry.
