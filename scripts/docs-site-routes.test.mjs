import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildDocsSite, parseSummary, slugify } from "./docs-site-routes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const summary = readFileSync(
  join(here, "..", "docs", "gitbook", "SUMMARY.md"),
  "utf8",
);
const site = buildDocsSite(parseSummary(summary));

function routeFor(source) {
  return site.pages.find((page) => page.source === source)?.route;
}

function redirectFor(path) {
  return site.redirects.find((redirect) => redirect.source === path)
    ?.destination;
}

test("slugify matches GitBook group slugs", () => {
  assert.equal(slugify("Trust model"), "trust-model");
  assert.equal(slugify("Trust Model"), "trust-model");
  assert.equal(slugify("LLM provider matrix"), "llm-provider-matrix");
});

test("pages keep their published GitBook URLs", () => {
  assert.equal(routeFor("README.md"), "");
  assert.equal(
    routeFor("getting-started/installation.md"),
    "basics/installation",
  );
  assert.equal(routeFor("trust/local-first.md"), "trust-model/local-first");
  assert.equal(routeFor("connectors/README.md"), "connectors/connectors");
  assert.equal(routeFor("agents/README.md"), "agents/agents");
  assert.equal(routeFor("generated/agent-catalog.md"), "agents/agent-catalog");
  assert.equal(
    routeFor("generated/agents/offboarding-agent.md"),
    "agents/offboarding-agent",
  );
  assert.equal(
    routeFor("generated/reference/llm-provider-matrix.md"),
    "developers/llm-provider-matrix",
  );
});

test("old file-path and folder URLs redirect to the published URL", () => {
  assert.equal(
    redirectFor("getting-started/installation"),
    "basics/installation",
  );
  assert.equal(redirectFor("connectors"), "connectors/connectors");
  assert.equal(redirectFor("agents"), "agents/agents");
  assert.equal(redirectFor("basics"), "");
  assert.equal(redirectFor("basics/readme"), "");
  assert.equal(redirectFor("trust-model"), "trust-model/local-first");
  assert.equal(redirectFor("trust/local-first"), "trust-model/local-first");
  assert.equal(redirectFor("generated/agent-catalog"), "agents/agent-catalog");
  assert.equal(
    redirectFor("generated/reference/graph-scope-matrix"),
    "agents/graph-scope-matrix",
  );
  assert.equal(
    redirectFor("generated/agents/offboarding-agent"),
    "agents/offboarding-agent",
  );
  assert.equal(redirectFor("developers"), "developers/architecture");
  assert.equal(redirectFor("features"), "features/intune-chat");
  assert.equal(redirectFor("getting-started"), "basics/installation");
});

test("redirects never shadow a page", () => {
  const routes = new Set(site.pages.map((page) => page.route));
  for (const redirect of site.redirects) {
    assert.ok(
      !routes.has(redirect.source),
      `redirect shadows /${redirect.source}`,
    );
    assert.ok(
      routes.has(redirect.destination),
      `redirect to missing /${redirect.destination}`,
    );
  }
});

test("nested SUMMARY entries nest their URLs", () => {
  const nested = buildDocsSite(
    parseSummary(
      "## Guides\n\n- [Start](start.md)\n- [Setup](guides/setup.md)\n  - [Proxy](guides/proxy.md)\n",
    ),
  );
  assert.equal(
    nested.sections[0].pages[1].children[0].route,
    "guides/setup/proxy",
  );
});
