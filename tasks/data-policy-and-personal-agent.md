# Data policy, personal agent and confidential inference (planned 2026-11-18)

Three features that share one idea: the admin decides what the assistant is,
what it may reach, and where each piece of tenant data may go. Team features
built on top of them are planned separately.

**Decisions (Ugur, 2026-11-18)**
- Our own engine, not Purview. It runs on the device, works offline and with local
  models, covers every connector, and classifies data at arrival rather than
  after the fact, so it does not depend on Purview.
- Names: **data classes** for the tags, **Data policy** for the feature and its
  settings page, **Masking** for replacing identities with tokens before a hosted
  call.
- Personal agent: the admin's own named agent that takes instructions, learns,
  and is configured with access to MCP servers, skills and connectors.
- Scope: all of it, each phase with user docs, a SPEC section and a CHANGELOG line.
- Default rules: mask on hosted, as in the table below.
- Hosted voice: the voice model speaks roles ("the user", "the device") where a
  value is masked, and the text transcript shows real values for the
  reversible placeholders only (identity, device and security names and
  identifiers, as in A4). Round 4 of
  the design review refined which tenant data is masked: voice context follows
  the data policy rules like any hosted call. Spoken input is covered by the
  decision of 2026-11-19 below.
- Skills use the open SKILL.md format, with import and export.
- Proactive work: recurring read-only checks and a daily brief per organization,
  each confirmed on a card and capped.

**Decisions (Ugur, 2026-11-18, design review of mockups 34 and 35)**
- Field reclassification in Settings only moves a field to a class higher in
  the order. On every tier the reclassified field applies the strictest action
  of every class it has ever held, its mapped class and every later pick (as
  corrected in round 4), so a reclassification can never weaken any tier,
  including against IT-set rules: a configuration value covered by an
  IT Mask rule stays masked after moving to Security, even though Security
  normally leaves setting values readable. The classify dialog and the field
  list show the applied coverage per tier, and after a change the list shows
  the new class as current with every lower class disabled. A less sensitive class comes
  only from the IT policy file, where it replaces the app's mapping for the
  field. Value detectors still raise the class of a value that looks more
  sensitive, and a setting on the device never loosens an IT-locked rule.
- Loosening any rule waits for a confirmation dialog; tightening applies at once.
  A reset that both tightens and loosens applies nothing until the admin
  accepts the dialog. The status strip and the preview are derived from the
  effective rules.
