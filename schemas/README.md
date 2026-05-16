# JSON Schema for Agent Templates

`agent-template.schema.json` is the canonical shape for any
`agents/<slug>/manifest.yaml` file. It mirrors the TypeScript types in
`@openagents/agent-sdk` and is what the QA harness validates against.

## Why this file exists

- **Editor autocomplete and inline validation.** With the YAML
  Language Server extension installed in VSCode (or its equivalent in
  other editors), every key in `manifest.yaml` is autocompleted and
  every wrong value is underlined as you type. No mental round trip
  through the runtime to learn the manifest shape.
- **Offline structural validation.** `npm run qa` validates each
  `manifest.yaml` against this schema. The check runs in CI, so a
  malformed manifest cannot land on `main`.
- **Single source of truth.** When the TS types change, this file
  changes alongside them. Reviewers can audit the YAML contract in
  one place instead of reading the parser.

## Picking up the schema in your editor

Each shipped manifest references the schema at the top via the
YAML Language Server directive:

```yaml
# yaml-language-server: $schema=../../schemas/agent-template.schema.json
```

Most YAML extensions read this directive automatically. New manifests
should keep this line as the first comment in the file.

## When the schema needs to change

If you extend the agent template DSL — new step format, new
transform kind, new action handler, new setting type — update this
schema in the same commit. The `qa` step rejects every manifest that
falls outside it, including the showcase agents in `agents/`.

## What this schema is NOT

This is structural validation only. It does not catch:

- Liquid templating expressions that reference undefined pipeline
  outputs (the interpreter throws at run time).
- Graph endpoints or scopes that don't exist (the `qa-graph` checks
  in the same harness catch those against the local msgraph index).
- Action-kind metadata mismatches (e.g. a `retire-managed-device`
  action whose template doesn't render `deviceId` — caught by the
  runtime when the action handler runs).
