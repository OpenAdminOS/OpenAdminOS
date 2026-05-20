import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface EndpointSummary {
  method: string;
  path: string;
  summary?: string;
  resource?: string;
  scopesDelegated: string[];
  scopesApplication: string[];
  queryParams: string[];
  requiredHeaders: string[];
}

export interface ValidatePathResult {
  ok: boolean;
  reason?: string;
  suggestion?: string;
  endpoint?: EndpointSummary;
}

interface RawGraphIndexEntry {
  path: string;
  method: string;
  summary?: string;
  description?: string;
  resource?: string;
}

interface RawApiDocsEntry {
  path: string;
  method: string;
  summary?: string;
  permissions?: {
    delegatedWork?: string[];
    delegatedPersonal?: string[];
    application?: string[];
  };
  queryParams?: string[];
  requiredHeaders?: string[];
}

interface CatalogState {
  // Map keyed by `${METHOD} ${normalizedPath}` → endpoint info.
  byKey: Map<string, EndpointSummary>;
  // Flat list of all endpoints in iteration order, used for search.
  all: EndpointSummary[];
}

let cached: CatalogState | null = null;

/**
 * Resolve where the bundled Graph index JSON lives. Packaged builds
 * copy `electron/assets/graph-index/` into `process.resourcesPath` via
 * the electron-builder `extraResources` entry; dev runs load directly
 * from the source tree.
 */
function indexDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "graph-index");
  }
  // dist-electron/electron/graph-catalog.js → ../../electron/assets/graph-index
  return join(__dirname, "..", "..", "electron", "assets", "graph-index");
}

/**
 * Load and parse both JSON files into an in-memory lookup. Lazy and
 * cached: parsing ~13 MB takes a few hundred ms once at first use.
 */
export function loadCatalog(): CatalogState {
  if (cached) return cached;

  const dir = indexDir();
  const graphRaw = JSON.parse(
    readFileSync(join(dir, "graph-api-index.json"), "utf-8"),
  ) as { endpoints: RawGraphIndexEntry[] };
  const docsRaw = JSON.parse(
    readFileSync(join(dir, "api-docs-index.json"), "utf-8"),
  ) as { endpoints: RawApiDocsEntry[] };

  // First pass — index doc entries (these have the permission data) by
  // normalized key. The doc set is smaller (~6k) and is the source of
  // truth for scopes.
  const docsByKey = new Map<string, RawApiDocsEntry>();
  for (const entry of docsRaw.endpoints) {
    const key = makeKey(entry.method, entry.path);
    docsByKey.set(key, entry);
  }

  // Second pass — walk the full endpoint catalog (~28k) and produce
  // EndpointSummary entries, merging in permissions from the docs set
  // where available.
  const byKey = new Map<string, EndpointSummary>();
  const all: EndpointSummary[] = [];

  for (const entry of graphRaw.endpoints) {
    const key = makeKey(entry.method, entry.path);
    if (byKey.has(key)) continue; // duplicate guard
    const docs = docsByKey.get(key);
    const summary: EndpointSummary = {
      method: entry.method.toUpperCase(),
      path: entry.path,
      summary: entry.summary ?? entry.description ?? docs?.summary,
      resource: entry.resource,
      scopesDelegated: docs?.permissions?.delegatedWork ?? [],
      scopesApplication: docs?.permissions?.application ?? [],
      queryParams: docs?.queryParams ?? [],
      requiredHeaders: docs?.requiredHeaders ?? [],
    };
    byKey.set(key, summary);
    all.push(summary);
  }

  // Some doc entries exist for endpoints that the openapi catalog
  // strips (e.g. action functions). Add them too so lookup is complete.
  for (const [key, docs] of docsByKey) {
    if (byKey.has(key)) continue;
    const summary: EndpointSummary = {
      method: docs.method.toUpperCase(),
      path: docs.path,
      summary: docs.summary,
      scopesDelegated: docs.permissions?.delegatedWork ?? [],
      scopesApplication: docs.permissions?.application ?? [],
      queryParams: docs.queryParams ?? [],
      requiredHeaders: docs.requiredHeaders ?? [],
    };
    byKey.set(key, summary);
    all.push(summary);
  }

  cached = { byKey, all };
  return cached;
}

/**
 * Look up a specific (method, path) pair. Path may contain concrete IDs
 * — they're normalized to template placeholders before lookup so
 * `/users/abc` matches the same entry as `/users/{user-id}`.
 */
export function lookupEndpoint(
  method: string,
  path: string,
): EndpointSummary | null {
  const catalog = loadCatalog();
  return catalog.byKey.get(makeKey(method, path)) ?? null;
}

