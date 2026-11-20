import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { describe, it } from "node:test";

import { allowLiveMcpOrigin } from "../../../../tests/provider-test-guard.mjs";
import { mcpCatalogEntry, mcpHost } from "./catalog.js";
import { McpHost } from "./host.js";

/**
 * Live probe of the second-wave servers: handshake, tools/list and the
 * allowlist check against the real endpoints. Set OPENADMINOS_LIVE_MCP=1
 * to opt in locally. CI and offline runs skip the probe.
 */
const SERVER_IDS = ["release-communications", "windowsforum", "endoflife-ai"] as const;

async function resolves(host: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(host).then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const skipReason = process.env.CI
  ? "live probe skipped in CI"
  : process.env.OPENADMINOS_SKIP_LIVE
    ? "live probe skipped by OPENADMINOS_SKIP_LIVE"
    : process.env.OPENADMINOS_LIVE_MCP !== "1"
      ? "set OPENADMINOS_LIVE_MCP=1 to opt in to live MCP probes"
      : (await Promise.all(SERVER_IDS.map((id) => resolves(mcpHost(mcpCatalogEntry(id)!.url))))).every(Boolean)
        ? undefined
        : "live probe skipped: offline";

describe("Second-wave MCP servers, live", { skip: skipReason ?? false }, () => {
  for (const id of SERVER_IDS) {
    it(`${id} answers the handshake and lists every allowlisted tool`, async () => {
      const entry = mcpCatalogEntry(id)!;
      allowLiveMcpOrigin(entry.url);
      const host = new McpHost({ clientVersion: "live-probe", connectTimeoutMs: 20_000 });
      try {
        const connected = await host.connect(entry);
        assert.deepEqual(connected.missingTools, [], `${entry.name} no longer lists ${connected.missingTools.join(", ")}`);
        assert.deepEqual(connected.tools.map((tool) => tool.name).sort(), [...entry.tools!].sort());
        assert.ok(connected.tools.every((tool) => !tool.unavailable), `${entry.name} has a tool whose schema cannot be offered`);
      } finally {
        await host.closeAll();
      }
    });
  }
});
