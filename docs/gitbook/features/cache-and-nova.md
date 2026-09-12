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
Greetings, jokes and “still there?” do not replace a pending tenant investigation.
Nova keeps the current question separate from earlier spoken turns.
Changing the reasoning model or its local/hosted status ends the voice session.

Use **Full screen** to fill the app window with Nova. During a conversation, only
the animated orb remains after three seconds without interaction. Move the pointer,
tap the view or use the keyboard to reveal the controls. Enable **Conversation**
to see your words and Nova’s replies in chat bubbles, with live updates for cache
reads, tenant queries, web research and answer preparation. The panel appears on
the right in wide windows and below the orb in narrow windows. It starts hidden
and remembers your preference between compact and full-window views. **Exit full screen** returns to the
compact panel without interrupting the conversation. Setup and errors stay visible;
**Escape** still ends the session. **Mute mic**
keeps the conversation connected while disabling microphone audio; **Stop** ends
the session and releases the microphone. Hiding **Conversation** leaves audio
running. Activity cards distinguish finished answers, failures, stopped sessions
and questions replaced by a new request. Expand **View result** for the backend
answer, or use **Open evidence** for the full Chat record.
The orb responds to microphone and hosted playback audio, with distinct waiting
and speaking states. Reduced-motion settings disable animated movement.
Open **Voice settings** while idle to change providers or the greeting name.

Choose **Talk to Nova** from any app page, or press **Alt+V**. Choose your voice
provider, select a tenant, and click the orb to start the microphone. The orb
responds to your voice volume; the optional panel lets you follow the conversation. **Stop**, **Escape**,
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
Responses API and GPT-5.4 mini with the same saved Nova key. Your API project needs
access to that model and Responses; search and model usage incur API charges.
Use a reasoning model capable of tool use. Nova uses its investigation loop for
hosted research regardless of Chat's separate investigation preference.

Open **evidence in Chat** for clickable public sources and **What ran** for search
queries, timing and failures. Public sources describe external facts, not your
tenant's state. Missing or failed search evidence is reported explicitly. Each
question permits up to three searches; narrow the question if research exceeds
that limit or the voice context budget. A failed answer shows a recovery message;
OpenAI Voice stays connected so you can retry or ask another question. Open Chat to
inspect the failed investigation. Stop cancels pending research.

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

## Send a result or start an agent

After Nova completes an answer, try “Send this to my WhatsApp,” “Email this to me,”
or “Send the report via Teams.” WhatsApp, Outlook/Exchange email, Teams, Slack,
Discord and Signal use the connectors configured in **Connectors**. WhatsApp self
messages go to the linked account; email to yourself uses the connected tenant
account. Other requests use the connector's saved destination. Personal Teams
messages require an explicit configured chat destination.

Nova displays the full message and destination before sending. Check both and click
**Confirm send**, or cancel. Speaking “yes” does not approve a send. The preview
expires after five minutes, and changing tenant or interrupting invalidates it.
Nova reports whether the connector accepted the message; acceptance does not prove
that the recipient received it. Do not retry an uncertain send until you check the
destination. Sending through a connector shares the reviewed content even when
local voice is selected.

Say “Run” followed by an installed agent's name to prepare an agent launch. Review
the tenant and click **Confirm run**. Follow the run in Activity. Write plans still
require their normal approval; existing saved delivery routes remain in effect.

## Understand device answers

Fleet lists use reported Intune device fields, with snapshot time and incomplete
coverage disclosed. Missing encryption data is unknown, not unencrypted. Lists show
up to 50 matching devices. For fleet questions about why devices are non-compliant,
Nova reads actual failed compliance policy settings for up to ten matching devices.
It reports remaining or unavailable details explicitly. A non-compliant status alone
does not explain its cause. Policy details require the connected account to have
permission to read device configuration.

In hosted voice, say **Stop** or click **Stop answer** to silence the current response
and cancel pending investigation while leaving the microphone available. Click
**Stop** to end the session. **Result retrieved** means the backend lookup is complete;
it does not mean every word has been spoken. Local voice remains a recording-based
flow and does not listen continuously while playing its answer.


### Ask for a report and send it in one request

You can say “Send me an email with the list of non-compliant devices.” Nova retrieves
the relevant report, then displays its content and destination for review. It does
not send anything until you click **Confirm send**. You do not need to ask for the
list separately first.

| Connector | Setup in Connectors | Example after retrieving a result |
| --- | --- | --- |
| WhatsApp | Link the account with QR and choose a target | “Send this to my WhatsApp” |
| Outlook / Exchange email | Connect the tenant, set recipients and test consent | “Email this to me” |
| Teams | Choose the team and channel, then test consent | “Send this via Teams” |
| Slack | Add the bot token, choose a destination and test | “Send this via Slack” |
| Discord | Add the channel webhook and test | “Send this via Discord” |
| Signal | Configure the account, recipient and local bridge or signal-cli, then test | “Send this via Signal” |

“My WhatsApp” uses your linked account; “my email” uses your active tenant account.
A configured Teams channel is shared with its members. It is not a private chat with
you. Nova explains this when you ask for a personal Teams message; say “Send this via
Teams” to review the configured channel. Slack, Discord and Signal defaults likewise
do not establish which destination is personally yours. Always check the destination
shown in the preview.

Nova checks connector setup and gives the relevant recovery steps. Long reports may
need several numbered messages; the preview states how many before you confirm.
If delivery stops partway through, Nova reports how many messages were confirmed
accepted and stops the rest. It does not retry automatically. Check the destination
before repeating an uncertain send.

### Read formatted answers

The **Conversation** panel displays lists, bold and italic text, headings, tables,
quotes, links and code blocks. Expand **View result** to read the full retrieved
answer while Nova speaks a shorter summary. Message previews use the same formatting.
The full visual answer stays in the app rather than being added to the speech
model's context automatically. Raw HTML and executable links are not rendered.
