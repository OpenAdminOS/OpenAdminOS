# OpenAdminOS Agent SDK

This guide is for authors who want to add or submit an OpenAdminOS agent.
The current public contract is a YAML Agent Template in
`agents/<slug>/manifest.yaml`, backed by the TypeScript types in
`packages/agent-sdk/src/index.ts` and the JSON Schema in
`schemas/agent-template.schema.json`.

OpenAdminOS agents run against the active Microsoft 365 tenant through
Microsoft Graph. They always use the configured LLM at least once. If the
agent only counts rows and never asks a model to reason over the evidence, it
is a query, not an OpenAdminOS agent.

## Files

A public registry agent lives under one directory:

```text
agents/<slug>/
  manifest.yaml
  README.md
  fixtures/        optional, when an agent needs local QA evidence
```

The slug must match `descriptor.id` and use lower-case hyphen-separated text,
for example `sign-in-failure-explainer`.

`agents/index.json` is generated from manifests. Do not edit it by hand unless
the generator requires it for the change you are making.

## Manifest Shape

Keep the YAML schema directive at the top of new manifests:

```yaml
# yaml-language-server: $schema=../../schemas/agent-template.schema.json
```

Top-level keys:

| Key | Required | Notes |
| --- | --- | --- |
| `descriptor` | yes | Identity, permissions posture, catalog metadata, and mode. |
| `execution` | no | Omit for the normal declarative template interpreter. Use only for the built-in MXC script preview path. |
| `skills` | yes | Ordered pipeline. Each step output is available as `{{ step_id.output }}`. |
| `definition` | yes | Settings, triggers, and result rendering. Read agents require `definition.result.summary`. |

## Descriptor Fields

| Field | Notes |
| --- | --- |
| `id` | Stable slug. Must match `agents/<slug>/`. |
| `name` | Human-readable name in Agent Hub. |
| `description` | Plain description of what the agent does. |
| `version` | SemVer, for example `1.1.0`. |
| `minAppVersion` | Minimum OpenAdminOS version that can install or run the agent. Public agents should set this. |
| `author.name` | Required. |
| `author.handle` | Optional public handle. |
| `author.verified` | Maintainer-owned marker for bundled or verified authors. |
| `category` | `devices`, `apps`, `policies`, `compliance`, or `updates`. |
| `tier` | `agent` or `dashboard`. Defaults to `agent` at parse time. Use `dashboard` for single-source narrated reports. |
| `requiresEntraTier` | `free`, `p1`, or `p2`. Defaults to `free`. Use `p1` for sign-ins, directory audits, Conditional Access policies, or user `signInActivity`. Use `p2` for Identity Protection data. |
| `mode` | `read` or `write`. Write mode requires a `write` step. Read mode cannot declare a `write` step. |
| `preferredModel` | Optional advisory model name. This is the current model field. There is no `modelRequirements` object in the manifest schema today. |
| `connectors` | Optional egress dependencies used by `connector` steps. |

Graph scopes are not declared as one top-level list. They are collected from
`graph` step `settings.scopes` and `write` step `settings.scopes`, then shown
to the user during install and preflight.

## Execution Kinds

The normal execution mode is declarative template execution. Leave
`execution` out, or set:

```yaml
execution:
  kind: template
```

The runtime interprets `skills` directly.

There is also an experimental built-in script path:

```yaml
execution:
  kind: script
  sandbox: mxc
  entrypoint: agent.mjs
  containment: process
  timeoutMs: 45000
```

Script agents run through the MXC sandbox broker. The `skills` block becomes
the permission manifest for broker calls such as `graph.request`,
`llm.complete`, `connector.invoke`, `write.plan`, and `log`. Script execution
currently supports read agents only. User-authored and community-submitted
agents should use YAML Agent Templates, not arbitrary script execution, until
the sandbox and review policy are hardened.

## Step Kinds

The current step formats are:

| Format | Purpose |
| --- | --- |
| `graph` | Read Microsoft Graph. The schema accepts Graph methods, but the template interpreter currently executes `GET` only. |
| `transform` | Reshape data locally. No Graph or LLM call. |
| `llm` | Ask the active provider to reason over prepared context. Required somewhere in every agent, including nested `map` pipelines. |
| `map` | Iterate a source array and run an inner pipeline per item. Used for per-row LLM judgment. |
| `write` | Build a write plan and pause for typed confirmation. Write agents support one `write` step today. |
| `connector` | Invoke a declared connector capability, usually for outbound notification. |

### `graph`

```yaml
- id: load_devices
  format: graph
  label: Load managed devices
  settings:
    method: GET
    path: /deviceManagement/managedDevices
    select: [id, deviceName, lastSyncDateTime]
    scopes:
      - DeviceManagementManagedDevices.Read.All
```

The runtime unwraps Graph collection responses from `{ value: [...] }` into an
array. `select`, string-valued OData `query` parameters, and headers such as
`ConsistencyLevel: eventual` are supported. Declared scopes feed install review,
preflight, and QA.

### `transform`

Supported transform kinds:

| Kind | Main settings |
| --- | --- |
| `group-by-age` | `source`, `timestampField`, `groups: [{ name, inactiveDaysAtLeast }]` |
| `filter-by-age` | `source`, `timestampField`, `inactiveDaysAtLeast` |
| `count-by-field` | `source`, `field`, optional `buckets` |
| `group-by-field` | `source`, `field`, optional `missing` bucket |
| `sort-by` | `source`, `field`, optional `direction` (`asc` or `desc`), optional `take` |
| `correlate-stale-devices` | `intuneSource`, `entraSource`, `staleDays`, `strategy` (`both`, `intune-only`, or `entra-only`), optional `excludePersonalDevices` |

