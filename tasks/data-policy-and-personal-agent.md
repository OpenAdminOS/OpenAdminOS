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
- Hosted voice: tenant data the app sends to the voice model is masked, and the
  voice model speaks roles ("the user", "the device"); the text transcript shows
  the real values. What the admin says aloud is not gated (see round 4).
- Skills use the open SKILL.md format, with import and export.
- Proactive work: recurring read-only checks and a daily brief per organization,
  each confirmed on a card and capped.

**Decisions (Ugur, 2026-11-18, design review of mockups 34 and 35)**
- Field reclassification in Settings only moves a field to a class higher in
  the order. On every tier the reclassified field keeps the masking coverage of
  both its original and its new class, so a reclassification can never weaken
  any tier, including against IT-set rules: a configuration value covered by an
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
  class, and the scan reports that the budget ran out.
- The credential promise, in every place it appears: values the app
  recognizes as credentials never reach a hosted model in clear text. A secret
  written into a free-text field in a form the app does not recognize can
  still be sent. On Confidential, `credential` defaults to Mask; Allow is
  possible only after the confirmation dialog, and IT can lock it.

**Decisions (Ugur, 2026-11-19, round 4 of the design review)**
- Hosted voice is honest about its boundary. Masking and blocking apply to
  tenant data the app sends to the hosted voice model. What the admin says
  aloud goes to the hosted voice provider as audio and is not gated by data
  policy. The hosted voice strip says so ("Hosted voice · OpenAI · hears what
  you say · tenant data masked"), and so do the data policy notes and docs.
  Voice on this device is the way to keep spoken words under data policy: the
  words are transcribed on the device, then the text goes through the same
  request scan as a typed question before any hosted reasoning call.
- Confirmations that loosen `security` name what masking replaces (policy
  names, named locations, IP ranges, excluded users and groups, role names)
  and state that setting values go to the hosted model in clear text.
- The status strip names a blocked `credential` like any other blocked class,
  picks its long or short form by the space it has, and opens a popover that
  lists the effective rule for every class.
- A blocked request offers only models whose tier permits every class in the
  request. When every applicable rule is locked by IT, the block names the
  rule owner (policy file and keys) instead of offering a switch or a change.

## Why

Today the choice is binary. A local model keeps tenant data on the device, a
hosted model is stronger but sees everything. Data policy adds a middle path:
hosted quality without the model seeing who or what the data is about, with
values the app recognizes as credentials never reaching a hosted model in clear
text. Purview cannot do this for us because it
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
scan could not examine within its budget counts as unexamined, and its
effective class is `credential`.

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
and on each tier it keeps the masking coverage of both its original and its new
class. A less sensitive class comes from the IT policy file.

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
      examine count as unexamined with `credential` as their effective class,
      and the scan flags the budget exhaustion.
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
5. A reclassified field keeps the masking coverage of both classes on every
   tier, including against an IT-locked rule: a configuration value under an
   IT Mask rule stays fully masked after moving to `security` (test).
6. A scan that exhausts its budget reports the unexamined data with
   `credential` as its effective class (test).
7. Every field mapping was checked against a live Graph response in the lab
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
2. Ollama or LM Studio on a remote endpoint reports `hosted`.

### Phase A3: Routing and blocked states

- [ ] Routing acts on the scan of the final request: a data policy decorator
      applied in `buildLlm`, so agent runs, Chat, Office, drafts, follow-ups
      and the Nova command all pass through it.
- [ ] Hosted voice gets its own gate in `nova.ts` and the renderer for tenant
      data the app sends to the voice model: it is masked or blocked by the
      rules, the voice model speaks roles, and the transcript shows real
      values. What the admin says aloud goes to the hosted voice provider as
      audio and is not gated; the hosted voice strip ("hears what you say"),
      the Data policy settings and the docs say so. Voice on this device keeps
      spoken words under data policy: they are transcribed on the device and
      the text goes through the same request scan before any hosted reasoning
      call.
- [ ] Settings > Data policy and a managed configuration key `dataPolicy`
      (schema, parser, record sanitizer, audit mapping, both docs copies).
- [ ] Agent manifests declare `descriptor.dataClasses`, derived when absent, with
      a qa-graph check and the JSON Schema updated in the same commit. Agent
      details show what an agent reads. Preflight refuses a run the policy would
      block, with a designed state.
- [ ] The sandbox host applies the same engine.

**Acceptance criteria:**
1. A test per path (agent run, Chat deterministic, Chat streaming, agentic loop,
   Office, follow-up) shows a blocked class never reaches the model.
2. A test proves tenant data the app sends to hosted voice is masked, and a
   blocked class is not sent to it. The docs and the hosted voice strip state
   that spoken input is not gated in hosted voice; a renderer test asserts
   the strip copy.
3. A test proves text from voice on this device goes through the request scan
   before a hosted reasoning call.
4. A blocked prompt shows a designed error that names the class and offers
   only models whose tier permits every class in the request, or changing the
   rule. When Local blocks the class too, no switch is offered. When every
   applicable rule is locked by IT, the error names the policy file and keys
   instead of offering a switch or a change.
5. An IT-locked rule cannot be changed in Settings or over IPC.
6. `npm run qa` passes with `dataClasses` on every bundled agent.

### Phase A4: Masking

- [ ] Masking acts on the scan of the final request: typed tokens replace the
      values it found before the call. The table lives in memory for one run or
      one Chat conversation and is never stored.
- [ ] A masked `security` object keeps its setting values and replaces names
      and identifiers only.
- [ ] Rehydration on the way back: streaming with holdback for split tokens,
      before the agentic loop parses tool actions, and in `runLlmSkill` before a
      step result is stored. Writes never receive tokens.
- [ ] Credential values are masked one way and never rehydrated into a prompt.

**Acceptance criteria:**
1. An end-to-end test with a fake hosted provider shows no masked value in any
   prompt and the real values in the answer, the transcript and tool parameters.
2. A token split across two stream chunks is restored correctly.
3. A write plan built after an `llm` step contains no tokens.
4. Follow-up questions in one conversation keep the same token for the same value.
5. A ledger value the admin types into a question is masked like the same value
   from a response.

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

**Acceptance criteria:**
1. A server or connector without a grant is neither offered nor callable.
2. The status strip names only the hosts the agent is granted.

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

- [ ] Add a remote MCP server by URL, with headers or sign-in secrets in the
      keychain, the existing egress checks and query-writer boundary, and an IT
      allowlist key.
- [ ] The boundary, stated in the grant copy: the server receives a query
      written from the admin's question with every value the app recognizes as
      tenant data removed. Text the app cannot recognize, such as an internal
      project name, can still reach the server. The status strip names the
      host whenever its tools are offered, and the admin can turn the server
      off.
- [ ] A tool review at add time. Only tools the admin approves as read-only
      are allowed; the tool's read-only annotation is shown but not trusted on
      its own, and a tool annotated as a change cannot be approved. The
      approval is enforced at every call, including calls from skills and
      scheduled checks. A tool that is not approved, or added by the server
      later and not yet reviewed, is never offered.
- [ ] Local stdio servers are out of scope for the first version
      (`TODO(ugur)`: they run code on the device).

**Acceptance criteria:**
1. A user-added server passes the same egress tests as catalog servers.
2. The status strip names the server's host whenever its tools are offered.
3. A test sends a question containing private text that is absent from the
   tenant value index (an internal project name) and records what reached the
   server's request; the result is documented in the user docs next to the
   boundary statement.
4. A tool the admin did not approve is neither offered nor callable, from Chat,
   a skill or a scheduled check (test per path).

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
   (2026-11-18); spoken words are not gated in hosted voice, local voice keeps
   them under data policy (2026-11-19).
3. ~~Skill format~~ SKILL.md (2026-11-18).
4. One personal agent now, several profiles later (proposal).
5. Local stdio MCP servers (proposal: not in the first version).
6. ~~Recurring follow-ups and a daily brief~~ yes, read-only (2026-11-18).
7. Per-organization data policy rules, for example stricter ones for a customer
   tenant (mockup 34).
8. Whether skill import accepts a URL as well as a file (mockup 35).
