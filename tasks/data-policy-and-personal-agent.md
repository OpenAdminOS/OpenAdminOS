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
  Each value keeps its provenance (the field path it came from) and the
  effective field map revision that classed it, and that revision is checked
  before every request (round 18). Just before each model call, the final request (system text plus prompt,
  including the admin's own words) is scanned against those values and the
  detectors, in the one Hosted gate every request that leaves the device
  passes (provider calls, hosted voice context and web search, A3). Routing
  and masking act on that scan. Text or fields the scan cannot examine within its
  work budget are counted as unexamined, with `credential` as their effective
  class, and the scan reports that the budget ran out. Their action on a tier
  is the strictest action of any class on that tier (round 4).
- The credential promise, in every place it appears, names the tier and
  states the Confidential exception next to it: values the app recognizes as
  credentials never reach a model on the Hosted tier in clear text. On the
  Confidential tier, `credential` defaults to Mask; Allow there is possible
  only after the confirmation dialog, and IT can lock it. A secret written
  into a free-text field in a form the app does not recognize can still be
  sent (round 22).

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
  with how other transfers are withheld. Round 21 widens the scan to the
  complete instructions, tenant and greeting values included, with a
  rescanned fallback or no call; round 22 requires every scan that could
  open the session, the first one included, to cover the whole text.

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
  transfers and is listed as its own transfer (round 21: the scan covers the
  complete instructions, not only the profile block). The spoken-audio
  boundary is unchanged.
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
  Round 21 adds the tenant and greeting values the rule covers, replaced by
  neutral wording, and a rescan before the call opens.

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

**Review findings adopted (2026-11-19, round 12 of the design review)**
- The plan is normative; the scripted behaviour in the mockups illustrates
  it. Where a mockup computes something (the hash, the write check), it says
  so in a note, the plan's rule governs, and the illustration agrees with it.
- Step 2 of adding a server reviews exactly the endpoint entered in step 1,
  names its host and shows its full address, and always opens with every
  tool unchecked. Changing the address clears the review until Continue
  lists the new endpoint, and reopening starts unchecked. Approvals never
  carry across endpoints (B5).
- The write check treats any write the definition documents as
  disqualifying, whatever words it uses and whatever its read-only label. A
  tool with `readOnlyHint: true` whose description says "Edits the selected
  tenant setting" is flagged (B5).
- The hash is named exactly: the tool object in the RFC 8785 JSON
  Canonicalization Scheme (JCS), then SHA-256 over its UTF-8 bytes (B5).
- A re-review shows, for each changed tool, the complete previously approved
  object and the complete current object side by side, with full hashes
  that can be copied and the short form in the row (B5).

**Review findings adopted (2026-11-19, round 13 of the design review)**
- Saved Chat history after a restart: each saved Chat message stores its
  classification evidence next to it in the local database (spans as
  offsets, lengths and classes, and the effective field map revision, as
  round 16 names it, kept per span as the revision that classed it since
  round 22, and the unexamined ranges, as round 21 adds; no new
  copy of the values). Reopening a conversation rebuilds the ledger from it before
  any follow-up. A saved message without readable evidence counts as
  unexamined, takes the strictest action on the tier, and the follow-up says
  so. Disconnect and deleting the conversation remove the evidence (A1, A3).
- Result delivery from runs the personal agent starts: every delivery from
  such a run goes through the per-message confirmation card and the
  call-time checks, showing the final text and destination; nothing posts
  without a click. Runs started outside the personal agent keep their own
  delivery behaviour (B3).
- Step 2 of adding a server shows a different tool list for another path on
  the same host, and the re-review marks the changed path in both raw JSON
  panes, including a property present on only one side (mockup 35).

**Review findings adopted (2026-11-19, round 14 of the design review)**
- Saved Chat evidence keeps every class a span's field has held: each span
  stores the list of its field's classes at the time of saving (widened in
  round 15 to every class a value detector assigned as well), and
  reopening recomputes the strictest action across all of them under the
  current rules. A same-revision restart regression test covers a field
  moved from `configuration` to `security` to `identity` before the answer
  is saved (A1, A3).
- Delivery confirmation is gated by run origin before anything enters the
  automatic delivery queue, for every connector the queue handles (Teams,
  Outlook, Slack, Discord, WhatsApp and Signal, and any added later). A run
  the personal agent started never reaches the queue; its deliveries wait
  on cards. Scheduled runs keep their behaviour (B3).
- Mockup 35: the read tools on the alternate endpoint no longer use
  "stored" as an adjective, and the readable definition pane shows the
  complete object, nested `_meta` values included.
- Mockup 34, F: a message with readable evidence saved before a change
  that raised a class counts as unexamined, and the reopened conversation
  says why. Round 16 makes this any raise of the effective field map, from
  the shipped map, Settings or the IT policy file; round 20 makes it any
  change of a class, not only a raise.

**Review findings adopted (2026-11-19, round 15 of the design review)**
- Saved Chat evidence keeps the full set of classes that applied to each
  span when saved: its field's class history and every class a value
  detector assigned (a tenant value index match, the credential and
  identifier patterns). Reopening takes the strictest action across that
  set. A same-revision restart regression test covers a display name in a
  configuration field that the index recognized as identity and that has
  since left the index (A1, A3).
- Mockup 35: the readable definition pane renders every schema keyword the
  layout does not handle with the recursive value renderer, so a root
  `enum` and a description under nested `items.items` appear in both panes.
- Mockup 34, F: evidence from before any class raise counts as unexamined,
  not only evidence for the fields that changed (from any source of the
  raise since round 16, and any class change since round 20).
- Mockup 35: the saved-delivery note says the run-origin gate covers every
  connector, including ones added later, with Teams as the example.

**Review findings adopted (2026-11-20, round 16 of the design review)**
- One Hosted gate for every model request that leaves the device, not only
  the calls built in `buildLlm`: provider calls from `buildLlm`, hosted
  voice context and the Nova web search request, whose final query to
  OpenAI is scanned with any value A4 restored into the tool's parameters.
  A blocked query makes no network request and shows the designed blocked
  state (mockup 34, E). Round 17 adds that a web search query never carries
  tenant data: recognized values are removed before the scan. Any future path that sends text to a hosted model
  uses the same gate, and a test fails when a module calls a hosted model
  endpoint outside it (A3).
- Evidence is versioned by the effective field map revision, which changes
  whenever the shipped map, a Settings reclassification or an IT policy
  reclassification raises any class (round 20: changes any class). Saved
  evidence stores that revision (round 22: per span, the revision under
  which the span was classified, not the one in force at save), and
  evidence from before any class raise, from any source, counts as
  unexamined. A restart regression test covers a
  field raised from `configuration` to `security` in Settings after the
  answer was saved (A1, A3).
- Mockup 34: the strip reads "security names masked" for Mask and "security
  blocked" for Block, in the generated strip and the reopened Chat
  composer.
- Mockup 35: the readable definition checks `required` against own
  properties and renders structured enum values with the path-aware
  renderer; renaming the agent updates accessible labels too.

**Review findings adopted (2026-11-20, round 17 of the design review)**
- Web search keeps the public research boundary of SPEC.md (outbound
  queries are public research) on top of the Hosted gate: a web search
  query never carries tenant data of any class, whatever the rules allow.
  The query is written from public inputs only. Every value the app
  recognizes as tenant data (any class, configuration included, such as an
  internal app name from the cache) is removed before sending; when nothing
  meaningful remains, the search is not sent and the designed state says
  so. Text the app cannot recognize can still reach the search provider,
  stated as honestly as the remote MCP boundary. The Hosted gate still
  applies to whatever remains (round 18 sets the order: placeholders are
  removed after the gate; round 19 adds detector matches to the first
  removal and a final check after the gate). Whenever web search is offered, the status
  strip names its destination (OpenAI), also when the chat model is local,
  so "No data leaves this device" is never shown while search is offered
  (A3, mockup 34, B and E).
- `nova.ts` and the renderer call the same Hosted gate for hosted voice
  context; they do not have a gate of their own (A3).
- Mockup 35: the comparison marks changes at array element paths (for
  example `inputSchema.enum[0]`) in the raw view, and at object and array
  nodes in the readable view.

