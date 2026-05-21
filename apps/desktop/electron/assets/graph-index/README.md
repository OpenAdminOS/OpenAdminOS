# Microsoft Graph endpoint catalogue

These JSON files are the local catalogue of Microsoft Graph endpoints used
by OpenAdminOS for three purposes:

1. Injecting candidate endpoints into the LLM drafting prompt so the model
   targets real paths instead of hallucinating.
2. Validating manifest graph steps at install time (path exists, declared
   scopes intersect the endpoint's required scopes).
3. Disclosing required permissions in the Manifest Preview UI.

## Files

- `graph-api-index.json` — full path/method catalogue (~28k entries).
  Source of truth for "is this a real Graph endpoint."
- `api-docs-index.json` — curated subset (~6.4k entries) with per-endpoint
  permission scopes (delegated + application), supported `$` query
  parameters, and required headers.

Both files cover the Graph **beta** surface. OpenAdminOS calls
`https://graph.microsoft.com/v1.0` by default; manifests can opt into
`beta` per step (future work). Endpoints listed only in beta will 404
against v1.0 at runtime — that surfaces as a normal Graph error.

## Provenance

Vendored from <https://github.com/merill/msgraph>, MIT-licensed, on
`main` at the date in each file's `generated` field. To refresh:

```sh
curl -sL -o apps/desktop/electron/assets/graph-index/graph-api-index.json \
  https://raw.githubusercontent.com/merill/msgraph/main/skills/msgraph/references/graph-api-index.json
curl -sL -o apps/desktop/electron/assets/graph-index/api-docs-index.json \
  https://raw.githubusercontent.com/merill/msgraph/main/skills/msgraph/references/api-docs-index.json
```

No transformation — files are shipped as-is. The loader
(`apps/desktop/electron/graph-catalog.ts`) builds in-memory lookup
structures on first use.