- Remote MCP servers (decided on the maintainer's lead, round 3): be honest
  about the boundary. A remote reference server receives a query written from
  the admin's question with every value the app recognizes as tenant data
  removed. Text the app cannot recognize, such as an internal project name,
  can still reach the server. The status strip names the host whenever such
  tools are offered, and the admin can turn a server off.
- User-added MCP servers: the first version allows only tools the admin
  approves as read-only at add time. The tool's read-only annotation is shown
  but not trusted on its own, a tool annotated as a change cannot be approved,
  the approval is enforced at every call (including calls from skills and
  scheduled checks), and a tool that is not approved is never offered.
- Skills never use send tools. A send tool named in a skill is kept in the file
  and marked unavailable to skills, whatever the grants.
- Every connector send is proposed by the agent on a card and confirmed message
  by message.
- The daily brief does not count against the 5 recurring checks.
- Checks run only for the active, connected organization while the app is open.
  Skipped and missed runs are listed with the reason, never caught up silently.
  Turning on the brief and restarting checks after a reconnect each need a
  confirmation card.
- Placeholders are typed, numbered brackets (`[USER_1]`, `[DEVICE_1]`,
  `[CREDENTIAL]`). Masking counts are values, labelled as values. The
  Confidential column shows "No provider qualifies yet" until attestation
  exists. Block stays available on Local.
- Agent names are 1 to 24 characters of letters, digits, spaces and hyphens;
  names that read as OpenAdminOS or Microsoft are refused. New policy keys keep
  the `nova` prefix. SKILL.md `allowed-tools` is the standard space-delimited
  list of tool ids: `graph_get`, MCP tools as `mcp__<server>__<tool>`, agents
  by their slug. Resource selectors (which Graph resources a skill reads) go
  in the instructions and in namespaced `metadata`
  (`openadminos-graph-resources`), and the app limits `graph_get` to them.
- A check skipped because its organization was not active runs at the next
  scheduled time when that organization is active and its services are
  connected. It is never replayed on an organization switch.

**Decisions (Ugur, 2026-11-18, round 3 of the design review)**
- A seventh data class, `security`, between `identity` and `device`. It covers
  Conditional Access policies and named locations, authentication methods,
  security defaults, security baselines and endpoint security policies, admin
  role definitions and assignments, PIM, cross-tenant access and identity
  protection policies. Masking a security object replaces its names and
  identifiers (policy names, named locations, IP ranges, excluded users and
  groups, role names); setting values stay readable.
- Classification uses a request ledger. Values are classified by field when
  they arrive and registered for the run or Chat conversation, in memory only.
  Just before each model call, the final request (system text plus prompt,
  including the admin's own words) is scanned against those values and the
  detectors, at the one place every provider call is built. Routing and
  masking act on that scan. Text or fields the scan cannot examine within its
  work budget are counted as unexamined, with `credential` as their effective
  class, and the scan reports that the budget ran out. Their action on a tier
  is the strictest action of any class on that tier (round 4).
- The credential promise, in every place it appears: values the app
  recognizes as credentials never reach a hosted model in clear text. A secret
  written into a free-text field in a form the app does not recognize can
  still be sent. On Confidential, `credential` defaults to Mask; Allow is
  possible only after the confirmation dialog, and IT can lock it.

**Decisions (Ugur, 2026-11-19, hosted voice and session start)**
- Hosted voice is honest about its boundary. What the admin says aloud goes to
  the hosted voice provider as audio and is not gated by data policy. The
  hosted voice strip says so ("hears what you say"), and so do the data policy
  notes and docs. Voice on this device is the way to keep spoken words under
  data policy: the words are transcribed on the device, then the text goes
  through the same request scan as a typed question before any hosted
  reasoning call.
- When a rule blocks a class carried by the voice session start request, the
  session opens without the whole profile block (not per note), consistent
  with how other transfers are withheld.

**Decisions (Ugur, 2026-11-19, round 4 of the design review)**
- Confirmations that loosen `security` name what masking replaces (policy
  names, named locations, IP ranges, excluded users and groups, role names)
  and state that setting values go to the hosted model in clear text.
- The status strip names a blocked `credential` like any other blocked class,
  picks its long or short form by the space it has, and opens a popover that
  lists the effective rule for every class.
- A blocked request offers only models whose tier permits every class in the
  request. When every applicable rule is locked by IT, the block names the
  rule owner (policy file and keys) instead of offering a switch or a change.

**Review findings adopted (2026-11-19, round 4 of the design review)**
- Successive reclassifications: a field's effective action per tier is the
  strictest across every class it has ever held, its mapped class and every
  later pick, never only the original and the latest. A field moved from
  `configuration` to `security` to `identity`, with Security on Hosted set to
  Block, stays Blocked on Hosted.
- Voice context: tenant data the app sends to the hosted voice model goes
  through the same request scan and follows the same rules as any hosted call,
  class by class; it is not all masked. The hosted voice strip is derived from
  the live rules like the other strips ("Hosted voice · OpenAI · hears what you
  say · identities, security names and devices masked" with the defaults). When
  a rule blocks a context transfer, the voice session continues without that
  context and says what was withheld.
- Unexamined content: evidence the scan could not examine is reported as
  `credential`, and its action on a tier is the strictest action of any class
  on that tier, so a Block anywhere on the tier withholds the call. The
  withheld call has a designed recovery: a smaller question, or a local model
  when no Local rule is Block.
- Credential Block to Mask has its own text in the direct-change and reset
  dialogs: calls that were blocked can now leave the device, recognized
  credentials are replaced one way, and a secret in free text in a form the app
  does not recognize may still be sent.
- MCP tool review: approval requires a read-only annotation and no documented
  write behavior. The app flags tools whose description describes saving,
  changing, sending or deleting (such as an `export_report` that saves a
  report on the server), and a flagged tool cannot be approved in any review
  state, whatever its annotation.
- Access: a granted tool is offered and callable only while the service it
  uses is connected in the active organization. Access shows the missing
  service with its recovery (connect the service, or switch organization), and
  the grant itself stays on.

**Review findings adopted (2026-11-19, round 5 of the design review)**
- Hosted voice popover: the live voice strip in Settings opens a popover built
  from the current rules by the same function as every other strip. A voice
  strip names a blocked class as withheld context ("security context
  withheld"), not as blocked. The withheld notice and its recovery come from
  the decision on one context transfer (what it carried, which rule withheld
  it), never from the configured rules alone, and the recovery follows the
  same test as a blocked prompt.
- MCP tool definitions: an approval belongs to the exact definition the admin
  saw. Any change to an approved tool's description, input schema,
  annotations or name under the same id invalidates the approval before the
  tool can be offered or called; the tool returns to review, and a change that
  now describes saving, changing, sending or deleting makes it unapprovable.
- Access: a granted skill is offered only when every grant it uses (for
  example Microsoft 365 Read) is on and every service it reads is connected in
  the active organization. The recovery names which one needs attention: turn
  the grant on, or connect the service.
- Remote endpoints: Ollama or LM Studio at an address on another machine is
  Hosted, with the destination host named in the status strip, Connections
  and Chat.
- Local masking: when a Local rule is Mask, a local answer shows the masked
  value counts with copy that says masking happened on this device before the
  local model saw the data.

**Review findings adopted (2026-11-19, round 6 of the design review)**
- Voice transfers keep their recorded decision. Each context transfer records
  what happened under the rules in force when it was sent; changing a rule
  later never rewrites a past transfer's outcome. The rules in force now drive
  only the strip, a preview labelled "Next transfer under current rules", and
  the recovery for withheld context.
- The session start request of hosted voice (the profile block with standing
  instructions and confirmed notes that `nova.ts` sends when the OpenAI session
  opens) goes through the same request scan and rules as later context
  transfers and is listed as its own transfer. The spoken-audio boundary is
  unchanged.
- Rehydration restores only reversible placeholders (identity, device and
  security names and identifiers). Credential placeholders are one way and
  stay masked in the answer, the transcript and tool parameters.
- The status strip names an MCP host from the tools actually offered, not from
  the server switch. When every approved tool on an enabled server is back in
  review, the grant stays on, the host is left out of the strip, and the
  popover says why.
- A connector send shows a confirmation card with the exact message text, the
  destination (for Teams, the team and channel), the organization, Confirm
  and Cancel, and a note that every message is confirmed on its own.

**Review findings adopted (2026-11-19, round 7 of the design review)**
- Voice recovery is computed from the decision the rules in force now make on
  the whole withheld transfer, every class it carries, never from the class
  that withheld it. When Security moves from Block to Mask while
  Configuration, also carried by the 09:43 transfer, moves to Block, the
  transfer would still be withheld, so the notice offers no Ask again. The
  recorded outcome stays as it was.
- Only identity, device and security names and identifiers are restored on
  the way back. Activity and configuration placeholders, when those classes
  are masked, stay masked like credential ones in the answer, the transcript
  and tool parameters.
- Decided by Ugur on 2026-11-19: when a rule blocks a class the session start
  carries, the whole profile block is withheld, not only the notes that carry
  it. The withheld session start says the call opened without the profile.

**Review findings adopted (2026-11-19, round 10 of the design review)**
- MCP tool review: the admin approves the full definition, which every row
  shows when expanded (name, title, description, every parameter with type
  and description, output description, annotations). The write check reads
  every text field of it, including the title and enum values, and approval
  is bound to a SHA-256 hash of the whole definition, so any change in any
  field invalidates it (B5).
- A connector send rechecks the send grant and the connection for the
  organization on the card at Confirm; when either is missing the card reads
  "Not sent" with the reason and the fix, never "posted" (B3).
- The planning call is described as "Your question, checked by data policy"
  and records what the request scan did with the admin's own words, such as
  a typed user name masked as `[USER_1]`.
- Unexamined content takes the strictest action on its tier on Confidential
  too: with Credential Allow there (after confirmation) and Identity Block,
  a call whose scan ran out of budget is withheld, with a smaller question
  or a local model as the recovery.

**Review findings adopted (2026-11-19, round 11 of the design review)**
- MCP approval binds to the complete tool object the server lists, not a
  projection: the readable view and the raw JSON of the whole object, a
  write check over every string in it (keys and annotations included), and
  a SHA-256 hash of its canonical form (RFC 8785). Approval needs a positive
  `readOnlyHint: true` (B5).
- Teams Confirm also rechecks that the organization on the card is still
  active. Every outgoing post has its own confirmation: a message over the
  Teams limit is not split; the card offers a shorter summary on a new card
  or saving the full report locally (B3).
- Adding a server by URL has a designed step 1: URL, authentication with
  secrets in the keychain, the IT allowlist check with its refusal, and the
  disclosure of what the server receives (B5).

## Why

Today the choice is binary. With a local model the request never leaves the
device; with a hosted model the whole request, tenant data included, goes to
the provider. Data policy adds a middle path:
the rules decide which values a hosted model receives as is, which are masked
and which are withheld. Identities the app recognizes can be masked, while
configuration values and names the app does not recognize, such as a person
typed for the first time, may still be sent. Values the app recognizes as
credentials never reach a hosted model in clear text. Purview cannot do this for us because it
sees opaque text after the fact; we know the shape of every response at the
moment it arrives.

## What the code has today (explored 2026-11-18, main at 6dc77828)

- Every model call goes through `RunLlmApi` (`packages/agent-sdk/src/index.ts`),
  and every adapter is built in `AppStateStore.buildLlm` (`apps/desktop/electron/state.ts`),
  where the provider id is known. Prompts are flat strings.
- `fenceTenantData` (`packages/runtime/src/tenant-data.ts`) wraps almost all tenant
  content with a source label before it is stringified. It is the place to attach
  classes. `withTenantDataOutputFilter` is the model for streaming rehydration.
- Wrappers already stack around the model (`tenantLlm`, `gateHostedLlm`,
  `withTenantDataOutputFilter`, `withSelfTrainingOverlay`, `wrapLlmWithThinking`).
- Locality is one boolean, `ProviderSummary.isLocal`. `deriveDataBoundary`
  (`apps/desktop/src/state/data-boundary.tsx`) decides what the status strip says.
- `GRAPH_CACHE_RESOURCES` (45 resources) is the only per-endpoint registry.
  `tenant-values.ts` already indexes names, labels and identifiers for egress checks.
  `PRIVATE_PATTERN` in `intune-chat/tools.ts` detects emails, GUIDs, IPs and
  credential prefixes. Nothing swaps values for tokens yet.
- Hosted Nova voice sends context from the renderer to OpenAI over the data
  channel, outside `RunLlmApi`. It needs its own gate.
- Nova: the name is hard-coded in about eight groups of prompts and copy. The
  profile and notes reach voice only, not typed Chat. MCP servers come from a
  fixed catalog and are enabled device-wide. There are no user skills and no
  learning beyond confirmed notes.
- The open sandbox stack (#196, #197, #199, #201, #202) moves `audit-log.ts` into
  `packages/runtime` and touches `graph-adapter.ts`, `runtime/src/index.ts` and
  `agent-sdk/src/index.ts`. Audit work here lands after that stack merges.

## Data classes

| Class | Examples | Order |
|---|---|---|
| `credential` | BitLocker and FileVault recovery keys, LAPS passwords, client secrets, tokens, pre-shared keys | 1, highest |
| `identity` | display names, UPNs, email addresses, phone numbers, user ids | 2 |
| `security` | Conditional Access policies and named locations, authentication methods, security defaults, security baselines and endpoint security policies, admin role definitions and assignments, PIM, cross-tenant access, identity protection policies | 3 |
| `device` | device names, serial numbers, IMEI, MAC and IP addresses, device ids | 4 |
| `activity` | sign-in times, locations, audit entries, app usage | 5 |
| `configuration` | policy names and settings, group names, app names, compliance rules | 6 |
| `public` | Microsoft Learn results, web search results, public reference MCP servers | 7, none |

The order is strict, highest first. Masking a `security` object replaces its
names and identifiers (policy names, named locations, IP ranges, excluded users
and groups, role names); its setting values stay readable.

A field nobody has classified is treated as `identity` until it is classified.
MCP results default to `identity`; allowlisted catalog references and web
search start as `public`, and text detectors can raise their class. Free text
the admin types is checked against the tenant value index, so known names and
devices are caught. Names the app has never seen cannot be detected, and the
docs say so.

Classes act through the request ledger (as in PR #209): values are classified
by field when they arrive and registered in memory for the run or Chat
conversation, and the final request is scanned against them and the detectors
just before each model call. Routing and masking act on that scan. Evidence the
scan could not examine within its budget counts as unexamined and is reported
as `credential`. Its action on a tier is the strictest action of any class on
that tier, so a Block anywhere on the tier withholds the call.

Default rules (decided 2026-11-18):

| Class | Local | Confidential | Hosted |
|---|---|---|---|
| `credential` | allow | mask | mask |
| `identity` | allow | allow | mask |
| `security` | allow | allow | mask |
| `device` | allow | allow | mask |
| `activity` | allow | allow | allow |
| `configuration` | allow | allow | allow |
| `public` | allow | allow | allow |

Actions are allow, mask and block. The admin and IT may tighten any rule and
loosen all but one: values the app recognizes as credentials never reach a
hosted model in clear text, so `credential` on Hosted has no Allow. A secret
written into a free-text field in a form the app does not recognize can still
be sent, and the docs say so. `credential` on Confidential defaults to Mask;
Allow there is possible only after the confirmation dialog, and IT can lock it.
Loosening from Settings asks for confirmation first, and never applies to a rule
IT locked; a reset that mixes tightening and loosening applies nothing until the
admin accepts. In Settings a field moves only to a class higher in the order,
and on each tier it applies the strictest action of every class it has ever
held: its mapped class and every later pick. A less sensitive class comes from
the IT policy file.

## Track A: Data policy

### Phase A0: Designs

- [ ] `docs/mockups/34-data-policy.html`: Settings > Data policy (rules table,
      IT-locked rows, defaults), status strip with masking, Chat answer note,
      run activity step, and the blocked state with recovery.
- [ ] Designed, not wireframed (see `tasks/lessons.md`), checked at desktop and
      narrow widths.

**Acceptance criteria:**
1. Every state in this track has a designed screen, including blocked and
   "could not classify".
2. Ugur has approved the mockup before Phase A3 UI work starts.

### Phase A1: Classification

- [ ] Data class type and sensitivity order in `agent-sdk`.
- [ ] Field map per Graph resource in `packages/runtime`, covering every
      `GRAPH_CACHE_RESOURCES` entry and the endpoints bundled agents read.
- [ ] Value detectors for unknown shapes and free text, built on
      `tenant-values.ts` and the existing private patterns.
- [ ] A request ledger: values are classified by field when they arrive and
      registered for the run or Chat conversation, in memory only.
- [ ] Just before each model call, the final request (system text plus
      prompt, including the admin's own words) is scanned against the ledger
      and the detectors, at the one place every provider call is built.
- [ ] When the scan runs out of its work budget, the text and fields it did not
      examine count as unexamined and are reported as `credential`, and the
      scan flags the budget exhaustion. Their action on a tier is the strictest
      action of any class on that tier, so a Block anywhere on the tier
      withholds the call.
- [ ] A reclassified field records every class it has held. Its action per
      tier is the strictest across all of them, never only the mapped class
      and the latest pick.
- [ ] Fenced tenant content carries its classes and counts.
- [ ] Field names verified against real responses in the lab tenant with Lokka.

**Acceptance criteria:**
1. Each bundled agent and each cache resource yields classified content, with a
   test per resource.
2. A BitLocker key, a LAPS password and a client secret are classed
   `credential` from both a structured response and free text.
3. A Conditional Access policy, a named location and a role assignment are
   classed `security`, and a value from the ledger typed back by the admin is
   found by the scan of the final request.
4. An unmapped field is classed `identity`, and a test proves it.
5. A reclassified field keeps the strictest coverage of every class it has
   held on every tier, including against an IT-locked rule: a configuration
   value under an IT Mask rule stays fully masked after moving to `security`
   (test).
6. Two successive moves (regression test): a field mapped as `configuration`,
   moved to `security`, then to `identity`, with Security on Hosted set to
   Block, is Blocked on Hosted. A calculation from only the mapped class and
   the latest pick would give Mask, and the test fails on it.
7. A scan that exhausts its budget reports the unexamined data as `credential`
   (test).
8. Unexamined data takes the strictest action of any class on the tier
   (test, the Confidential case): Credential on Confidential set to Allow
   after the confirmation dialog, Identity on Confidential set to Block, and a
   request with an unexamined tail. The call is withheld, although the
   credential rule alone would allow it.
9. Every field mapping was checked against a live Graph response in the lab
   tenant, and the record lists the calls.

### Phase A2: Provider tiers

- [ ] `dataTier: "local" | "confidential" | "hosted"` on `ProviderSummary`,
      replacing reads of `isLocal` where the tier matters.
- [ ] `deriveDataBoundary` and trust copy gain the confidential variant.
- [ ] No provider is `confidential` until Track C verifies attestation. Azure
      OpenAI stays `hosted`.

**Acceptance criteria:**
1. Status strip, Connections and Chat agree on the tier for all eight providers
   (renderer test).
2. Ollama or LM Studio on a remote endpoint reports `hosted`, and the status
   strip, Connections and Chat name the destination host in the same words
   (mockup 34, B, "Ollama on another machine"). An address counts as this
   device only when it resolves to this machine: localhost, a loopback
   address or a local socket.

### Phase A3: Routing and blocked states

- [ ] Routing acts on the scan of the final request: a data policy decorator
      applied in `buildLlm`, so agent runs, Chat, Office, drafts, follow-ups
      and the Nova command all pass through it.
- [ ] Hosted voice gets its own gate in `nova.ts` and the renderer for tenant
      data the app sends to the voice model as context: it goes through the
      same request scan and follows the same rules as any hosted call, class
      by class (masked, blocked or sent as is). The first transfer is the
      session start request: the profile block with standing instructions and
      confirmed notes that `nova.ts` sends when the OpenAI session opens goes
      through the same scan and rules as every later context transfer, and the
      voice popover lists it as its own transfer. When a rule blocks a class
      it carries, the session opens without the whole profile block (decided
      2026-11-19), and the voice model, the transcript and the popover say the
      call opened without the profile. The voice model speaks roles
      where a value is masked, and the transcript restores only reversible
      placeholders (identity, device and security names and identifiers, the
      A4 rule); activity, configuration and credential placeholders stay
      masked in the transcript. When a
      rule blocks a context transfer, the session continues without that
      context and the voice model and the transcript say what was withheld.
      The hosted voice strip and its popover are derived from the live rules
      like the other strips, and the live strip in Settings opens that
      popover; a blocked class reads as withheld context ("security context
      withheld"). Each transfer records the decision made under the rules in
      force when it was sent (sent, masked with its count, or withheld, and
      what the voice model said), and the popover shows past transfers from
      that record: changing a rule later never rewrites a past transfer's
      outcome. The rules in force now drive only the strip, a preview labelled
      "Next transfer under current rules", and the recovery for withheld
      context. The withheld notice names the transfer, what it carried and the
      rule that withheld it, from the record; its recovery is evaluated
      against the current rules by the same test as a blocked prompt, on the
      decision the current rules make for the entire transfer (every class it
      carries, not only the class that withheld it), and offers Ask again only
      when that decision would send the context (mockup 34, A and B). What the admin says aloud goes to the hosted
      voice provider as audio and is not gated (decided 2026-11-19); the hosted voice strip ("hears what you say"), the Data
      policy settings and the docs say so. Voice on this device keeps
      spoken words under data policy: they are transcribed on the device and
      the text goes through the same request scan before any hosted reasoning
      call.
- [ ] Settings > Data policy and a managed configuration key `dataPolicy`
      (schema, parser, record sanitizer, audit mapping, both docs copies).
      Credential Block to Mask has its own text in the direct-change and reset
      dialogs: calls that were blocked can now leave the device, recognized
      credentials are replaced one way, and a secret in free text in a form
      the app does not recognize may still be sent.
- [ ] A call withheld because part of the request could not be examined has a
      designed state (mockup 34, F) that suggests a smaller question, and a
      local model only when no Local rule is Block.
- [ ] Agent manifests declare `descriptor.dataClasses`, derived when absent, with
      a qa-graph check and the JSON Schema updated in the same commit. Agent
      details show what an agent reads. Preflight refuses a run the policy would
      block, with a designed state.
- [ ] The sandbox host applies the same engine.

**Acceptance criteria:**
1. A test per path (agent run, Chat deterministic, Chat streaming, agentic loop,
   Office, follow-up) shows a blocked class never reaches the model.
2. A test proves voice context goes through the same request scan and rules
   as a hosted call: a masked class reaches the voice model as tokens, an
   allowed class as is, and a blocked class is withheld while the session
   continues and says what was withheld. The docs and the hosted voice strip
   state that spoken input is not gated in hosted voice; a renderer test
   asserts that the strip copy is derived from the rules.
   With Security on Hosted set to Block, a transfer of Conditional Access
   policies is withheld, the voice strip reads "security context withheld",
   and the popover names that transfer and offers a local model only when no
   Local rule blocks a class it carried (renderer test).
   A transfer sent under the defaults (6 Conditional Access policies, "Sent,
   10 values masked") still reads so after Security on Hosted is set to
   Block, while the next-transfer preview reads withheld; a transfer withheld
   under Block still reads withheld after the rule returns to Mask, and its
   recovery offers Ask again (renderer test).
   The 09:43 transfer carries Security and Configuration and was withheld with
   Security on Hosted at Block. When Security moves to Mask and Configuration
   on Hosted moves to Block, the transfer still reads withheld by Security, the
   next-transfer preview reads withheld by Configuration, and the recovery
   offers no Ask again (renderer test).
3. A test inspects the session start request `nova.ts` sends when the OpenAI
   session opens and shows that a recognized recovery key in a confirmed note
   is masked one way as `[CREDENTIAL]` with Credential on Hosted at Mask.
   With Credential on Hosted at Block the whole profile block is withheld, the
   session opens without it, and the popover says the call opened without the
   profile. The voice popover lists the
   session start as its own transfer (renderer test).
4. A hosted voice transcript test with Identity and Activity on Hosted at
   Mask shows the user's real name restored on screen while the
   `[ACTIVITY_1]` placeholder and any `[CREDENTIAL]` placeholder stay masked.
5. A test proves text from voice on this device goes through the request scan
   before a hosted reasoning call.
6. A blocked prompt shows a designed error that names the class and offers
   only models whose tier permits every class in the request, or changing the
   rule. When Local blocks the class too, no switch is offered. When every
   applicable rule is locked by IT, the error names the policy file and keys
   instead of offering a switch or a change.
7. An IT-locked rule cannot be changed in Settings or over IPC.
8. `npm run qa` passes with `dataClasses` on every bundled agent.
9. The Credential Block to Mask dialog, direct and in a reset, shows its own
   text (renderer test asserts the sentences).
10. A call withheld for unexamined data shows the designed state and never
   offers a model whose tier has a Block rule.

### Phase A4: Masking

- [ ] Masking acts on the scan of the final request: typed tokens replace the
      values it found before the call. The table lives in memory for one run or
      one Chat conversation and is never stored.
- [ ] A masked `security` object keeps its setting values and replaces names
      and identifiers only.
- [ ] Rehydration on the way back: streaming with holdback for split tokens;
      for tool calls, after the agentic loop parses the action, restored in the
      parsed parameter values (never in serialized JSON, where a name with
      quotation marks could break parsing), then the arguments are validated
      before execution; and in `runLlmSkill` before a step result is stored. Only reversible placeholders are restored: identity,
      device and security names and identifiers. Activity and configuration
      placeholders, when those classes are masked, are not restored: they stay
      masked in the answer, the transcript and tool parameters, like credential
      placeholders. Writes never receive tokens.
- [ ] Credential placeholders are one way: a credential value is masked as
      `[CREDENTIAL]`, never rehydrated into a prompt, and stays `[CREDENTIAL]` in the answer, the transcript and tool
      parameters.

**Acceptance criteria:**
1. An end-to-end test with a fake hosted provider shows no masked value in any
   prompt, and real values for reversible placeholders (identity, device and
   security names and identifiers) in the answer, the transcript and tool
   parameters. In the same test a masked credential (a BitLocker recovery key)
   stays `[CREDENTIAL]` in the answer, in the transcript and in tool
   parameters: the test asserts the recovery key appears in none of the three.
   With Activity and Configuration on Hosted set to Mask, a last check-in
   ("2 Oct 08:14, Frankfurt") and a policy name ("Windows baseline 24H2") stay
   `[ACTIVITY_1]` and `[CONFIG_1]` in the answer, the transcript and tool
   parameters, while the device and user in the same record are restored.
2. A token split across two stream chunks is restored correctly.
3. A write plan built after an `llm` step contains no tokens.
4. Follow-up questions in one conversation keep the same token for the same value.
5. A ledger value the admin types into a question is masked like the same value
   from a response.
6. With a Local rule set to Mask, a local call is masked on this device before
   the local model sees the request, and the answer shows the masked value
   counts with copy that says so (mockup 34, C, second frame). With no Local
   rule set to Mask, a local answer shows no line.

### Phase A5: Audit and visibility (after the sandbox stack merges)

- [ ] A `data-policy` audit source: one event per model call with provider, tier,
      classes and counts, and the action per class. Never a value.
- [ ] Status strip shows masking, Chat answers note what was masked, run activity
      shows a data policy step.

**Acceptance criteria:**
1. The audit chain verifies with the new events, and exports include them.
2. A test proves no event contains a masked or blocked value.

## Track B: Personal agent

### Phase B0: Designs

- [ ] `docs/mockups/35-personal-agent.html`: name and persona, access grants,
      skills library, learning proposals.

### Phase B1: Name and persona

- [ ] Display name (default Nova) and a persona (tone, language, answer length)
      in the profile. One label helper feeds prompts, the panel, Settings, cards,
      errors and the wake phrase text. Internal ids, tables, IPC channels and
      `nova.*` audit types stay unchanged.

**Acceptance criteria:**
1. Renaming the agent changes every user-visible mention, verified by a test
   that scans the copy modules and prompt builders for the literal "Nova".
2. A rename is a configuration audit event, and IT can lock the name.

### Phase B2: One agent for voice and typed Chat

- [ ] Standing instructions, organization instructions and confirmed notes reach
      typed Chat, within a budget that leaves room for history and evidence.
      Data policy applies to the profile block.

**Acceptance criteria:**
1. A typed Chat answer follows a standing instruction (test with a fake model
   that asserts the block is in the prompt).
2. Clipping is announced at the start of the conversation, as it is for voice
   today (mockup 35, section G).

### Phase B3: Access grants

- [ ] Per-agent grants for MCP servers, connectors (read and send), installed
      agents, skills and web search, enforced when tools are offered and again
      at the call. IT lock keys for each, with a per-skill switch that shows
      its lock reason when IT turned a skill off.
- [ ] A connector send is proposed on a confirmation card (mockup 35, Teams
      example): the exact message text, the destination (team and channel for
      Teams), the organization, Confirm and Cancel, and a note that every
      message is confirmed on its own. Nothing is sent before Confirm, and a
      confirmation never covers a later message.
- [ ] Confirm is a call, so the call-time checks run again at Confirm, in
      this order: the organization named on the card must still be the
      active organization (the existing `assertStillActive` guard in
      `apps/desktop/electron/nova-actions.ts`), the send grant (Send to
      Teams) must still be on, and Teams must be connected in that
      organization. If the admin switched organization after the card was
      proposed, the grant was turned off in Access, or the connection is
      missing, nothing is sent and the card shows a "Not sent" state with the
      reason and the fix (Switch back to Woodgrove Bank, Turn on Send to
      Teams, or Reconnect Teams in that organization), never "posted". After
      the fix the same card can be confirmed again and still covers only its
      one message.
- [ ] Every outgoing post has its own confirmation. The existing path that
      splits a long result into several numbered posts after one
      confirmation (`novaMessageParts` and the send loop in
      `nova-actions.ts`) is replaced. A message longer than the app's limit
      for one message on that connector (for Teams, the existing 4 KB
      budget, which leaves room for HTML expansion; Microsoft documents about
      100 KB per channel post) is not split and gets no Confirm: the card
      says it is too long and offers Send a shorter summary (the agent
      proposes a shorter message on a new card with its own Confirm) or Save
      the full report (kept on this device, nothing sent) (mockup 35).
- [ ] The contract: a tool is offered and callable only while its grant is on
      and the service it uses is connected in the active organization. A
      granted skill is offered only when every grant it uses (for example
      Microsoft 365 Read) is on and every service it reads is connected. A
      skill or tool that needs a missing service (for example a device
      triage skill with a Graph grant in an organization where Entra is not
      connected) is not offered there. Access names each cause with its own
      recovery: turn the grant on, or connect the service (or switch
      organization). A missing service never turns a grant off.

**Acceptance criteria:**
1. A server or connector without a grant is neither offered nor callable.
2. The status strip names only the hosts whose tools are offered in this
   conversation.
3. A granted tool whose service is not connected in the active organization
   is neither offered nor callable, from Chat, a skill or a scheduled check
   (test), and Access shows the designed missing-service state.
4. A skill whose service is connected but whose grant (Microsoft 365 Read) is
   off is not offered, and Access offers Turn on Microsoft 365 Read, not a
   service connection; with both missing, both recoveries are shown (test,
   mockup 35, B).
5. A connector send shows the card with the exact text, destination and
   organization; Cancel sends nothing, and a second message needs its own
   Confirm (test, mockup 35).
6. Confirm rechecks the send grant and the connection for the organization on
   the card: with Send to Teams turned off after the card was proposed, or
   Teams not connected in that organization, Confirm posts nothing and the
   card reads "Not sent" with the reason and the matching fix, never
   "posted" (test per cause, mockup 35).
7. Organization switch: a card proposed in Woodgrove Bank, with the active
   organization switched to another one before Confirm, posts nothing in
   either organization; the card reads "Not sent" and offers Switch back to
   Woodgrove Bank, and after switching back the same card posts its one
   message (test, mockup 35).
8. Too long: a report over the Teams message limit produces no post and no
   Confirm, and never a series of numbered posts; the card offers Send a
   shorter summary, which yields a new card whose Confirm posts exactly one
   message, and Save the full report, which sends nothing (test, mockup 35).

### Phase B4: Skills

- [ ] Skills are named procedures the agent loads when relevant. Each has a name,
      a description, instructions and the tools it may use, in the open SKILL.md
      format (`allowed-tools` as space-delimited tool ids, resource selectors
      in the instructions and namespaced `metadata`), stored per device and
      optionally per organization, with version history, import and export.
- [ ] A "Save as skill" card turns a conversation into a draft skill.
- [ ] A skill can never grant write access and never uses a send tool. Writes
      still go through agents and diff confirmation; sends are proposed by the
      agent and confirmed message by message.

**Acceptance criteria:**
1. A skill created from a conversation is used in a later conversation when its
   description matches, and the answer says which skill it used.
2. A skill that names a tool outside the agent's grants cannot use it.
3. A skill that names a send tool keeps it in the file but cannot use it, even
   with the send granted.

### Phase B5: Your own MCP servers

- [ ] Add a remote MCP server by URL (mockup 35, step 1): the URL, the
      authentication (none, a header with its secret stored in the keychain,
      or the server's sign-in with its token in the keychain), and the IT
      allowlist check on the host, run before any request, with a designed
      refusal for a host that is not listed (nothing is sent to it) and for
      an address that is not https. Step 1 states what the server will
      receive: listing its tools sends the chosen credential and nothing from
      the tenant or the conversation, and each call sends a query with
      recognized tenant data removed. The existing egress checks and
      query-writer boundary apply. Allowlist key: `allowedMcpServers`
      (`TODO(ugur)`: proposed name, see open decisions).
- [ ] The boundary, stated in the grant copy: the server receives a query
      written from the admin's question with every value the app recognizes as
      tenant data removed. Text the app cannot recognize, such as an internal
      project name, can still reach the server. The status strip names the
      host whenever its tools are offered, derived from the tools actually
      offered rather than the server switch, and the admin can turn the
      server off. When every approved tool on an enabled server is back in
      review, the grant stays on, the host is left out of the strip, and the
      strip popover says why (mockup 35).
- [ ] A tool review at add time. Only tools the admin approves as read-only
      are allowed. Approval requires a positive `annotations.readOnlyHint:
      true` from the server; the label is required but never sufficient on
      its own. A tool annotated as a change (`readOnlyHint: false`) cannot be
      approved, and neither can a tool with no annotations or no
      `readOnlyHint` (the protocol's default for a missing `readOnlyHint` is
      false): its row is disabled with "No read-only label from the server".
- [ ] The admin approves the complete tool object the server lists in
      `tools/list`, not a projection of it: `name`, `title`, `description`,
      `inputSchema` and `outputSchema` with every nested property,
      `annotations` with every field (`title`, `readOnlyHint`,
      `destructiveHint`, `idempotentHint`, `openWorldHint`), and any other
      field such as `icons`, `execution`, `_meta` or one the app does not
      know. In the first review and in every re-review each tool row expands
      to a readable view of that object (nested schema properties included)
      and, alongside it, the raw JSON of the whole object.
- [ ] The write check walks the whole object recursively and reads every
      string in it, object keys included, at every depth, annotations
      included. A tool that describes saving, changing, sending or deleting
      anywhere in it is flagged, in the first review and in every re-review;
      a flagged tool cannot be approved in any review state, with the reason
      (the matched words and the JSON path of each, for example
      `annotations.title` or `inputSchema.properties.mode.enum[1]`) shown in
      its row and marked in both views. The approval is enforced at every
      call, including calls from skills and scheduled checks. A tool that is
      not approved, or added by the server later and not yet reviewed, is
      never offered.
- [ ] Approval is bound to a SHA-256 hash of the canonical serialization of
      the complete object: keys sorted at every level (RFC 8785 JSON
      Canonicalization Scheme), serialized and hashed; the raw view shows
      that canonical form. The app hashes the object the server lists before
      it offers a tool and again at every call; any change anywhere (a
      nested schema property, an enum value, `annotations.title`, `_meta`,
      an unknown field, or the name under the same id) invalidates the
      approval before the tool can be offered or called. The tool returns to
      review, unchecked, with the old and new definition side by side and
      both hashes, and a change that now describes saving, changing, sending
      or deleting makes it unapprovable (mockup 35, B, "Review 5 changed
      tools").
- [ ] Local stdio servers are out of scope for the first version
      (`TODO(ugur)`: they run code on the device).

**Acceptance criteria:**
1. A user-added server passes the same egress tests as catalog servers.
2. The status strip names the server's host whenever its tools are offered,
   and only then: with every approved tool back in review, the server's grant
   stays on, the host is absent from the strip, and the popover names the
   server and the review that keeps its tools from being offered (test).
3. A test sends a question containing private text that is absent from the
   tenant value index (an internal project name) and records what reached the
   server's request; the result is documented in the user docs next to the
   boundary statement.
4. A tool the admin did not approve is neither offered nor callable, from Chat,
   a skill or a scheduled check (test per path).
5. A tool annotated read-only whose description says it saves on the server
   (`export_report`) is flagged and cannot be approved, in the first review
   and when the review is reopened (test). The same holds for a tool whose
   name and description read as read-only but whose input parameter is
   described as applying a change (`list_baselines` with `apply_to_tenant`).
6. Regression test: an approved read tool (`get_setting`) whose description
   changes under the same id is neither offered nor callable, from Chat, a
   skill or a scheduled check, until it is approved again; the same holds for
   a change in its input schema, annotations or name. When the changed
   description says it saves on the server (`compare_baselines`), the tool
   is flagged and cannot be approved again.
7. Regression test: a write documented outside the description and the
   parameter descriptions is flagged and cannot be approved. A tool whose
   name and description read as read-only but whose `title` says "List and
   apply baselines" (`baseline_versions`), and a tool whose parameter accepts
   the enum value `apply`, are each flagged, in the first review and in a
   re-review, with the field named in the reason (mockup 35 shows
   `baseline_versions` disabled in the first review). A change confined to
   the title, an enum value, the output description or an annotation of an
   approved tool invalidates its approval (hash mismatch), so the tool is
   neither offered nor callable until it is approved again.
8. Regression test: an approved tool (`get_baseline`) whose only change is
   `annotations.title`, now "Apply baselines", is back in review (hash
   mismatch) and flagged by the write check with `annotations.title` named
   in the reason, so it cannot be approved again (mockup 35).
9. Regression test: an approved tool (`search_settings`) whose only change
   is a nested schema property
   (`inputSchema.properties.filter.properties.category.description`) is
   back in review, unchecked, neither offered nor callable until approved
   again, and can be approved again because the change only reads; a
   change to `_meta` or to a field the app does not know does the same
   (mockup 35).
10. A tool with no annotations, or with annotations but no `readOnlyHint`
    (`list_categories`), cannot be approved in any review state and its row
    reads "No read-only label from the server" (test, mockup 35).
11. Step 1: a host that is not on `allowedMcpServers` is refused before any
    request (test asserts no connection is opened), the refusal names the
    key, and Continue stays disabled; a header secret or sign-in token is
    stored in the keychain and appears in no settings file, export or run
    log (test, mockup 35).

### Phase B6: Learning

- [ ] The agent notices corrections (an edited answer, a repeated correction, a
      rejected suggestion) and proposes a note, an instruction change or a skill
      update on a card. Nothing is learned without a click.
- [ ] Notes gain a category, a last-used date and a review of stale notes.

**Acceptance criteria:**
1. The same correction given twice produces one proposal, not two.
2. A rejected proposal is not offered again for the same correction.

### Phase B7: Proactive checks

- [ ] Recurring read-only follow-ups and a daily brief per organization, each
      confirmed on a card, capped at 5 checks per organization (the brief is
      not counted), listed in Settings and stopped on Disconnect. Restarting
      after a reconnect is confirmed on a card. Checks run while the app is
      open; missed runs are listed as missed, never caught up silently. A
      check skipped because its organization was not active runs at the next
      scheduled time when it is active and its services are connected, never
      replayed on a switch.

**Acceptance criteria:**
1. A recurring check never runs a write step, and a test proves it.
2. A check for an organization that is not active, disconnected or expired does
   not start and says why in the list.

## Track C: Confidential inference

### Phase C1: Research and lab

- [ ] Compare attestable stacks (confidential GPU VMs with NVIDIA confidential
      computing, CPU TEEs, third-party attested endpoints) for model support and
      how attestation evidence is verified. Record findings here. No code.

### Phase C2: Attestation and the confidential tier

- [ ] A provider becomes `confidential` only after the app verifies fresh
      attestation evidence against pinned measurements at session start.
      Otherwise a designed error, never a silent fallback.
- [ ] Strip copy: "Confidential · attested enclave · leaves this device".

### Phase C3: Adapter

- [ ] An OpenAI-compatible adapter with attestation, usable for a model served on
      the customer's own confidential VM, with setup docs.

**Acceptance criteria (C2, C3):**
1. Tampered or stale evidence refuses the session with a designed state.
2. Without verified evidence the provider is `hosted`, and the strip says so.

## Gates for every phase

1. `npm run typecheck`, `npm test`, `npm run qa` green.
2. A separate Claude evaluator grades the phase against its acceptance criteria.
3. A Codex gpt-6.2-sol review of the full diff with no open blocking findings.
4. SPEC.md section, user docs (`docs/gitbook` and `web/content/docs`) and a
   CHANGELOG line in the same PR.

## Build order

1. A0 and B0 designs.
2. A1, then A2, then A3. B1 and B2 in parallel (separate files).
3. A4. B3.
4. A5 after the sandbox stack merges. B4, B5.
5. B6, C1. Then C2, C3, B7.

## Open decisions

1. ~~Default rules~~ mask on hosted (2026-11-18).
2. ~~Hosted voice with masking~~ speak roles, real values in the transcript
   for reversible placeholders only (A4 rule)
   (2026-11-18); voice context follows the data policy rules (round 4,
   2026-11-19). Spoken words are not gated in hosted voice, local voice keeps
   them under data policy (decided 2026-11-19); a blocked session start
   withholds the whole profile block (decided 2026-11-19).
3. ~~Skill format~~ SKILL.md (2026-11-18).
4. One personal agent now, several profiles later (proposal).
5. Local stdio MCP servers (proposal: not in the first version).
6. ~~Recurring follow-ups and a daily brief~~ yes, read-only (2026-11-18).
7. Per-organization data policy rules, for example stricter ones for a customer
   tenant (mockup 34).
8. Whether skill import accepts a URL as well as a file (mockup 35).
9. The policy key for user-added MCP servers (proposal: `allowedMcpServers`,
   a list of hosts, separate from `allowedPublicReferences`, which covers
   catalog references) (mockup 35, step 1).