**Review findings adopted (2026-11-20, round 18 of the design review)**
- Web search enforces the public research boundary on the final outbound
  query, after the Hosted gate, in this order: remove every recognized
  tenant value, apply the Hosted gate, then remove every placeholder from
  the result (a stale one with no mapping, such as `[USER_2]` from an
  earlier masked answer, and any token the gate produced, such as
  `[CREDENTIAL]`), then check whether meaningful text remains. When none
  remains, nothing is sent. A gate Block on what remains (for example a
  scan that ran out of its budget with a Block on the tier) makes no
  request and has its own designed state (A3, mockup 34, E). Round 19
  widens the first step to detector matches and adds a final check after
  the gate; round 20 adds a scan of the exact final string as the last
  step.
- A redirect that changes a user-added server's endpoint (any change of
  scheme, host, port or path; round 19 adds the query string) is refused during tool listing and every
  tool call. Nothing is sent to the target, and the designed state names
  the redirect target and asks the admin to add that address as its own
  server, which gets a fresh review. This tightens the same-origin rule the
  MCP transport follows today (`apps/desktop/electron/mcp/host.ts`) (B5,
  mockup 35).
- The effective field map revision is checked before every request, also
  for evidence held in an open conversation's in-memory ledger. Evidence
  classified under an older revision is reclassified from its provenance
  (the field path) where it has one; evidence that cannot be rebuilt counts
  as unexamined. Saved evidence stores no field path, so the round 16 rule
  for it stands (A1, A3).
- Mockup 34, E: a web search with public words left that the Hosted gate
  withholds, and the OpenAI search destination in the Claude Code
  reasoning frame.
- Mockup 35: the readable comparison marks an empty node that becomes
  populated (`inputSchema.properties` from `{}`), and the tool `name` goes
  through the same path-aware marker.

**Review findings adopted (2026-11-20, round 19 of the design review)**
- Web search step 1 removes everything the app recognizes as tenant data:
  ledger matches, tenant value index matches and detector matches (email
  addresses, GUIDs, IP addresses, serial numbers and credential patterns),
  whatever the rules on Hosted allow. After the gate, a final check removes
  any recognized span still present, also under Allow, before the
  placeholders are removed and the meaningful text check runs (round 20
  adds a last scan of the exact string to be sent). A
  regression test covers a detector-only email address with Identity on
  Hosted at Allow: the address never reaches the request (A3).
- A3 criteria 18 and 19: criterion 18 covers stale tokens only; the order
  of placeholder removal after the gate is criterion 19, which now uses a
  token the gate produces for an unexamined tail, since step 1 removes a
  recognized recovery key before the gate (A3).
- A user-added MCP server's endpoint is its full URL without the fragment:
  scheme, host, port, path and query string. A redirect that changes any of
  them, the query string alone included, is refused during listing and
  calls, with criteria for a query-only redirect in both (B5, mockup 35).
- Mockup 34, E: the web search trace shows the tenant lookup (Ollama
  answering from the cache) and the writing of the public query as
  separate steps; the query writer gets only public inputs, and the
  removed app name comes from the admin's question.
- Mockup 34, F: a live follow-up in a conversation that stayed open, where
  the effective field map revision changed and an entry without a field
  path became unexamined, with the reason and the recovery.

**Review findings adopted (2026-11-20, round 20 of the design review)**
- The effective field map revision advances on any change of any field's
  classes, from any source (an app update to the shipped map, Settings or
  the IT policy file), not only on a raise. A remap to a lower class can
  still be stricter on a tier: with Security on Hosted at Allow and
  Configuration on Hosted at Block, an IT policy file remap of a field from
  `security` to `configuration` blocks a value that was sent before. Live
  and saved evidence classified under an older revision is reclassified
  from its field path or counts as unexamined, as before. Live and
  reopened Chat regression criteria cover that remap (A1, A3).
- Web search: after placeholder removal and the meaningful text check, the
  exact string that would be sent is scanned once more by every recognizer
  (ledger, tenant value index, detectors). When any recognized span is
  found, the search is not sent and Chat shows the designed state; the
  string is never edited again. Removing a stale placeholder can join a
  value, as `WGB Expen[USER_2]ses` becomes `WGB Expenses`. A regression
  criterion covers it (A3, mockup 34, E).
- A3 criterion 22 asserts on its own that the input to the Hosted gate
  already excludes the detector-only address (step 1), next to the
  separate unit test of the final check (step 3).
- Mockup 34, F: in the live follow-up trace, the revision check comes
  before the hosted planning call.
- Mockup 34, E: the search withheld by the gate holds a long public log
  excerpt the admin pasted into the question, not tenant evidence, since
  the query writer gets public inputs only.

**Review findings adopted (2026-11-20, round 21 of the design review)**
- Hosted voice session start: the Hosted gate scans the complete serialized
  instructions the app would send when the OpenAI session opens, not only
  the profile block: the fixed rules, the tenant name, the tenant id, the
  greeting name, the profile block and every other line `nova.ts` builds.
  When a rule blocks a class anywhere in them, the app rebuilds the
  instructions without the blocked parts: the profile block, withheld whole
  when it carries a blocked class, and the tenant name, tenant id or
  greeting name where the rule covers their class, each replaced by neutral
  wording. The rebuilt instructions are scanned again before the call
  opens. When that scan still finds blocked content, or does not cover the
  whole text, the call does not open, nothing is sent to OpenAI, and the
  designed state says why (round 22 adds the same coverage rule for the
  first scan). A regression criterion covers an empty profile
  with a greeting name the tenant value index recognizes as `identity`,
  with Identity on Hosted at Block (A3, mockup 34, B).
- Saved Chat evidence also stores the unexamined ranges of each message
  (offsets and lengths of the text the scan did not examine within its
  budget) next to the found spans. When the unexamined ranges cannot be
  stored for a message, the whole message counts as unexamined. On
  reopening, stored unexamined ranges take the strictest action on the
  tier, like any unexamined content. A same-revision restart criterion
  covers a partially examined message on Confidential with Credential at
  Allow and Identity at Block (A1, A3).
- Web search step 6 requires complete coverage from every recognizer on the
  exact outbound string. When any recognizer did not finish (its budget ran
  out, it timed out or it failed), the search is withheld, with a shorter
  search and an answer without searching as the recovery (A3, mockup 34,
  E).
- The 1,000 character cap of `web-search.ts` applies to the sanitized
  outbound query, after every step, as step 7: the exact string that passed
  step 6 is measured, never cut, and a longer string is not sent. Mockup 34,
  E illustrates the search withheld by the gate with a public excerpt
  within the cap and a bounded scan budget, as the tests set it (A3).
- Mockup 35, E: the learning example no longer sets an answer language,
  which IT locks in A; it proposes a preference unrelated to language.

**Review findings adopted (2026-11-20, round 22 of the design review)**
- Hosted voice requires complete coverage on every scan that could open the
  session, the first scan included, not only the fallback's rescan. When
  the first scan of the session instructions does not cover the whole text,
  the session does not open on it: the app builds the fallback without the
  parts the scan did not examine and rescans it in full, or shows "Hosted
  voice did not start" when the unexamined part is one the fallback keeps.
  Unexamined start text is never masked one way and sent, also under the
  defaults with no Block. Criterion 29 covers an incomplete first scan with
  the default rules (A3, mockup 34, B).
- Saved Chat evidence keeps each span's own classification revision, the
  effective field map revision under which that span's classes were
  computed, never the revision in force at save time. On reopening and
  before every request, a span whose revision is older than the revision in
  force counts as unexamined with its message, since saved evidence keeps no
  field path. Criterion 30 covers a remap from `configuration` to
  `security` while the answer streams (a move in Settings since round 23,
  as the IT policy file is read once per launch) (A1, A3, mockup 34, F).
- Mockup 34, B: the voice fixture gives the organization name and the
  tenant id their own classes, and a popover shows a fallback that opened
  with neutral wording in place of the tenant id and the greeting name.
- Mockup 34, F: a conversation reopened at the current revision whose saved
  message has an unexamined tail, withheld on the Confidential tier with
  Credential at Allow and Identity at Block, as criterion 26 sets it.
- The credential promise names its tier: values the app recognizes as
  credentials never reach a model on the Hosted tier in clear text, and the
  Confidential exception (Allow only after the confirmation dialog, which IT
  can lock) is stated next to it, in the plan and mockup 34.

