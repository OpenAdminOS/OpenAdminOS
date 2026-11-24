import assert from "node:assert/strict";
import test from "node:test";

import { GET as flush } from "../../app/api/flush/route";
import { POST as install } from "../../app/api/install/route";

type Command = [string, ...unknown[]];

const slug = "sample-agent";
const statsPath = "/repos/example/project/contents/stats/agents.json";
const dailyKey = (day: string) => `oa:installs:day:${day}:${slug}`;
const pendingKey = `oa:pending:installs:${slug}`;

test("install and flush store only aggregate counts, including requests from legacy clients", async (t) => {
  const settings = {
    CRON_SECRET: "cron-test",
    UPSTASH_REDIS_REST_URL: "https://redis.example",
    UPSTASH_REDIS_REST_TOKEN: "redis-test",
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
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2027-01-03T00:00:00Z") });

  const transactions: Command[][] = [];
  const readKeys: string[][] = [];
  const rateCommands: Command[] = [];
  const counters = new Map<string, number>([[dailyKey("2026-12-28"), 3], [dailyKey("2026-12-27"), 5]]);
  let githubFile = { updatedAt: "2027-01-02T00:00:00Z", agents: { [slug]: { installs: 10, installs7d: 9 } } };
  let commits = 0;

  function run([name, ...args]: Command): unknown {
    const key = String(args[0]);
    switch (name.toLowerCase()) {
      case "get":
        assert.equal(key, "oa:slugs");
        return JSON.stringify({ slugs: [slug] });
      case "mget":
        readKeys.push(args.map(String));
        return args.map((arg) => counters.get(String(arg)) ?? null);
      case "incr":
        if (key.startsWith("oa:rate:install:")) rateCommands.push([name, ...args]);
        counters.set(key, (counters.get(key) ?? 0) + 1);
        return counters.get(key);
      case "expire":
        if (key.startsWith("oa:rate:install:")) rateCommands.push([name, ...args]);
        return 1;
      case "decrby":
        counters.set(key, (counters.get(key) ?? 0) - Number(args[1]));
        return counters.get(key);
      default:
        assert.fail(`Unexpected Redis command: ${name}`);
    }
  }

  t.mock.method(globalThis, "fetch", async (input: string | URL, options?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === "https://redis.example") {
      const body = JSON.parse(String(options?.body)) as Command | Command[];
      if (Array.isArray(body[0])) {
        const commands = body as Command[];
        if (url.pathname === "/multi-exec") transactions.push(commands);
        return Response.json(commands.map((command) => ({ result: run(command) })));
      }
      return Response.json({ result: run(body as Command) });
    }
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(decodeURIComponent(url.pathname), statsPath);
    if (options?.method === "PUT") {
      commits++;
      const { content } = JSON.parse(String(options.body)) as { content: string };
      githubFile = JSON.parse(Buffer.from(content, "base64").toString("utf8")) as typeof githubFile;
      return Response.json({});
    }
    return Response.json({ type: "file", sha: "sample-blob", content: Buffer.from(JSON.stringify(githubFile)).toString("base64") });
  });

  const payload = { slug, version: "0.8.0", platform: "linux" };
  const request = (body: string) => new Request("https://example.test/api/install", {
    method: "POST", headers: { "x-real-ip": "192.0.2.1" }, body,
  });
  const validBodies = [
    payload,
    ...["legacy-id", 42, false, null, ["legacy-id"], { ignored: "legacy-id" }].map((installId) => ({
      ...payload, installId,
    })),
  ];
  for (const body of validBodies) {
    const response = await install(request(JSON.stringify(body)));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { counted: true });
  }
  const increment = [
    ["incr", pendingKey],
    ["incr", dailyKey("2027-01-03")],
    ["expire", dailyKey("2027-01-03"), 8 * 24 * 60 * 60],
  ];
  assert.deepEqual(transactions, validBodies.map(() => increment));
  assert.equal(rateCommands.length, validBodies.length + 1);
  assert.deepEqual(rateCommands[1]?.slice(2), [60]);

  for (const [body, message] of [
    ["{", "Body must be valid JSON."],
    ["[]", "Body must be a JSON object."],
    [JSON.stringify({ ...payload, slug: "INVALID" }), "`slug` must be a kebab-case string (max 64 chars)."],
    [JSON.stringify({ ...payload, version: "invalid" }), "`version` must be a semver string (max 32 chars)."],
    [JSON.stringify({ ...payload, platform: "invalid" }), "`platform` must be 'darwin', 'win32', or 'linux'."],
  ] as const) {
    const invalid = await install(request(body));
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: message });
  }
  assert.equal(rateCommands.length, validBodies.length + 1);

  const unknown = await install(request(JSON.stringify({ ...payload, slug: "unknown-agent" })));
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "Unknown agent: unknown-agent" });
  const rateKey = String(rateCommands[0]?.[1]);
  counters.set(rateKey, 30);
  const limited = await install(request(JSON.stringify(payload)));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.deepEqual(await limited.json(), { error: "Rate limited. Slow down." });
  assert.equal(transactions.length, validBodies.length);

  const cronRequest = () => new Request("https://example.test/api/flush", { headers: { authorization: "Bearer cron-test" } });
  const first = await flush(cronRequest());
  assert.equal(first.status, 200);
  assert.equal(commits, 1);
  assert.deepEqual(githubFile.agents[slug], { installs: 10 + validBodies.length, installs7d: 3 + validBodies.length });
  assert.deepEqual(readKeys[0], [pendingKey, ...[
    "2027-01-03", "2027-01-02", "2027-01-01", "2026-12-31", "2026-12-30", "2026-12-29", "2026-12-28",
  ].map(dailyKey)]);
  assert.deepEqual(transactions[validBodies.length], [["decrby", pendingKey, validBodies.length]]);

  t.mock.timers.setTime(new Date("2027-01-04T00:00:00Z").getTime());
  const expired = await flush(cronRequest());
  assert.equal(expired.status, 200);
  assert.equal(commits, 2);
  assert.deepEqual(githubFile.agents[slug], { installs: 10 + validBodies.length, installs7d: validBodies.length });

  const unchanged = await flush(cronRequest());
  assert.equal((await unchanged.json()).flushed, false);
  assert.equal(commits, 2);
});
