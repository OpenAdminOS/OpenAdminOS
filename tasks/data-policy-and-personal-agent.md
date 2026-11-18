# Data policy, personal agent and confidential inference (planned 2026-11-18)

Three features that share one idea: the admin decides what the assistant is,
what it may reach, and where each piece of tenant data may go. Team features
built on top of them are planned separately.

**Decisions (Ugur, 2026-11-18)**
- Our own engine, not Purview. It runs on the device, works offline and with local
  models, covers every connector and needs no E5 licence.
- Names: **data classes** for the tags, **Data policy** for the feature and its
  settings page, **Masking** for replacing identities with tokens before a hosted
  call.
- Personal agent: the admin's own named agent that takes instructions, learns,
  and is configured with access to MCP servers, skills and connectors.
- Scope: all of it, each phase with user docs, a SPEC section and a CHANGELOG line.
- Default rules: mask on hosted, as in the table below.
- Hosted voice: the voice model gets masked data and speaks roles ("the user",
  "the device"); the text transcript shows the real values.
- Skills use the open SKILL.md format, with import and export.
- Proactive work: recurring read-only checks and a daily brief per organization,
  each confirmed on a card and capped.

**Decisions (Ugur, 2026-11-18, design review of mockups 34 and 35)**
- Field reclassification in Settings only moves a field to a stricter class (or
  one of the same sensitivity, as identity and device). A less sensitive class
  comes only from the IT policy file. Value detectors still raise the class of a
  value that looks more sensitive, and a setting on the device never loosens an
  IT-locked rule.
- Loosening any rule waits for a confirmation dialog; tightening applies at once.
- Remote MCP servers receive public queries only, written by the query writer
  without tenant data. Tenant data and answer context never go into their
  requests, and the status strip names their hosts whenever their tools are
  offered.
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
  the `nova` prefix. In SKILL.md `allowed-tools`, MCP tools are
  `mcp__<server>__<tool>` and agents their slug.

## Why

Today the choice is binary. A local model keeps tenant data on the device, a
hosted model is stronger but sees everything. Data policy adds a middle path:
hosted quality without the model seeing who or what the data is about, with
credentials never reaching a hosted model in clear text. Purview cannot do this for us because it
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

| Class | Examples | Sensitivity |
|---|---|---|
| `credential` | BitLocker and FileVault recovery keys, LAPS passwords, client secrets, tokens, pre-shared keys | highest |
| `identity` | display names, UPNs, email addresses, phone numbers, user ids | high |
| `device` | device names, serial numbers, IMEI, MAC and IP addresses, device ids | high |
| `activity` | sign-in times, locations, audit entries, app usage | medium |
| `configuration` | policy names and settings, group names, app names, compliance rules | low |
| `public` | Microsoft Learn results, web search results, public reference MCP servers | none |

A field nobody has classified is treated as `identity` until it is classified.
Free text the admin types is checked against the tenant value index, so known
names and devices are caught. Names the app has never seen cannot be detected,
and the docs say so.

Default rules (decided 2026-11-18):

| Class | Local | Confidential | Hosted |
|---|---|---|---|
| `credential` | allow | mask | mask |
| `identity` | allow | allow | mask |
| `device` | allow | allow | mask |
| `activity` | allow | allow | allow |
| `configuration` | allow | allow | allow |
| `public` | allow | allow | allow |

Actions are allow, mask and block. The admin and IT may tighten any rule and
loosen all but one: `credential` never reaches a hosted model in clear text.
Loosening from Settings asks for confirmation first, and never applies to a rule
IT locked. Fields move only to the same or a stricter class in Settings; a less
sensitive class comes from the IT policy file.

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
- [ ] Fenced tenant content carries its classes and counts.
- [ ] Field names verified against real responses in the lab tenant with Lokka.

**Acceptance criteria:**
1. Each bundled agent and each cache resource yields classified content, with a
   test per resource.
2. A BitLocker key, a LAPS password and a client secret are classed
   `credential` from both a structured response and free text.
3. An unmapped field is classed `identity`, and a test proves it.
4. Every field mapping was checked against a live Graph response in the lab
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

- [ ] A data policy decorator applied in `buildLlm`, so agent runs, Chat, Office,
      drafts, follow-ups and the Nova command all pass through it.
- [ ] Hosted voice gets its own gate in `nova.ts` and the renderer. Masked data
      goes to the voice model, which speaks roles; the transcript shows real values.
- [ ] Settings > Data policy and a managed configuration key `dataPolicy`
      (schema, parser, record sanitizer, audit mapping, both docs copies).
- [ ] Agent manifests declare `descriptor.dataClasses`, derived when absent, with
      a qa-graph check and the JSON Schema updated in the same commit. Agent
      details show what an agent reads. Preflight refuses a run the policy would
      block, with a designed state.
- [ ] The sandbox host applies the same engine.

**Acceptance criteria:**
1. A test per path (agent run, Chat deterministic, Chat streaming, agentic loop,
   Office, follow-up, hosted voice) shows a blocked class never reaches the model.
2. A blocked prompt shows a designed error that names the class and offers
   switching to a local model or changing the rule.
3. An IT-locked rule cannot be changed in Settings or over IPC.
4. `npm run qa` passes with `dataClasses` on every bundled agent.

### Phase A4: Masking

- [ ] Typed tokens replace masked values before the call. The table lives in
      memory for one run or one Chat conversation and is never stored.
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
2. Clipping is announced, as it is for voice today.

### Phase B3: Access grants

- [ ] Per-agent grants for MCP servers, connectors (read and send), installed
      agents, skills and web search, enforced when tools are offered and again
      at the call. IT lock keys for each.

**Acceptance criteria:**
1. A server or connector without a grant is neither offered nor callable.
2. The status strip names only the hosts the agent is granted.

### Phase B4: Skills

- [ ] Skills are named procedures the agent loads when relevant. Each has a name,
      a description, instructions and the tools it may use, in the open SKILL.md
      format, stored per device and
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
      keychain, a tool review at add time, the existing egress checks and
      query-writer boundary, and an IT allowlist key. The server receives public
      queries only; tenant data and answer context never go into its requests.
- [ ] Local stdio servers are out of scope for the first version
      (`TODO(ugur)`: they run code on the device).

**Acceptance criteria:**
1. A user-added server passes the same egress tests as catalog servers.
2. The status strip names the server's host whenever its tools are offered.

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
      open; missed runs are listed as missed, never caught up silently.

**Acceptance criteria:**
1. A recurring check never runs a write step, and a test proves it.
2. A check for an organization that is not active, disconnected or expired does
   not start and says why in the list.

## Track C: Confidential inference

### Phase C1: Research and lab

- [ ] Compare attestable stacks (confidential GPU VMs with NVIDIA confidential
      computing, CPU TEEs, third-party attested endpoints) for models, cost and
      how evidence is verified. Record findings here. No code.

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
2. ~~Hosted voice with masking~~ speak roles, real values in the transcript (2026-11-18).
3. ~~Skill format~~ SKILL.md (2026-11-18).
4. One personal agent now, several profiles later (proposal).
5. Local stdio MCP servers (proposal: not in the first version).
6. ~~Recurring follow-ups and a daily brief~~ yes, read-only (2026-11-18).
7. Per-organization data policy rules, for example stricter ones for a customer
   tenant (mockup 34).
8. Whether skill import accepts a URL as well as a file (mockup 35).