**Review findings adopted (2026-11-20, round 23 of the design review)**
- Clipping never splits a classified value. When the profile budget, a
  history budget or evidence compaction before a hosted request would cut
  through a span the ledger, the tenant value index or the detectors
  classified, the whole span is left out and the clipping notice says what
  was left out, by part and class. The retained ranges keep their
  classification, and the complete scan of the serialized request stays.
  B2 criteria 3 and 4 cover typed Chat and the hosted voice start with a
  Conditional Access policy name in the organization instructions, cut by
  the budget, under Security Block on Hosted (A3, B2, mockup 35, G).
- The IT policy file is read once per launch (`main.ts`, not watched), so a
  change to it advances the effective field map revision when the app
  reads the new file, at the next launch. Criterion 30 now has the remap
  while the answer streams come from a move in Settings, which applies at
  once, and a third case for a file change read at the next launch.
  Criteria 13 and 24 say the same, and the Settings notice in mockup 34, A
  says which changes apply during a session (A1, A3).
- Mockup 34, B: a popover for a first voice check that stops inside the
  profile under the defaults, where the start without the profile passed a
  complete check and the call opened with it. Every voice popover says that
  unexamined start text is never sent (the call opens without it or does
  not start), while unexamined text in a later transfer takes the strictest
  action on Hosted (criterion 29).
- Mockup 34, F: the Confidential strip in the reopened unexamined-tail
  frame has a compact form that keeps "leaves this device" and the block;
  B shows it next to the long form.
- Mockup 34, B: the "only recognized credentials masked" note names the
  Confidential exception next to the Hosted promise.

**Review findings adopted (2026-11-20, round 24 of the design review)**
- A cut is made only inside text the scan examined completely. When the
  scan of a part the app can clip (an instruction block, a note, a history
  turn, an evidence excerpt) did not finish, that whole part is left out,
  never cut, and the notice names the part and says its check did not
  finish. When the unfinished part cannot be left out, such as the fixed
  rules, the request is withheld: typed Chat shows "Withheld by the data
  policy check", and hosted voice builds the fallback or shows "Hosted
  voice did not start". The final scan of the serialized request still
  runs. B2 criteria 3 and 4 gain a second case in which the scan before the
  clip stops inside WGB Finance MFA (A3, B2).
- Mockup 35, G: a second Chat frame on a hosted model with Security at
  Block on Hosted, where the organization instructions were cut before a
  security value. The notice names the omitted part and its class in its
  own text, and "What this model received" lists the organization
  instructions up to the cut with the value left out whole.
- Mockup 34, B: the session start line of a call that opened with a
  rebuilt start records the rebuilt start's outcome and its masking count
  ("Rebuilt start sent, 2 values masked: the tenant id and your greeting
  name") next to what it opened without, both from the time it was sent,
  so a later rule change leaves both facts as recorded (A3).

## Why

Today the choice is binary. With a local model the request never leaves the
device; with a hosted model the whole request, tenant data included, goes to
the provider. Data policy adds a middle path:
the rules decide which values a hosted model receives as is, which are masked
and which are withheld. Identities the app recognizes can be masked, while
configuration values and names the app does not recognize, such as a person
typed for the first time, may still be sent. Values the app recognizes as
credentials never reach a model on the Hosted tier in clear text; on the
Confidential tier they are masked unless the admin allows them after a
confirmation dialog, a rule IT can lock. Purview cannot do this for us because it
sees opaque text after the fact; we know the shape of every response at the
moment it arrives.

## What the code has today (explored 2026-11-18, main at 6dc77828)

- Every model call goes through `RunLlmApi` (`packages/agent-sdk/src/index.ts`),
  and every adapter is built in `AppStateStore.buildLlm` (`apps/desktop/electron/state.ts`),
  where the provider id is known. Prompts are flat strings. Two paths send
  text to a hosted model outside it: hosted voice in `nova.ts`, and the Nova
  web search (`intune-chat/web-search.ts`), which posts the query to the
  OpenAI Responses API with the Nova key. The hosted voice instructions
  carry the tenant name, the tenant id and the greeting name in fixed lines
  outside the profile block (checked 2026-11-20), and `searchPublicWeb`
  refuses a query over 1,000 characters as the model wrote it.
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
  channel, outside `RunLlmApi`. It must call the same Hosted gate as every
  other hosted request.
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
model on the Hosted tier in clear text, so `credential` on Hosted has no
Allow. On the Confidential tier, `credential` defaults to Mask; Allow there is
possible only after the confirmation dialog, and IT can lock it. A secret
written into a free-text field in a form the app does not recognize can still
be sent, and the docs say so.
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
      registered for the run or Chat conversation, in memory only. Each
      ledger entry keeps its provenance (the field path it came from, when
      it came from a field) and the effective field map revision that
      classed it.
- [ ] The effective field map revision is checked before every request,
      including a request that uses evidence from an open conversation's
      in-memory ledger, not only evidence rebuilt from saved history. Evidence
      classified under a revision older than a later class change from any
      source, a raise or a remap to a lower class, is reclassified from its
      provenance where it has one: the span
      adds its field's current class history to its set (it never drops a
      class it held, detector classes included), and its action is the
      strictest across the set under the rules in force. Evidence that cannot
      be rebuilt, such as a span with no field path, counts as unexamined.
      Saved evidence stores no field path, so evidence saved under an older
      revision counts as unexamined, as below (decided by the lead
      2026-11-20, round 18; any class change, not only a raise, round 20).
- [ ] Saved Chat history keeps its classification evidence. Each saved Chat
      message stores, next to it in the local database, the spans the ledger
      found in its text. Each span keeps its own classification revision:
      the effective field map revision (defined below) under which that
      span's classes were computed, copied from its ledger entry, never the
      revision in force when the message is saved. A class change between
      classification and save, such as a move in Settings while the answer
      streams, leaves the span at the older revision (round 22). Each
      span keeps its offset, its length and the full set of classes that
      applied to it when the message was saved, never one class alone: its
      field's class history at that time (the mapped class and every later
      pick) and every class a value detector assigned to it (a tenant value
      index match, such as a person's display name recognized as identity,
      and the credential and identifier patterns). Next to the spans, the
      evidence stores the message's unexamined ranges: the offset and length
      of every part of its text the scan did not examine within its work
      budget (round 21). When the unexamined ranges cannot be stored for a
      message (the write fails, or the scan cannot say which parts it
      skipped), the whole message counts as unexamined, and its evidence
      records it so. The evidence holds no copy of the values
      beyond the message text that is already stored. Disconnecting the
      organization and deleting the conversation remove the evidence with the
      messages.
