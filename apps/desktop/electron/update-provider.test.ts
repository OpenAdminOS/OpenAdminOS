import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "electron-updater/out/providerFactory.js";
import { compareVersions, RELEASE_FEED, ReleaseProvider } from "./update-provider.js";

const REPO = "/OpenAdminOS/OpenAdminOS/releases";

/** A GitHub releases Atom feed, newest first, as github.com serves it. */
function atom(tags: string[]): string {
  const entries = tags
    .map(
      (tag) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <updated>2026-10-23T14:15:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com${REPO}/tag/${tag}"/>
    <title>${tag}</title>
    <content type="html">Notes for ${tag}</content>
  </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
${entries}
</feed>`;
}

function channelFile(version: string): string {
  return `version: ${version}
files:
  - url: OpenAdminOS-${version}-mac-arm64.zip
    sha512: abc
    size: 1
path: OpenAdminOS-${version}-mac-arm64.zip
sha512: abc
releaseDate: '2026-10-23T14:15:00.000Z'
`;
}

interface Feed {
  /** Tags in the Atom feed, newest first. */
  tags: string[];
  /** The tag GitHub marks as the latest release. */
  latest: string;
  /** Requests that fail as if offline. */
  offline?: RegExp;
}

/** Runs the real electron-updater GitHub provider against an in-memory github.com. */
function provider(
  feed: Feed,
  channel: "nightly" | "latest",
  platform: NodeJS.Platform = "darwin",
) {
  const requested: string[] = [];
  const executor = {
    request: async (options: { path?: string }) => {
      const path = options.path ?? "";
      requested.push(path);
      if (feed.offline?.test(path)) throw new Error(`offline: ${path}`);
      if (path === `${REPO}.atom`) return atom(feed.tags);
      if (path === `${REPO}/latest`) return JSON.stringify({ tag_name: feed.latest });
      const file = path.match(/\/download\/v?([^/]+)\/(latest|nightly)(-mac)?\.yml$/);
      if (file) return channelFile(file[1]!);
      throw new Error(`unexpected request: ${path}`);
    },
  };
  const updater = { channel, allowPrerelease: channel === "nightly", fullChangelog: false };
  const client = createClient(
    { ...RELEASE_FEED, provider: "custom", updateProvider: ReleaseProvider },
    updater as never,
    { executor, platform, isUseMultipleRangeRequest: true } as never,
  );
  return { client: client as ReleaseProvider, requested };
}

describe("release version order", () => {
  it("orders releases, nightlies and the stable release a nightly previews", () => {
    assert.ok(compareVersions("0.7.1", "0.7.0") > 0);
    assert.ok(compareVersions("0.7.1", "0.7.1-nightly.20261023141500") > 0);
    assert.ok(compareVersions("0.7.2-nightly.20261101090000", "0.7.1") > 0);
    assert.ok(compareVersions("0.7.1-nightly.20261023141500", "0.7.1-nightly.20261023091500") > 0);
    assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
    assert.equal(compareVersions("v0.7.1", "0.7.1"), 0);
  });
});

describe("release provider", () => {
  it("is built by electron-updater's custom provider wiring", () => {
    const { client } = provider({ tags: [], latest: "v0.7.0" }, "nightly");
    assert.ok(client instanceof ReleaseProvider);
  });

  it("follows nightly prereleases and skips the docs-index releases in the same feed", async () => {
    const { client, requested } = provider(
      {
        tags: ["docs-index-2026-10-20", "v0.7.1-nightly.20261023141500", "v0.7.0", "docs-index"],
        latest: "v0.7.0",
      },
      "nightly",
    );
    const latest = await client.getLatestVersion();
    assert.equal(latest.version, "0.7.1-nightly.20261023141500");
    assert.equal(latest.tag, "v0.7.1-nightly.20261023141500");
    assert.ok(requested.includes(`${REPO}/download/v0.7.1-nightly.20261023141500/nightly-mac.yml`));
    assert.ok(!requested.some((path) => path.includes("docs-index")));
  });

  it("reads nightly.yml on Windows", async () => {
    const { client, requested } = provider(
      { tags: ["v0.7.1-nightly.20261023141500", "v0.7.0"], latest: "v0.7.0" },
      "nightly",
      "win32",
    );
    assert.equal((await client.getLatestVersion()).version, "0.7.1-nightly.20261023141500");
    assert.ok(requested.includes(`${REPO}/download/v0.7.1-nightly.20261023141500/nightly.yml`));
  });

  it("offers a stable release newer than the newest nightly on the nightly channel", async () => {
    const { client } = provider(
      {
        tags: ["v0.7.1", "docs-index-2026-10-20", "v0.7.1-nightly.20261023141500", "v0.7.0"],
        latest: "v0.7.1",
      },
      "nightly",
    );
    const latest = await client.getLatestVersion();
    assert.equal(latest.version, "0.7.1");
    assert.equal(latest.tag, "v0.7.1");
  });

  it("keeps the nightly when it previews a newer version than the stable release", async () => {
    const { client } = provider(
      { tags: ["v0.7.2-nightly.20261101090000", "v0.7.1"], latest: "v0.7.1" },
      "nightly",
    );
    assert.equal((await client.getLatestVersion()).version, "0.7.2-nightly.20261101090000");
  });

  it("falls back to whichever feed answered", async () => {
    // The stable feed is unreachable.
    const stableDown = provider(
      { tags: ["v0.7.1-nightly.20261023141500", "v0.7.0"], latest: "v0.7.0", offline: /\/latest$/ },
      "nightly",
    );
    assert.equal((await stableDown.client.getLatestVersion()).version, "0.7.1-nightly.20261023141500");

    // No nightly among the recent releases, only stable and docs-index releases.
    const noNightly = provider(
      { tags: ["docs-index-2026-10-20", "v0.7.0", "docs-index"], latest: "v0.7.0" },
      "nightly",
    );
    assert.equal((await noNightly.client.getLatestVersion()).version, "0.7.0");

    const offline = provider(
      { tags: ["v0.7.1-nightly.20261023141500"], latest: "v0.7.0", offline: /./ },
      "nightly",
    );
    await assert.rejects(offline.client.getLatestVersion(), /offline/);
  });

  it("only asks the stable feed on the stable channel and ignores docs-index releases", async () => {
    const { client, requested } = provider(
      {
        tags: ["docs-index-2026-10-20", "v0.7.1-nightly.20261023141500", "v0.7.0", "docs-index"],
        latest: "v0.7.0",
      },
      "latest",
    );
    const latest = await client.getLatestVersion();
    assert.equal(latest.version, "0.7.0");
    assert.ok(requested.includes(`${REPO}/download/v0.7.0/latest-mac.yml`));
    assert.ok(!requested.some((path) => path.includes("nightly")));
  });

  it("sends the updater's request headers to both feeds", async () => {
    const { client } = provider(
      { tags: ["v0.7.1-nightly.20261023141500", "v0.7.0"], latest: "v0.7.0" },
      "nightly",
    );
    client.setRequestHeaders({ "x-user-staging-id": "id" });
    const stable = (client as unknown as { stable: { requestHeaders: unknown } }).stable;
    assert.deepEqual(stable.requestHeaders, { "x-user-staging-id": "id" });
  });
});