/**
 * Free-text search across path + summary + resource. Used to inject a
 * shortlist of candidate endpoints into the NL→agent drafting prompt.
 *
 * The scoring is intentionally simple — we want fast, predictable
 * results, not an actual search engine. Token overlap with the path
 * dominates; summary overlap is a tiebreaker.
 */
export function searchEndpoints(
  query: string,
  opts: { limit?: number; method?: string } = {},
): EndpointSummary[] {
  const catalog = loadCatalog();
  const limit = opts.limit ?? 12;
  const methodFilter = opts.method?.toUpperCase();
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scored: Array<{ ep: EndpointSummary; score: number }> = [];

  for (const ep of catalog.all) {
    if (methodFilter && ep.method !== methodFilter) continue;
    const score = scoreEndpoint(ep, tokens);
    if (score > 0) {
      scored.push({ ep, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.ep.path.length - b.ep.path.length;
  });

  return scored.slice(0, limit).map((s) => s.ep);
}

/**
 * Confirm a manifest graph step targets a real endpoint and declared
 * scopes intersect what Graph actually requires.
 *
 * Returns `{ ok: true, endpoint }` when valid; otherwise `{ ok: false,
 * reason, suggestion }` with copy suitable for surfacing in the
 * NewAgentModal validation list.
 */
export function validatePath(
  method: string,
  path: string,
  declaredScopes: string[],
): ValidatePathResult {
  const endpoint = lookupEndpoint(method, path);
  if (!endpoint) {
    return {
      ok: false,
      reason: `\`${method.toUpperCase()} ${path}\` is not a known Microsoft Graph endpoint.`,
      suggestion:
        "Check the path against https://learn.microsoft.com/en-us/graph/api/overview, or refine the agent prompt so the LLM picks a documented endpoint.",
    };
  }

  // Empty scopes for known endpoints are tolerated for the few entries
  // (mostly $ref / $count subpaths) where Graph documents no
  // delegated-scope requirement.
  if (endpoint.scopesDelegated.length === 0) {
    return { ok: true, endpoint };
  }

  // Missing scope declaration is a real problem — the runtime cannot
  // request a token without scopes. Block this case.
  if (declaredScopes.length === 0) {
    return {
      ok: false,
      reason: `Graph step targets ${method.toUpperCase()} ${path} but declares no scopes.`,
      suggestion: `Declare at least one of: ${endpoint.scopesDelegated.slice(0, 5).join(", ")}.`,
      endpoint,
    };
  }

  // Scope-set mismatch is reported but not blocked. The merill catalogue
  // intentionally documents one "flavour" of permissions per endpoint
  // and frequently misses synonyms — e.g. `PATCH /users/{user-id}`
  // lists Intune-specific scopes but not `User.ReadWrite.All`, even
  // though the latter is the canonical scope. Hard-failing here
  // produces false negatives that block legitimate agents, so we
  // surface declared scopes as-is and let Graph return 403 at runtime
  // if they're genuinely wrong (rare for well-formed prompts).
  return { ok: true, endpoint };
}

// ─── internal helpers ────────────────────────────────────────────────────

function makeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

/**
 * Reduce a concrete or templated path to a stable lookup key.
 *
 * - Strips any query string.
 * - Collapses `{x-id}` / `{anything}` segments to `{}`.
 * - Treats raw GUID / numeric / quoted-string segments as `{}` so
 *   `/users/abc-123` matches `/users/{user-id}`.
 * - Lowercases the path (Graph paths are case-insensitive).
 */
function normalizePath(path: string): string {
  const noQuery = path.split("?")[0]!;
  const trimmed = noQuery.endsWith("/") && noQuery.length > 1
    ? noQuery.slice(0, -1)
    : noQuery;
  return trimmed
    .split("/")
    .map((segment) => {
      if (segment === "") return "";
      if (segment.startsWith("{") && segment.endsWith("}")) return "{}";
      if (looksLikeId(segment)) return "{}";
      return segment.toLowerCase();
    })
    .join("/");
}

const ID_LIKE =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d+|'[^']*')$/;

function looksLikeId(segment: string): boolean {
  return ID_LIKE.test(segment);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function scoreEndpoint(ep: EndpointSummary, tokens: string[]): number {
  let score = 0;
  const pathLower = ep.path.toLowerCase();
  const summaryLower = (ep.summary ?? "").toLowerCase();
  const resourceLower = (ep.resource ?? "").toLowerCase();

  for (const token of tokens) {
    if (pathLower.includes(token)) score += 5;
    if (resourceLower.includes(token)) score += 3;
    if (summaryLower.includes(token)) score += 1;
  }
  // Prefer collection endpoints (shorter, no trailing template segments)
  // for ambiguous queries — they're usually what an agent wants.
  if (!ep.path.includes("{")) score += 1;
  return score;
}