Field paths can use dot notation, such as `status.errorCode`.

### `llm`

```yaml
- id: explain
  format: llm
  label: Explain the finding
  settings:
    system: Be concise and factual. Use only the supplied figures.
    prompt: |-
      Total failures: {{ load_failures.output | size }}.
      Top errors: {{ by_error.output }}.
      Write the main finding and next action.
    temperature: 0.2
    maxTokens: 400
```

Every agent must declare at least one `format: llm` step. The QA gate walks
inside `map.settings.do[]`, so nested LLM steps count. For read agents,
`definition.result.summary` should reference the LLM output, usually
`{{ explain.output.text }}`.

Optional `inputs` exists in the SDK type, but current manifests normally use
the prompt template to reference prior step outputs directly.

### `map`

`map` uses `settings.source`, `settings.as`, `settings.do`, and optional
`settings.limit`. The current item is available as `{{ <as>.field }}` inside
the sub-pipeline. The map output is an array of the final sub-step outputs.
Inner steps can reference both the current item and outer-pipeline outputs.

### `write`

A write step renders a `WritePlan`. The app pauses the run at
`awaiting-confirmation` and the admin must type the rendered phrase before any
action is applied.

```yaml
- id: plan_offboarding
  format: write
  label: Build offboarding plan
  settings:
    kind: retire-managed-device
    source: "{{ select_offboarding_candidates.output }}"
    confirmationPhrase: "OFFBOARD {{ actions | size }} DEVICES"
    summary: "{{ explain_plan.output.text }}"
    scopes: [DeviceManagementManagedDevices.PrivilegedOperations.All]
    actionTemplate:
      label: "Offboard {{ item.deviceName }}"
      severity: destructive
      metadata:
        deviceId: "{{ item.id }}"
```

Supported action kinds:

| Kind | Notes |
| --- | --- |
| `retire-managed-device` | Legacy helper for `POST /deviceManagement/managedDevices/{id}/retire`. Requires `metadata.deviceId`. |
| `graph-write` | Generic `POST`, `PATCH`, `PUT`, or `DELETE` Graph request. Put the concrete request under `actionTemplate.request`. |

If a write agent produces zero actions, the run completes as a no-op result.
Typed confirmation is still required for every non-empty write plan. There is
no "trust this agent" or skip-confirmation path.

### `connector`

Connector steps invoke egress capabilities declared in
`descriptor.connectors`. A requirement declares `id`, `minVersion`,
`required`, and `capabilities: [{ id, version }]`. The step then sets
`settings.connector`, `settings.capability`, optional `settings.version`, and
templated `settings.args`. Optional connectors can use
`when: ctx.connectors.<id>.available`.

Connector capability kind controls confirmation. `read` capabilities run
inline. `notify`, `mutating`, and `destructive` capabilities go through the
connector confirmation wrapper.

## Templating

Templates use a small Liquid-style subset:

```text
{{ step_id.output }}
{{ step_id.output | size }}
{{ value | default("fallback") }}
```

Supported filters are `size`, `total`, `length`, `sample(n)`, `default(...)`,
`join(...)`, `upper`, `lower`, and `type`. When a string is only one template
expression, the raw value is preserved. This lets
`source: "{{ load_devices.output }}"` remain an array.

The template context includes `settings.<id>`, prior step outputs as
`<step_id>.output`, `item`/`items`/`index` during write action rendering, and
the variable named by `map.settings.as` during map iterations.

## Settings And Triggers

Settings are shown at install/configuration time and merged into
`settings.<id>` at run time. Supported setting types are `string`, `integer`,
and `boolean`.

Triggers use `kind: manual` or `kind: scheduled` with `intervalSeconds`.
Schedules are user-owned after install. The manifest declares eligibility; the
desktop stores the actual enabled schedule locally.

## Local QA

Run the same gate maintainers run:

```bash
eval $(scripts/setup-qa.sh)
npm run qa
```

The QA package validates:

- `manifest.yaml` against `schemas/agent-template.schema.json`.
- Every declared Graph scope against the local Microsoft Graph index.
- Every declared Graph operation path and selected field.
- Scope coverage for each declared operation.
- Fixture shape where the QA package has a local fixture.
- The `uses-llm` rule, including LLM steps nested in `map`.
- README presence, registry index coverage, content-safety checks, and obvious secret-like values.

## Submission Flow

The in-app Build your own Agent flow can export a bundle with:

```text
manifest.yaml
README.md
metadata.json
```

The Share with community flow creates or updates a public `[New Agent]` GitHub
issue through the OpenAdminOS web API. The desktop app does not receive or store
GitHub tokens. The submission package is reviewed before it becomes part of
Agent Hub.

Submissions must not include tenant data, prompts, run results, provider
settings, access tokens, secrets, or local app state. Secret-like values block
submission. High-risk Graph scopes, destructive writes, and external connector
egress are flagged for maintainer review.

For a manual PR, add the agent directory, run QA, and include a short README
that states what the agent reads, what it writes if anything, how it uses the
LLM, required Graph scopes, settings, and any connector egress.