- [ ] When a saved conversation is reopened, including after an app restart,
      the ledger is rebuilt from that stored evidence before any follow-up is
      built, so a value that is no longer in the current tenant value index
      (a Conditional Access policy that was renamed or deleted since) is still
      known by its classes. Each rebuilt span takes the strictest action
      across every class in its stored set, field classes and detector
      classes alike, computed under the rules in force at the follow-up, the
      same rule as a reclassified field below; a span is never rebuilt from
      only the first or the last class in its set, nor from its field's
      classes without the classes the detectors assigned. Stored unexamined
      ranges are rebuilt as unexamined content: they take the strictest
      action of any class on the tier, like any text the scan did not
      examine, and a range is never treated as examined because no span was
      stored for it (round 21). A saved message without stored evidence (saved
      before the evidence existed, or evidence that cannot be read) counts as
      unexamined, as in the budget rule below. On reopening and again before
      every request, each span's classification revision is compared with
      the effective field map revision in force. A span classified under an
      older revision would be reclassified from its field path, but saved
      evidence stores no field path, so it counts as unexamined, and so does
      the rest of its message, whatever the source of the change and whether
      it raised or lowered the class; otherwise its stored classes apply
      (decided by the lead 2026-11-20, from the unexamined rule; any change
      since round 20; the span's own revision, round 22).
- [ ] The effective field map revision versions the field map the app
      actually applies, not only the map it ships. It is one number kept in
      the local database that changes whenever any source changes the
      classes of any field, a raise or a remap to a lower class: an update to
      the shipped field map, a reclassification in Settings, or a
      reclassification in the IT policy file (`dataPolicy.fieldClasses`). A
      lower class can still be stricter on a tier: with Security on Hosted at
      Allow and Configuration on Hosted at Block, a remap from `security` to
      `configuration` in the IT policy file blocks a value that was sent
      before. A change that leaves every field's classes as they were, such
      as an IT policy file reloaded with the same mappings, leaves it as it
      is. A move in Settings and an app update advance it when they apply.
      The IT policy file is read once per launch (`main.ts` loads it before
      anything reads the provider; the file is not watched), so a change to
      the file advances the revision when the app reads the new file, at the
      next launch, never when the file is written; until then the strip,
      Settings and every check use the revision in force (round 23). The
      in-memory checks below test the check against a revision change from
      any source; they do not assume the file is read during a session.
      Saved evidence stores each span's classification revision, the
      revision under which its classes were computed, never the revision in
      force at save, and a reopened conversation compares it with the
      revision in force on reopening and before every request: a span
      classified before any class change, from any of the three sources,
      counts as unexamined with the rest of its message, even when the
      message used no field that changed. The shipped map version alone
      never decides it (any change, not only a raise, decided by the lead
      2026-11-20, round 20; per span, round 22).
- [ ] Just before each model call, the final request (system text plus
      prompt, including the admin's own words) is scanned against the ledger
      and the detectors, in the gate every model request passes: the
      decorator in `buildLlm` for provider calls, and the Hosted gate for
      hosted voice context and web search (A3).
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
10. Stored evidence: a saved Chat message keeps its spans (offset, length,
    and the full set of classes that applied to the span when the message
    was saved: every class its field had held and every class a value
    detector assigned, and its own classification revision, the effective
    field map revision under which its classes were computed, not the one
    in force at save), its unexamined ranges (offset and length) in the
    local database and no other copy of its values; Disconnect and deleting the conversation remove the
    evidence with the messages (test). When the unexamined ranges cannot be
    stored for a message, the evidence marks the whole message as
    unexamined (test).
11. The effective field map revision changes when the shipped map, a
    Settings reclassification or an IT policy reclassification changes any
    class of any field, a remap to a lower class included (the shipped map
    and the IT policy file), and stays the same for a change that leaves
    every field's classes as they were (test per source).
12. In-memory ledger (test): a ledger entry from a `configuration` field,
    classed under revision 41, is used in a request after a Settings raise
    of that field to `security` (revision 42) without the conversation
    being closed. The check before the request reclassifies it from its
    field path, its set holds `configuration` and `security`, and its action
    is the strictest of the two. A ledger entry with no field path,
    classed under revision 41, counts as unexamined in the same request.
13. In-memory ledger, remap to a lower class (test): a ledger entry from a
    field mapped as `security`, classed under revision 41, is used in a
    request after a remap of that field to `configuration` from the IT
    policy file is read (revision 42), with Security on Hosted at Allow and Configuration on
    Hosted at Block. The check before the request reclassifies it from its
    field path, its set holds `security` and `configuration`, and its action
    on Hosted is Block. A revision that advanced only on raises would stay
    at 41 and keep the entry at `security`, which Hosted allows, and the
    test fails on it.

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

- [ ] One Hosted gate for every model request that leaves the device. Routing
      acts on the scan of the final request, and the gate is the only code
      that sends text to a hosted model. It covers these paths by name:
      - provider calls built in `buildLlm`, through a data policy decorator
        applied there, so agent runs, Chat, Office, drafts, follow-ups and the
        Nova command all pass through it;
      - hosted voice context, the session start included (next item);
      - the Nova web search request (`intune-chat/web-search.ts`, which calls
        an OpenAI model directly with the Nova key). Web search keeps the
        public research boundary (SPEC.md: outbound queries are public
        research) on top of the gate: a query never carries tenant data of
        any class, whatever the rules on Hosted allow. The query is written
        from public inputs only. The boundary is enforced on the final
        outbound query, around the Hosted gate, in this order (round 18,
        step 1 and the final check from round 19, step 6 from round 20,
        its coverage rule and step 7 from round 21):
        1. Everything the app recognizes as tenant data in the query is
           removed, never masked as a token, whatever the rules on Hosted
           allow: ledger matches, tenant value index matches and detector
           matches (email addresses, GUIDs, IP addresses, serial numbers
           and credential patterns), of any class, configuration included
           (such as an internal app name from the cache), and any value A4
           restored into the tool's parameters.
        2. The Hosted gate scans what remains and applies the rules on
           Hosted. Text it cannot examine follows the rule for unexamined
           data: masked one way as `[CREDENTIAL]` when Mask is the strictest
           action on Hosted, withheld when any rule on Hosted is Block. When
           the gate blocks, the search is not sent, no network request is
           made, and Chat shows the designed state that names the reason
           (mockup 34, E, "Withheld by the data policy check"); its recovery
           is a shorter search or an answer without searching.
        3. A final check scans the gate's result with the same recognizers
           as step 1 and removes any recognized span still present, also
           where the rule on Hosted is Allow, since the gate sends an
           allowed class as is.
        4. Every placeholder is removed from the result: a stale one with no
           mapping in the ledger (such as `[USER_2]` left from an earlier
           masked answer) and any token the gate produced (such as
           `[CREDENTIAL]` for an unexamined tail it masked).
        5. The app checks whether meaningful text remains. When none
           remains, the search is not sent, no network request is made, and
           Chat shows the designed state (mockup 34, E, "Web search without
           tenant data").
        6. The last scan before sending: the exact string that would be
           sent is scanned once more by every recognizer, the ledger, the
           tenant value index and the detectors. Removing a placeholder can
           join a value the earlier steps could not see, as
           `WGB Expen[USER_2]ses` becomes `WGB Expenses`. When any
           recognized span is found, the search is not sent, no network
           request is made, and Chat shows the designed state (mockup 34,
           E, "Tenant data found in the final search words"). The string is
           never edited again after this scan, so what is sent is exactly
           what was scanned; its recovery is writing the search words again
           or an answer without searching. This scan needs complete coverage
           (round 21): every recognizer must finish on the whole string.
           When any recognizer did not finish, because its work budget ran
           out, it timed out or it failed, the string counts as not
           checked, whatever the rules on Hosted are: the search is not
           sent, no network request is made, and Chat shows the designed
           state (mockup 34, E, "The final check of the search words did not
           finish"), with a shorter search and an answer without searching
           as the recovery. A recognizer that did not finish is never read
           as one that found nothing.
        7. The length check, after every other step (round 21): the 1,000
           character cap that `searchPublicWeb` applies today moves from the
           query as written to the exact string that passed step 6. That
           string is measured as is and never cut, since cutting it would
           edit it after the last scan. A string longer than 1,000
           characters is not sent, no network request is made, and Chat
           shows the designed state with a shorter search and an answer
           without searching as the recovery. A query the model wrote
           longer than the cap is not refused on that ground alone; the
           cap is decided on what would be sent.
        Only the text that passed all seven steps is sent. Text the app
        cannot recognize, such as an internal project name it has never
        seen, can still reach the search provider; the web search copy and
        the docs say so, as the remote MCP boundary does.
        Switching to a local model is not offered, since web search always
        goes to OpenAI. Whenever web search is offered, the status strip
        names its destination ("Web search · OpenAI"), also when the chat
        model is local, so "No data leaves this device" is never shown
        while search is offered (mockup 34, B and E).
      Any future path that sends text to a hosted model must go through the
      same gate. A test enforces it: it fails when a module outside the gate
      calls a hosted model endpoint (a hosted provider SDK, a vendor CLI, or
      a request to a hosted model host such as `api.openai.com`).
- [ ] Clipping never splits a classified value (round 23). Every cut the app
      makes to fit a request bound for a hosted model, the profile budget
      (B2), the history budgets of Chat, the evidence excerpts and their
      compaction (such as the excerpt cut in `agentic-loop.ts`) and the
      voice answer pack, keeps whole every span the ledger, the tenant value
      index or the detectors classified. When a cut would fall inside such a
      span, the whole span is left out, and the notice for that clip (the
      clipping notice for the profile, the note on shortened history or
      evidence) says what was left out by part and class, never the value. The
      retained ranges keep the classification the full text gave them; a
      cut never makes the app classify a shorter text from scratch. A cut
      is made only inside text the scan examined completely (round 24).
      When the scan of a part the app can clip (an instruction block, a
      note, a history turn, an evidence excerpt) did not finish, because
      its work budget ran out, it timed out or it failed, that whole part is
      left out, never cut, since a cut inside unexamined text could split a
      value no recognizer saw whole; the notice for that clip names the part
      and says it was left out because its check did not finish. When the
      unfinished part cannot be left out, such as the fixed rules, the
      request is withheld, whatever the rules on Hosted are: typed Chat
      shows the designed state "Withheld by the data policy check" with its
      recovery, and hosted voice builds the fallback or, when the part is
      one the fallback keeps, shows "Hosted voice did not start" (this
      phase, the session start). The complete scan of the serialized
      request (this phase) still runs on what would be sent, after every
      cut and every part left out. A prefix of a classified value,
      such as "WGB Fin" of a policy name, is what a cut through it would
      send, and the index and the detectors may not recognize it (B2,
      criteria 3 and 4).
- [ ] `nova.ts` and the renderer call the same Hosted gate for tenant data
      the app sends to the voice model as context: it goes through the
      same request scan and follows the same rules as any hosted call, class
      by class (masked, blocked or sent as is). The first transfer is the
      session start request, and the gate scans the complete serialized
      instructions `nova.ts` would send when the OpenAI session opens, not
      only the profile block (round 21): the fixed rules, the tenant name and
      tenant id in the verified app connection line, the greeting name, the
      provider and model names, the profile block with standing instructions
      and confirmed notes, and every other line. It goes through the same
      scan and rules as every later context transfer, and the voice popover
      lists it as its own transfer. Every scan that could open the session
      must cover the whole text, the first scan included (round 22): the
      session never opens on a scan whose work budget ran out, that timed
      out or that failed, also when no rule on Hosted is Block and the
      strictest action there is Mask, so unexamined start text is never
      masked one way and sent. When the first scan does not cover the whole
      text, the session does not open on it. The app either builds the
      fallback below without the parts the scan did not examine, by the same
      rules as for a blocked class (the profile block whole when an
      unexamined range falls in it; the tenant name, the tenant id or the
      greeting name replaced by neutral wording when a range covers it), and
      rescans it in full, or, when an unexamined range falls in a part the
      fallback keeps (the fixed rules, the provider and model names), shows
      the designed state "Hosted voice did not start" without sending
      anything. When a rule blocks a class anywhere in
      the instructions, the app builds a fallback without the blocked parts:
      - the profile block is left out whole when it carries a blocked class
        (decided 2026-11-19, not per note);
      - the tenant name, the tenant id and the greeting name are each
        replaced by neutral wording where the rule covers the class the scan
        gave them ("an organization is selected; its name is withheld by
        data policy", "the organization's tenant id is withheld by data policy", "no
        greeting name in this call"), so the voice model
        still knows that a tenant is connected and does not greet by name;
      - nothing else is changed.
      The fallback is scanned again, in full, before the call opens. When the
      rescan finds no blocked content and covers the whole text, the call
      opens with the fallback, and the voice model, the transcript and the
      popover say what the call opened without (the profile, the
      organization name, the tenant id, the greeting name). When the rescan still finds
      blocked content, or does not cover the whole text (its budget ran out,
      it timed out or it failed), the call does not open: nothing is sent to
      OpenAI, no audio is streamed, and the designed state says why. Its
      recovery offers only what would work: for blocked content, it names the
      rule and the part it could not leave out and offers voice on this
      device and Change the rule, or the policy file and key instead of
      Change the rule when IT set the rule; for a scan that did not finish
      (the first scan or the rescan), it offers voice on this device and
      Start the call again, which scans the whole start request again before
      anything is sent (mockup 34, B, "Hosted voice did not start"). A scan of the profile block alone would send a greeting name
      or a tenant name a rule blocks, and is not enough. The voice model speaks roles
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
      outcome. A session start that opened with the fallback records two
      facts (round 24): what it opened without and why, and the fallback's
      own outcome, sent with the count of values masked in it (for example
      opened without the profile, with the tenant id and the greeting name
      masked); the popover line shows both from the record. The rules in force now drive only the strip, a preview labelled
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
- [ ] Saved history in a follow-up. History whose evidence was rebuilt (A1) is
      routed and masked like any other part of the request, by its stored
      classes and by the scan of the final request, unless a span's
      classification revision (the revision its classes were computed under,
      A1, round 22) is older than a later class change from any source, a
      raise or a remap to a lower class, checked on reopening and before
      every request, in which case its message counts as unexamined. Each span's action is the
      strictest across every class in its stored set (its field's class
      history and every class a value detector assigned to it when saved),
      recomputed under the rules in force at the follow-up, so a span whose
      field once held `security` is blocked when Security is Block on the
      tier, whatever class it held last, and a name the tenant index
      recognized as `identity` when saved keeps `identity` after it leaves
      the index. The stored unexamined ranges of a message (A1, round 21)
      count as unexamined and take the strictest action of any class on the
      tier, so a partially examined message is withheld when any rule on the
      tier is Block, even when its examined spans would be sent; a message
      whose unexamined ranges could not be stored counts as unexamined as a
      whole. History without stored
      evidence counts as unexamined and takes the strictest action of any
      class on the tier: with a Block on the tier it is withheld, and the
      follow-up is not sent with it; with Mask as the strictest action it is
      masked one way and never restored. The follow-up says which earlier
      messages were left out or masked and why, and offers Ask without the
      earlier answers (the question alone, with no saved history in the
      request) and a local model only when no Local rule is Block (mockup 34,
      F, "A conversation reopened after a restart").
- [ ] An open conversation follows the same revision rule (A1, round 18).
      Before every follow-up, the evidence in the conversation's in-memory
      ledger is checked against the effective field map revision: a value
      classed under an older revision is reclassified from its field path,
      keeping every class it held, and a value that cannot be rebuilt counts
      as unexamined. A follow-up never uses a class from before a class
      change, a raise or a remap to a lower class, because the conversation
      stayed open. When such a value withholds the
      follow-up, it shows the same designed state and recovery as a
      reopened conversation (mockup 34, F, "A follow-up in a conversation
      that stayed open").
- [ ] Agent manifests declare `descriptor.dataClasses`, derived when absent, with
      a qa-graph check and the JSON Schema updated in the same commit. Agent
      details show what an agent reads. Preflight refuses a run the policy would
      block, with a designed state.
- [ ] The sandbox host applies the same engine.

**Acceptance criteria:**
1. A test per path (agent run, Chat deterministic, Chat streaming, agentic loop,
   Office, follow-up, hosted voice context, web search) shows a blocked class
   never reaches the model.
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
   session start as its own transfer (renderer test). The scan input is the
   complete serialized instructions, fixed rules, tenant name, tenant id and
   greeting name included, and the request that opens the session is the
   rescanned fallback (test).
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
11. Restart regression test: a Chat answer restored the name of a Conditional
   Access policy that is absent from the current tenant value index. The app
   restarts, the conversation is reopened, and a hosted follow-up is asked
   with Security on Hosted at Block: the name reaches no provider request,
   and the follow-up shows the designed blocked state. A calculation from the
   current index alone would miss the name, and the test fails on it.
12. History without evidence (test): the same conversation with its stored
   evidence removed, Security on Hosted at Block. The earlier messages count
   as unexamined and are withheld, the follow-up is not sent with them, and
   the notice names the messages left out and offers Ask without the earlier
   answers, and a local model only when no Local rule is Block. With no
   Block on Hosted, the earlier messages are masked one way and the answer
   says so.
13. Same-revision restart regression test: a field mapped as
   `configuration` is moved to `security`, then to `identity`, and only then
   is a value from it restored in a local Chat answer that is saved, so no
   class changes after the save and its effective field map revision
   stays current. The value is later gone from the current tenant value index,
   the app restarts, the conversation is reopened, and a hosted follow-up is
   asked with Security on Hosted at Block. The saved span's stored class
   list holds all three classes, the span is withheld, and the value reaches
   no provider request. A rebuild from one stored class would send it: the
   mapped `configuration` (Allow on Hosted by default) in clear text, the
   latest `identity` (Mask on Hosted by default) masked, and the test fails
   on either.
14. Same-version restart regression test for detector classes: a
   configuration field (mapped `configuration`, never reclassified) holds a
   person's display name that the tenant value index recognizes as
   `identity`, and the value is restored in a local Chat answer that is
   saved. The saved span's stored set holds `configuration` and `identity`.
   The name is later gone from the index, the app restarts with no class
   changed since the save (the same effective field map revision), the
   conversation is reopened, and a hosted follow-up
   is asked with Identity on Hosted at Mask, then at Block: the name is
   masked, then withheld, and never reaches a provider request in clear
   text. A rebuild from the field's classes alone would send it as
   configuration, and the test fails on it.
15. Restart regression test for a raise in Settings: a local Chat answer
   restores the name of a Conditional Access policy from a field that is
   `configuration` at the time, and the answer is saved with its span
   classified under the current effective field map revision. The admin then raises that field to
   `security` in Settings, which changes the revision. The name is later
   gone from the tenant value index, the app restarts, the conversation is
   reopened, and a hosted follow-up is asked with Security on Hosted at
   Block. The saved messages count as unexamined and are withheld, the name
   reaches no provider request, and the follow-up shows the designed state.
   A check of the shipped field map version alone would find it unchanged
   and send the name as configuration, and the test fails on it. The same
   test with the raise made in the IT policy file gives the same result.
16. Web search regression test: Ollama is selected, Configuration on
   Hosted is Allow, and the question names the tenant's internal app WGB
   Expenses from the cache. Nova writes a web search query that holds the
   app name: the fake request function receives the query without WGB
   Expenses, and the app name never reaches the search request, although
   the rule would allow configuration on Hosted. A query that holds only
   the name of a Conditional Access policy leaves nothing meaningful once
   the name is removed: the fake receives no call, nothing is sent to
   `api.openai.com`, and Chat shows the designed state. With hosted
   reasoning and Security on Hosted at Mask, a query the model wrote with
   `[CA_POLICY_1]`, restored to the name in the tool parameter by A4,
   reaches the fake with neither the name nor the token. A gate only in
   `buildLlm`, or a search that follows the Hosted rules alone, would send
   the app name, and the test fails on it. A renderer test asserts that
   the strip names OpenAI for web search while it is offered with a local
   chat model and never reads "No data leaves this device" then.
17. Gate coverage test: a test lists every module that calls a hosted model
   endpoint and fails when one of them sends without the Hosted gate,
   including a new module added later.
18. Web search order regression test, stale placeholder: an earlier answer
   in the conversation masked a user as `[USER_2]`, and its mapping is no
   longer in the ledger. Nova writes the search "[USER_2] Win32 app not
   detected after install 24H2". The fake request function receives the
   query without `[USER_2]` and with the public words. A query that held
   only `[USER_2]` leaves nothing meaningful: the fake receives no call.
   A step that removed only values with a mapping would send the token, and
   the test fails on it. This test covers stale tokens only; the order of
   placeholder removal and the gate is covered by criterion 19.
19. Web search order regression test, gate token: with the default rules on
   Hosted (Credential at Mask, no Block on the tier), Nova writes a search
   with public words followed by a public install log excerpt the admin
   pasted into the question. The excerpt and the whole query stay within
   the 1,000 character cap, and the test sets the scan's work budget below
   the excerpt's length, so the budget runs out on it. The gate masks the unexamined tail one way as
   `[CREDENTIAL]`, and the fake request function receives the public words
   with neither the tail nor `[CREDENTIAL]`. A search that removed
   placeholders before the gate would send the token, and the test fails
   on it. This is the test for the order of placeholder removal after the
   gate.
20. Web search withheld by the gate (test): Activity on Hosted is Block and
   Nova writes a search with a public install log excerpt the admin pasted
   into the question, within the 1,000 character cap, and the test sets the
   scan's work budget below the excerpt's length. Public words remain after step 1, the gate reports the
   unexamined tail, the strictest action on Hosted is Block, and the fake
   receives no call. Chat shows the withheld state with the reason and
   offers a shorter search and an answer without searching (renderer test).
21. Open conversation regression test: a local Chat answer restores the
   name of a Conditional Access policy from a field that is `configuration`
   at the time, and the conversation stays open, with no restart. The
   admin raises that field from `configuration` to `security` in Settings,
   which changes the effective field map revision, and asks a hosted
   follow-up with Security on Hosted at Block. The check before the request
   reclassifies the ledger entry from its field path, the name reaches no
   provider request, and the follow-up shows the designed blocked state. A
   ledger that kept the class from the older revision would send the name
   as configuration, and the test fails on it.
22. Web search regression test, detector only: Identity on Hosted is Allow,
   and Nova writes the search "j.morgan@contoso.com Outlook profile keeps
   asking for password". The address is in neither the ledger nor the
   tenant value index; only the email detector finds it. Step 1 removes it,
   and the fake request function receives the public words without the
   address, which never reaches the search request. A spy on the Hosted
   gate asserts on its own that the gate's input already holds the public
   words without the address, so the test fails on a step 1 that left the
   address for step 3 to remove, even though the request would be clean.
   A step 1 that removed only ledger and index matches would leave
   the address to the gate, which sends an allowed class as is, and the
   test fails on it. A separate unit test of the final check alone (step 3)
   is given gate output that still holds the address under Allow and
   removes it.
23. Web search final string regression test: an earlier answer masked a
   user as `[USER_2]`, and its mapping is no longer in the ledger. Nova
   writes the search "WGB Expen[USER_2]ses not detected after install
   24H2", and WGB Expenses is in the tenant value index. Step 1 and the
   final check recognize nothing in the split name, step 4 removes the
   stale placeholder and joins it, and step 5 finds meaningful text. The
   last scan finds WGB Expenses in the exact string to be sent: the fake
   request function receives no call, nothing is sent to `api.openai.com`,
   and Chat shows the designed state (renderer test). A search that sent
   the string after step 5, or that removed the joined name and sent the
   rest, would fail the test.
24. Remap to a lower class, live and reopened (regression tests): Security
   on Hosted is Allow and Configuration on Hosted is Block. A local Chat
   answer restores a value from a field mapped as `security`, and an IT
   policy file that remaps that field to `configuration` is then read,
   which changes the effective field map revision (at the next launch in
   the app, since the file is read once per launch; the live case drives
   the same revision change into the open conversation directly). The value is no longer in the tenant
   value index. In the conversation that stayed open, a hosted follow-up
   reclassifies the ledger entry from its field path, its set holds
   `security` and `configuration`, the value reaches no provider request,
   and the follow-up shows the designed blocked state. After a restart,
   the reopened conversation counts the saved messages as unexamined, they
   are withheld under the Block on Hosted, and the value reaches no
   provider request. A revision that advanced only on raises would keep
   the value at `security`, which Hosted allows, and send it in both
   cases, and the tests fail on it.
25. Voice session start regression test, empty profile: the profile block is
   empty (no standing instructions, no confirmed notes), the greeting name is
   the admin's display name, which the tenant value index recognizes as
   `identity`, and Identity on Hosted is Block. The gate scans the complete
   instructions, finds the greeting name, replaces it with the neutral
   wording and rescans the fallback, which is clean: the fake session
   receives instructions without the greeting name, and the popover says the
   call opened without the greeting name. A scan of the profile block alone
   finds nothing in an empty profile and sends the name, and the test fails
   on it. In a second case the test sets the rescan's work budget below the
   fallback's length: the rescan does not cover the whole text, the strictest
   action on Hosted is Block, the fake session receives no request, no audio
   is streamed, and the designed state "Hosted voice did not start" names
   the reason (renderer test).
26. Same-revision restart regression test, partially examined message: a
   Chat question holds a public log excerpt the admin pasted, and with the
   test's work budget set below its length the scan examines the first part
   and not the tail. The local answer is saved, and the evidence stores the
   found spans and the unexamined range of the tail. No class changes before
   the restart, so the effective field map revision is still current. The
   app restarts, the conversation is reopened, and a follow-up goes to a
   test provider of the Confidential tier with Credential on Confidential at
   Allow (after the confirmation dialog) and Identity on Confidential at
   Block. The stored unexamined range takes the strictest action on
   Confidential, Block: the message is withheld, the tail reaches no
   provider request, and the follow-up shows the designed state. A rebuild
   from the stored spans alone, or one that gave the range only the
   credential rule (Allow there), would send the tail, and the test fails on
   either. With the storage of the unexamined ranges made to fail at save,
   the whole message counts as unexamined and is withheld in the same way.
27. Web search final scan coverage (test): with no Block on Hosted, Nova
   writes a public search that steps 1 to 5 leave unchanged. In three cases
   one recognizer does not finish on the exact string at step 6: the tenant
   value index fails with an error, the detectors run out of their work
   budget, and the ledger times out. In each case the fake request function
   receives no call, nothing is sent to `api.openai.com`, and Chat shows the
   designed state with Shorten the search and Answer without searching
   (renderer test). A step 6 that read a recognizer that did not finish as
   one that found nothing would send the string, and the test fails on it.
28. Web search length cap (test): Nova writes a search of 1,400 characters
   of which step 1 removes 520 characters of recognized tenant values; the
   880 characters left pass every step, and the fake request function
   receives exactly that string. Another search leaves 1,020 characters
   after step 6: the fake receives no call, and Chat shows the designed
   state with a shorter search and an answer without searching. A cap
   checked on the query as written would refuse the first search, a cap
   that cut the string would send the second, and the test fails on
   either.
29. Voice session start coverage regression test, default rules: no rule on
   Hosted is Block, so the strictest action on Hosted is Mask. The test sets
   the first scan's work budget below the length of the complete
   instructions, so the first scan examines the fixed lines, the tenant
   name, the tenant id and the greeting name and stops inside the profile
   block. No session request is sent and no audio is streamed on that scan.
   The app builds the fallback without the profile block and rescans it. In
   a first case the rescan covers the whole fallback and finds nothing
   blocked: the fake session receives the fallback, which holds no part of
   the profile, and the popover says the call opened without the profile
   because part of it could not be examined. In a second case the rescan's
   budget is also below the fallback's length: the fake session receives no
   request, no audio is streamed, and "Hosted voice did not start" offers
   Start the call again and voice on this device. In a third case the first
   scan stops inside the fixed rules, which the fallback keeps: the fake
   session receives no request, no audio is streamed, and the same designed
   state shows. A gate that opened the session on the first scan with the
   unexamined tail masked one way, Mask being the strictest action on Hosted
   under the defaults, would send a request, and the test fails on it
   (renderer test).
30. Classification revision regression test, a remap between classification
   and save: a local Chat answer restores the description of a
   configuration profile from a field mapped `configuration`, and its ledger
   entry is classed under effective field map revision 41. While the answer
   streams, the admin moves that field to `security` in Settings, which
   applies at once and makes revision 42, and the answer is saved after
   that, so 42 is in force at save. The stored span keeps revision 41, the revision its classes were
   computed under, and its stored set holds `configuration` only. The
   description is later gone from the tenant value index, the app restarts,
   the conversation is reopened, and a hosted follow-up is asked with
   Security on Hosted at Block. The span's revision 41 is older than 42, so
   the message counts as unexamined and is withheld, the description
   reaches no provider request, and the follow-up shows the designed state.
   Evidence that stored the revision in force at save (42) would read the
   span as current and `configuration`, which Hosted allows, and send it,
   and the test fails on it. In a second case the answer is saved with its
   span classed under revision 42, the conversation is reopened, and only
   then does a Settings move change a class (revision 43): the check before
   the next follow-up counts the message as unexamined in the same way. In
   a third case the change comes from the IT policy file, which the app
   reads once per launch (`main.ts` loads it before anything reads the
   provider; it is not watched): the answer is saved under revision 41, the
   file on disk is changed to map the field to `security` while the app
   runs, and revision 41 stays in force, with the strip and Settings
   unchanged, until the app reads the new file at the next launch, which
   makes revision 42. After that launch the conversation is reopened and
   the message counts as unexamined in the same way. The revision advances
   when the new file is read, never when it is written (round 23).

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
- [ ] The profile budget never splits a classified value (round 23). The
      ledger, the tenant value index and the detectors classify the profile
      block before it is clipped. When the cut of `clipToBytes` in
      `nova-profile.ts` would fall inside a span they classified (a policy
      name, a person's name, a device name, a GUID, a credential pattern),
      the cut moves to the start of that span and the whole span is left
      out, never a prefix of it. The clipping notice says what was left out,
      by part and class ("the organization instructions were cut before a
      security value, which was left out whole"), never the value itself.
      The retained text keeps the classes the full text gave it, so a value
      that is recognized only in its full context keeps its class after the
      cut. The cut is made only inside text the scan examined completely
      (round 24): when the scan of a part of the profile block (the
      standing instructions, the organization instructions or a note) did
      not finish, that whole part is left out, never cut, and the clipping
      notice names the part and says its check did not finish ("the
      organization instructions were left out because their check did not
      finish"). The complete scan of the serialized request still runs on
      what would be sent, as in A3. This holds for typed Chat and for hosted
      voice alike, and for every other clipping before a hosted request (A3).

**Acceptance criteria:**
1. A typed Chat answer follows a standing instruction (test with a fake model
   that asserts the block is in the prompt).
2. Clipping is announced at the start of the conversation, as it is for voice
   today (mockup 35, section G).
3. Clipping regression test, typed Chat: the organization instructions say
   "When a finance user cannot sign in, check WGB Finance MFA first", and
   the tenant value index knows WGB Finance MFA as a Conditional Access
   policy, `security`. Security on Hosted is Block, and the test sets the
   profile budget so that the cut falls inside the policy name. A typed
   Chat question goes to a hosted provider. The fake model's request holds
   the organization instructions up to "check" and no part of the policy
   name ("WGB", "WGB Fin" or any other prefix), the scan of the serialized
   request finds no blocked content, the request is sent, and the clipping
   notice at the start of the conversation says a security value at the cut
   was left out whole. A clip that cut through the name would send "WGB
   Fin", which the index does not match and the scan cannot read as
   security, and the test fails on it. Second case, an incomplete scan
   (round 24): the same instructions, rules and budget, and the test sets
   the work budget of the scan before the clip so that it stops inside
   WGB Finance MFA. The organization instructions are left out whole: the
   fake model's request holds none of their text, the standing
   instructions and the notes that fit stay, the scan of the serialized
   request covers the whole text and finds no blocked content, the
   request is sent, and the clipping notice says the organization
   instructions were left out because their check did not finish. A cut at
   the budget inside the unexamined text would send "WGB Fin", and the
   test fails on it.
4. Clipping regression test, hosted voice start: the same organization
   instructions, rules and budget. Hosted voice starts. The fake session's
   start request holds the clipped profile with no part of the policy name,
   the scan of the complete serialized instructions covers the whole text
   and finds no blocked content, the call opens, and the clipping notice
   shown once in the call says a security value at the cut was left out
   whole. A start that cut through the name would send its
   prefix, and the test fails on it. Second case, an incomplete scan
   (round 24): the scan before the clip stops inside WGB Finance MFA, as in
   criterion 3. The start request holds the profile without the
   organization instructions and with no part of the policy name, the scan
   of the complete serialized instructions covers the whole text and finds
   no blocked content, the call opens, and the clipping notice shown once
   in the call says the organization instructions were left out because
   their check did not finish. A start that cut inside the unexamined text
   would send its prefix, and the test fails on it.

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
- [ ] Deliveries from runs the personal agent starts. The gate is the run's
      origin, checked before anything enters the automatic delivery queue
      (`enqueueRunDeliveries` and `runDeliveryQueue` in
      `apps/desktop/electron/run-delivery.ts`). The run record says who
      started it (today `trigger` is `manual` or `schedule`; a run the
      personal agent started gets its own origin), and a run with the
      personal agent's origin is never added to that queue, for any
      connector the queue handles: Teams, Outlook, Slack, Discord, WhatsApp
      and Signal, and any connector added to it later. The gate does not
      list connectors; it sits in front of the queue as a whole, so a new
      connector is covered without a change to it. A run with no recorded
      origin is not treated as one the personal agent started. When the
      agent starts an installed agent that has a saved delivery route,
      no delivery from that run is posted when the run finishes. Each one is
      proposed on the same per-message confirmation card, with the final text
      that would be posted, the destination of the saved route, the
      organization and the run, and Confirm runs the same call-time checks
      (active organization, send grant, connection, length). Nothing posts
      without a click, a run with two routes gets two cards, and a "Not sent"
      card keeps the run's result on this device. The run card the agent
      shows before it starts the run (today "Existing saved result-delivery
      routes may send notifications", in
      `apps/desktop/electron/nova-actions.ts`) says instead that each
      delivery waits for a confirmation. Runs started outside the personal
      agent, such as a scheduled run or Run in Agents, keep the agent's own
      delivery behaviour; this plan does not change it.
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
9. Saved Teams route (regression test): the personal agent starts an
   installed agent whose saved delivery route posts to a Teams channel. When
   the run finishes nothing is posted; a card shows the final message text,
   the team and channel of the route, the organization and the run. Cancel
   posts nothing, Confirm posts exactly one message after the call-time
   checks, and with Send to Teams turned off, Teams not connected or another
   organization active, Confirm reads "Not sent" with the fix. The same agent
   started on its schedule delivers by its route as before, with no card
   (test, mockup 35).
10. Signal route started by the personal agent (regression test): the
   personal agent starts an installed agent whose saved delivery route sends
   to Signal. When the run finishes, `runDeliveryQueue` holds no item for the
   run and nothing is sent to Signal; a card shows the final text, the
   Signal destination of the route, the organization and the run, and
   nothing is sent without a click on Confirm, which runs the call-time
   checks. The test repeats for every connector the queue handles (Teams,
   Outlook, Slack, Discord, WhatsApp, Signal) and for a test connector
   registered with the queue only for the test, so a connector added later
   is covered by the same gate.
11. Scheduled Signal route (regression test): the same agent started on its
   schedule sends its result to Signal through the automatic delivery queue
   as before, with no card, and a run started with Run in Agents keeps its
   behaviour too.

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
- [ ] A server's endpoint is its full URL without the fragment: scheme,
      host, port, path and query string (round 19). Two addresses that
      differ in any of these, the query string alone included, are
      different endpoints; the fragment is never sent and is not part of
      the endpoint. Approvals, the tool review, the redirect rule and the
      status strip all use this endpoint.
- [ ] Step 2, the tool review, reviews exactly the endpoint step 1 continued
      with: it names the host from that address and shows the full address
      whose `tools/list` it shows. It always opens with every tool
      unchecked. Changing the address in step 1 clears step 2 until Continue
      lists the new endpoint, and opening the review again starts unchecked.
      An approval belongs to the endpoint (the full URL without the
      fragment) it was given for and never carries over to another endpoint, even for a tool with
      the same name and an identical definition.
- [ ] Redirects never change the endpoint (round 18, query string from
      round 19). During tool listing (step 2 and every later `tools/list`)
      and every tool call, a redirect that changes the endpoint, meaning any
      change of scheme, host, port, path or query string, including a
      redirect that changes only the query string, is refused: the target is never requested, nothing from the
      call (credential, tool parameters) is sent there, and the listing or
      call fails with a designed state that names the redirect target and
      asks the admin to add that address as its own server, which gets its
      own allowlist check and a fresh tool review with every tool unchecked
      (adding it starts step 1 with that address filled in). An approval
      never follows a redirect. While listing is refused, the app cannot hash
      the server's tools, so none is offered and the strip rule above leaves
      the host out. This tightens the MCP transport,
      which today follows a redirect within the same origin
      (`sameOriginFetch` in `apps/desktop/electron/mcp/host.ts`), so a path
      or query string redirect on the same host is refused as well (mockup 35, "A redirect
      to another address").
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
      included. A tool that documents a write anywhere in it is flagged
      (saving, changing, sending, deleting, editing, updating, modifying,
      setting, writing, creating, assigning, removing, revoking and the
      like), in the first review and in every re-review;
      a flagged tool cannot be approved in any review state, with the reason
      (the matched words and the JSON path of each, for example
      `annotations.title` or `inputSchema.properties.mode.enum[1]`) shown in
      its row and marked in both views. The approval is enforced at every
      call, including calls from skills and scheduled checks. A tool that is
      not approved, or added by the server later and not yet reviewed, is
      never offered. The word list in mockup 35 is illustrative: the
      implementation must treat any write the definition documents as
      disqualifying, whatever words it uses and regardless of the read-only
      label.
- [ ] Approval is bound to the hash of the complete object, computed in
      exactly this way: serialize the object with the RFC 8785 JSON
      Canonicalization Scheme (JCS), then take SHA-256 over the UTF-8 bytes
      of that serialization. JCS sorts object keys by their UTF-16 code
      units at every level and emits members in that order (so a key "10"
      comes before "2"), writes numbers with the ECMAScript number
      serialization and strings with its fixed escaping, and refuses input
      that is not I-JSON, such as a lone surrogate or a non-finite number.
      The implementation must not rely on a generic JSON serializer's key
      order. The raw view prints the object in JCS order, and each review
      row shows the short form of the hash while the definition shows the
      full hash with Copy. The app hashes the object the server lists before
      it offers a tool and again at every call; any change anywhere (a
      nested schema property, an enum value, `annotations.title`, `_meta`,
      an unknown field, or the name under the same id) invalidates the
      approval before the tool can be offered or called. The tool returns to
      review, unchecked. Expanding a changed tool shows the complete
      previously approved object and the complete current object side by
      side, each readable and as raw JSON with the changed part marked, and
      each with its full hash that can be copied; the row shows the short
      form of both. A change that now documents a write makes it
      unapprovable (mockup 35, B, "Review 5 changed tools").
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
12. Regression test: a tool with `annotations.readOnlyHint: true` whose
    description says "Edits the selected tenant setting" (`tenant_setting`)
    is flagged by the write check with `description` named in the reason and
    cannot be approved, in the first review and in a re-review (mockup 35
    shows it disabled in the first review). The suite also covers write
    verbs beyond save, change, send and delete (edit, update, modify, set,
    write, create, assign, remove, revoke), and a documented write phrased
    without any of them, so the check is not a fixed keyword list.
13. Hash test vectors: the hash is SHA-256 over the UTF-8 bytes of the RFC
    8785 (JCS) serialization. A fixture with a nested object whose keys are
    "10" and "2" serializes "10" first; the RFC 8785 samples for key
    sorting, numbers and string escaping produce the RFC's output byte for
    byte; a lone surrogate or a non-finite number is refused. The app's
    hash of each fixture matches a reference JCS implementation.
14. Step 2 reviews the endpoint entered in step 1 and opens with every tool
    unchecked. A tool approved at one endpoint is not approved at a
    different endpoint, including another path on the same host, the same
    path with another query string, and an identical definition; changing the address clears the review, and
    opening it again starts unchecked (test, mockup 35).
15. A re-review shows, for a changed tool, the complete approved object and
    the complete current object side by side with both full hashes, and
    Copy puts the exact 64-character hash on the clipboard (test, mockup
    35).
16. Regression test, same-host path redirect: the server at
    `https://tools.contoso.example/mcp` answers 308 with
    `Location: /baselines/mcp`. In step 2, `tools/list` is refused, no
    request reaches `/baselines/mcp`, the review shows the designed state
    naming `https://tools.contoso.example/baselines/mcp`, and
    Continue stays disabled. For an approved server that starts answering
    the same redirect, a call to an approved tool from Chat, a skill and a
    scheduled check fails with the same state, and the fake server records
    no request at the target, so the tool parameters and the credential
    never reach it. A transport that followed same-origin redirects would
    send them, and the test fails on it. A change of scheme, host or port
    is refused the same way (test per component).
17. Regression test, query-only redirect: the server at
    `https://tools.contoso.example/mcp?tenant=a` answers 307 with
    `Location: /mcp?tenant=b`, same scheme, host, port and path. In step 2,
    `tools/list` is refused, no request reaches `/mcp?tenant=b`, the review
    shows the designed state naming
    `https://tools.contoso.example/mcp?tenant=b`, and Continue stays
    disabled. For an approved server at `/mcp?tenant=a` that starts
    answering the same redirect, a call to an approved tool fails with the
    same state, and the fake server records no request at the target, so
    the tool parameters and the credential never reach it. A rule that
    compared only scheme, host, port and path would follow the redirect and
    send them, and the test fails on it.

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
   withholds the whole profile block (decided 2026-11-19), and the scan
   covers the complete instructions with a rescanned fallback or no call
   (round 21).
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
10. ~~Saved Chat evidence under an older field map version~~ counts as
    unexamined when any class changed later, a raise or a remap
    to a lower class; otherwise its stored classes apply (lead, 2026-11-20,
    from the unexamined rule; any change since round 20). The version is
    the effective field map revision, advanced by the shipped map, Settings
    or the IT policy file (round 16). Evidence in an open conversation's
    in-memory ledger is checked against it before every request and is
    reclassified from its field path where it has one (round 18).
