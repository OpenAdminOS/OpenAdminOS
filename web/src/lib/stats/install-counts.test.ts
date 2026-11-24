import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { POST as submitAgent } from "../../app/api/agent-submissions/route";
import { GET as flush } from "../../app/api/flush/route";
import { GET as health } from "../../app/api/health/route";
import { POST as install } from "../../app/api/install/route";
import { POST as support } from "../../app/api/support-issues/route";
import type { InstallSnapshot } from "./store";

const slug = "sample-agent";
const statsPath = "/repos/example/project/contents/stats/agents.json";
const ip = "192.0.2.1";
const secret = "fake-supabase-key";
const day = "2027-01-03";

function cronRequest() {
  return new Request("https://example.test/api/flush", { headers: { authorization: "Bearer cron-test" } });
}

function installRequest(body: string) {
  return new Request("https://example.test/api/install", {
    method: "POST", headers: { "x-real-ip": ip }, body,
  });
}

test("all stats routes return 503 for missing storage variables or a malformed Supabase URL", async (t) => {
  for (const name of ["CRON_SECRET", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
    const before = process.env[name];
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
  process.env.CRON_SECRET = "cron-test";
  t.mock.method(globalThis, "fetch", () => assert.fail("Unconfigured routes must not fetch"));
  const log = t.mock.method(console, "error", () => {});
  for (const [url, key] of [[undefined, secret], ["https://db.example", undefined], ["malformed-private-url", secret]]) {
    if (url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = key;

    assert.equal((await flush(new Request("https://example.test/api/flush"))).status, 401);
    for (const response of await Promise.all([
      install(installRequest("{")), submitAgent(installRequest("{")),
      support(installRequest("{")), flush(cronRequest()), health(),
    ])) {
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        ok: false, error: "Stats storage is not configured in this environment.",
      });
    }
  }
  assert.equal(log.mock.callCount(), 1);
  const logged = JSON.stringify(log.mock.calls[0]?.arguments);
  assert.doesNotMatch(logged, /malformed-private-url|fake-supabase-key/);
});

test("install and flush preserve aggregate counts over failures and retries", async (t) => {
  const settings = {
    CRON_SECRET: "cron-test",
    SUPABASE_URL: "https://db.example",
    SUPABASE_SECRET_KEY: secret,
    STATS_IP_HASH_SECRET: "",
    OPENADMINOS_GITHUB_TOKEN: "github-test",
    OPENADMINOS_GITHUB_OWNER: "example",
    OPENADMINOS_GITHUB_REPO: "project",
  };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  t.mock.timers.enable({ apis: ["Date"], now: new Date(`${day}T00:00:00Z`) });

  const newDailyCounts = { installs: 0, flushed: 0 };
  let priorDaysInWindow = 3;
  let rateAllowed = true;
  let failCommit = true;
  let failMark = true;
  const commits = [{ sha: "commit-0", commit: { message: "stats: +1 install" } }];
  let githubFile = {
    updatedAt: "2027-01-02T00:00:00Z",
    agents: { [slug]: { installs: 10, installs7d: 9, comments: 2 } },
  };
  const events: string[] = [];

  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (input: string | URL, options?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === "https://db.example") {
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("content-profile"), "openadminos");
      assert.equal(headers.get("apikey"), secret);
      const rpc = url.pathname.split("/").at(-1);
      const body = JSON.parse(String(options?.body));
      switch (rpc) {
        case "health": return Response.json(true);
        case "rate_limit_hit": {
          const hashKey = createHmac("sha256", secret).update("openadminos:stats:ip-hash:v1").digest();
          assert.deepEqual(body, {
            p_scope: "install",
            p_key_hash: createHmac("sha256", hashKey).update(`install\n${ip}`).digest("hex"),
            p_window_seconds: 60,
            p_max: 30,
          });
          return Response.json(rateAllowed);
        }
        case "record_install":
          assert.deepEqual(body, { p_slug: slug, p_day: day });
          newDailyCounts.installs++;
          return Response.json(null);
        case "pending_install_snapshot": {
          const delta = newDailyCounts.installs - newDailyCounts.flushed;
          return Response.json(delta > 0 ? [{ slug, delta, days: { [day]: newDailyCounts.installs } }] : []);
        }
        case "installs_7d":
          return Response.json([{ slug, installs: priorDaysInWindow + newDailyCounts.installs }]);
        case "mark_installs_flushed": {
          events.push("mark");
          const [snapshot] = body.p_snapshot as InstallSnapshot[];
          assert.equal(snapshot?.slug, slug);
          if (failMark) return Response.json({ code: "42501", message: "test mark failure" }, { status: 400 });
          newDailyCounts.flushed = Math.max(newDailyCounts.flushed, snapshot?.days[day] ?? 0);
          return Response.json(null);
        }
        case "purge_expired":
          events.push("purge");
          return Response.json(null);
        default: assert.fail(`Unexpected RPC: ${rpc}`);
      }
    }

    assert.equal(url.origin, "https://api.github.com");
    switch (decodeURIComponent(url.pathname)) {
      case "/repos/example/project/contents/agents":
        assert.deepEqual((options as RequestInit & { next: unknown }).next, { revalidate: 3600 });
        return Response.json([{ name: slug, type: "dir" }]);
      case "/repos/example/project/commits":
        assert.equal(url.searchParams.get("path"), "stats/agents.json");
        assert.equal(url.searchParams.get("per_page"), "100");
        return Response.json(commits);
      case statsPath: {
        const latest = commits[0]!;
        if (options?.method === "PUT") {
          events.push("commit");
          if (failCommit) return Response.json({ message: "test conflict" }, { status: 409 });
          const { content, sha, message } = JSON.parse(String(options.body));
          assert.equal(sha, `blob-${latest.sha}`);
          githubFile = JSON.parse(Buffer.from(content, "base64").toString("utf8"));
          commits.unshift({ sha: `commit-${commits.length}`, commit: { message } });
          return Response.json({});
        }
        assert.equal(url.searchParams.get("ref"), latest.sha);
        return Response.json({
          type: "file",
          sha: `blob-${latest.sha}`,
          content: Buffer.from(JSON.stringify(githubFile)).toString("base64"),
        });
      }
      default: assert.fail(`Unexpected GitHub path: ${url.pathname}`);
    }
  });

  assert.deepEqual(await (await health()).json(), { ok: true });
  const payload = { slug, version: "0.8.0", platform: "linux" };
  const send = (body: unknown) => install(installRequest(JSON.stringify(body)));
  for (const body of [payload, ...["legacy-id", 42, false, null, [], {}].map((installId) => ({ ...payload, installId }))]) {
    const response = await send(body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { counted: true });
  }
  assert.equal((await install(installRequest("{"))).status, 400);
  for (const invalid of [[], { ...payload, slug: "INVALID" }, { ...payload, version: "invalid" }, { ...payload, platform: "invalid" }]) {
    assert.equal((await send(invalid)).status, 400);
  }
  assert.equal((await send({ ...payload, slug: "unknown-agent" })).status, 404);
  rateAllowed = false;
  const limited = await send(payload);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(newDailyCounts.installs, 7);

  assert.equal((await flush(cronRequest())).status, 500);
  assert.deepEqual(events.splice(0), ["commit"]);
  assert.equal(newDailyCounts.flushed, 0);

  failCommit = false;
  assert.equal((await flush(cronRequest())).status, 503);
  assert.deepEqual(events.splice(0), ["commit", "mark"]);
  assert.deepEqual(githubFile.agents[slug], { installs: 17, installs7d: 10, comments: 2 });
  assert.equal(newDailyCounts.flushed, 0);

  // A legacy flush can publish counts on top of the unacknowledged receipt.
  commits.unshift({ sha: "legacy-install", commit: { message: "stats: +1 install\n\n  sample-agent: +1" } });
  githubFile.agents[slug]!.installs++;
  rateAllowed = true;
  assert.equal((await send(payload)).status, 200);
  failMark = false;
  assert.equal((await flush(cronRequest())).status, 200);
  assert.deepEqual(events.splice(0), ["mark", "commit", "mark", "purge"]);
  assert.deepEqual(githubFile.agents[slug], { installs: 19, installs7d: 11, comments: 2 });
  assert.equal(newDailyCounts.flushed, 8);

  priorDaysInWindow = 0;
  assert.equal((await flush(cronRequest())).status, 200);
  assert.deepEqual(events.splice(0), ["mark", "commit", "purge"]);
  assert.deepEqual(githubFile.agents[slug], { installs: 19, installs7d: 8, comments: 2 });

  assert.equal((await (await flush(cronRequest())).json()).flushed, false);
  assert.deepEqual(events, ["mark", "purge"]);
});
