import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load as parseYaml } from "js-yaml";

// Guarantees the trust story relies on:
//   1. read-mode agents perform no writes (no non-GET graph calls,
//      no `format: write` skills).
//   2. write-mode agents always pause for typed confirmation — every
//      `format: write` skill must declare a `confirmationPhrase`.
//   3. every agent declares at least one Graph scope (no silent /.default
//      escalation paths sneaking into the registry).

interface ParsedSkill {
  format?: string;
  settings?: {
    method?: string;
    scopes?: unknown;
    confirmationPhrase?: unknown;
    kind?: unknown;
  };
}

interface ParsedManifest {
  descriptor?: { id?: string; mode?: string };
  skills?: ParsedSkill[];
}

/**
 * Flatten a manifest's skill tree, descending into `map.settings.do[]`
 * so every trust-story assertion below covers nested graph and write
 * steps as well as the top-level pipeline.
 */
function flattenSkills(skills: ParsedSkill[] | undefined): ParsedSkill[] {
  if (!Array.isArray(skills)) return [];
  const out: ParsedSkill[] = [];
  const walk = (list: ParsedSkill[]): void => {
    for (const s of list) {
      out.push(s);
      const inner = (s.settings as { do?: unknown } | undefined)?.do;
      if (s.format === "map" && Array.isArray(inner)) {
        walk(inner as ParsedSkill[]);
      }
    }
  };
  walk(skills);
  return out;
}

interface LoadedManifest {
  slug: string;
  path: string;
  raw: ParsedManifest;
}

const VALID_GRAPH_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

function repoRoot(): string {
  let current = resolve(dirname(fileURLToPath(import.meta.url)));
  while (true) {
    if (
      existsDir(join(current, "agents")) &&
      existsDir(join(current, "schemas"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Unable to locate repo root from manifest test.");
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function loadAll(): LoadedManifest[] {
  const agentsDir = join(repoRoot(), "agents");
  const out: LoadedManifest[] = [];
  for (const entry of readdirSync(agentsDir)) {
    const dir = join(agentsDir, entry);
    const manifestPath = join(dir, "manifest.yaml");
    try {
      if (!statSync(manifestPath).isFile()) continue;
    } catch {
      continue;
    }
    const raw = parseYaml(readFileSync(manifestPath, "utf8")) as ParsedManifest;
    out.push({ slug: entry, path: manifestPath, raw });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

const manifests = loadAll();

describe("agent manifests", () => {
  it("there is at least one manifest to test", () => {
    assert.ok(manifests.length > 0, "no agent manifests found under agents/");
  });

  for (const m of manifests) {
    describe(m.slug, () => {
      // Walk into map.settings.do[] so nested graph/write/llm steps
      // can't bypass the trust-story assertions below.
      const skills = flattenSkills(m.raw.skills);
      const mode = m.raw.descriptor?.mode === "write" ? "write" : "read";

      it("declares at least one Graph scope across its skills", () => {
        const scopes = new Set<string>();
        for (const s of skills) {
          const raw = s.settings?.scopes;
          if (Array.isArray(raw)) {
            for (const scope of raw) {
              if (typeof scope === "string" && scope.length > 0) scopes.add(scope);
            }
          }
        }
        assert.ok(scopes.size > 0, `${m.slug} declares no Graph scopes`);
      });

      it("every graph skill uses a valid HTTP method", () => {
        for (const s of skills) {
          if (s.format !== "graph") continue;
          const method = s.settings?.method;
          assert.ok(
            typeof method === "string" && VALID_GRAPH_METHODS.has(method),
            `${m.slug} has a graph skill with invalid method ${JSON.stringify(method)}`,
          );
        }
      });

      if (mode === "read") {
        it("performs no non-GET graph calls (read-mode honesty)", () => {
          for (const s of skills) {
            if (s.format !== "graph") continue;
            const method = s.settings?.method;
            assert.equal(
              method,
              "GET",
              `${m.slug} is declared read but issues ${method} — declare it as write or remove the call`,
            );
          }
        });

        it("has no `format: write` skills", () => {
          const writeSkills = skills.filter((s) => s.format === "write");
          assert.equal(
            writeSkills.length,
            0,
            `${m.slug} is declared read but has ${writeSkills.length} write skill(s)`,
          );
        });
      } else {
        it("has at least one `format: write` skill (otherwise it should be read)", () => {
          const writeSkills = skills.filter((s) => s.format === "write");
          assert.ok(
            writeSkills.length > 0,
            `${m.slug} is declared write but has no write skill`,
          );
        });

        it("every write skill declares a non-empty confirmationPhrase", () => {
          for (const s of skills) {
            if (s.format !== "write") continue;
            const phrase = s.settings?.confirmationPhrase;
            assert.ok(
              typeof phrase === "string" && phrase.trim().length > 0,
              `${m.slug} has a write skill without confirmationPhrase — violates the human-in-the-loop guarantee`,
            );
          }
        });
      }
    });
  }
});
