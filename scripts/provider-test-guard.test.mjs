import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const preload = fileURLToPath(new URL("../tests/provider-test-setup.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("../tests/fixtures/provider-test-guard.mjs", import.meta.url));
const proxyPreload = fileURLToPath(new URL("../tests/fixtures/provider-test-proxy.mjs", import.meta.url));

function runFixture(scenario, origin, proxyEnv = {}) {
  const env = { ...process.env, ...proxyEnv, PROVIDER_GUARD_CASE: scenario, PROVIDER_GUARD_ORIGIN: origin };
  // The fixture needs its own test runner instead of inheriting this worker.
  delete env.NODE_TEST_CONTEXT;
  const imports = scenario === "proxy" ? ["--import", proxyPreload] : [];
  return new Promise((resolve) => {
    execFile(process.execPath, [...imports, "--import", preload, "--test", fixture], {
      env,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

it("blocks unregistered loopback requests through fetch, node:http and node:https", async () => {
  let requests = 0;
  // This server belongs to the parent process and is unregistered in each child.
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("unexpected request");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [scenario, diagnostic] of [
      ["fetch", /Blocked fetch outside test HTTP servers/],
      ["http", /Blocked node:http\.request outside test HTTP servers/],
      ["https", /Blocked node:https\.get outside test HTTP servers/],
      ["alias", /Blocked node:http\.request outside test HTTP servers: http:\/\/localhost\.localdomain/],
    ]) {
      const { code, stdout, stderr } = await runFixture(scenario, origin);
      assert.equal(code, 1, stdout + stderr);
      assert.match(stdout, /failureType: 'hookFailed'/);
      assert.match(stdout, diagnostic);
    }
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("blocks fetch and Node HTTP clients from reaching an unregistered external host", async () => {
  const { code, stdout, stderr } = await runFixture("external", "https://external.example");
  assert.equal(code, 1, stdout + stderr);
  assert.match(stdout, /failureType: 'hookFailed'/);
  for (const method of ["fetch", "node:http.get", "node:https.get"]) {
    assert.ok(stdout.includes(`Blocked ${method} outside test HTTP servers`), stdout);
  }
});

it("fails the test process after a caught violation beyond the last per-test hook", async () => {
  const { code, stdout, stderr } = await runFixture("late", "");
  assert.match(stdout, /^ok 1 - passes before teardown$/m);
  assert.equal(code, 1);
  assert.match(stdout + stderr, /Provider test guard violations:\s*(?:# )?Blocked spawnSync outside provider fixtures/);
});

it("allows fetch and node:http requests to a server the test starts", async () => {
  const { code, stdout, stderr } = await runFixture("owned", "");
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout, /^# pass 1$/m);
});

it("allows both loopback addresses on a dual-stack fixture", async (t) => {
  const { code, stdout, stderr } = await runFixture("dual-stack", "");
  assert.equal(code, 0, stdout + stderr);
  if (/IPv6 wildcard unavailable/.test(stdout)) {
    t.skip("IPv6 wildcard unavailable");
    return;
  }
  assert.match(stdout, /^# pass 1$/m);
});

it("preserves spawn options when the argument array is omitted, undefined or null", async () => {
  const { code, stdout, stderr } = await runFixture("spawn-options", "");
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout, /^# pass 1$/m);
});

it("blocks shell launches when the spawn argument array is omitted, undefined or null", async () => {
  const { code, stdout, stderr } = await runFixture("spawn-shell", "");
  assert.equal(code, 1, stdout + stderr);
  assert.match(stdout, /failureType: 'hookFailed'/);
  assert.match(stdout, /Blocked spawn outside provider fixtures/);
  assert.match(stdout, /Blocked spawnSync outside provider fixtures/);
});

it("resolves promisified execFile for a registered fixture", { skip: process.platform === "win32" }, async () => {
  const { code, stdout, stderr } = await runFixture("execfile-promisify", "");
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout, /^# pass 1$/m);
});

it("leaves a launch without a smoke flag unguarded even with the harness environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smoke-preload-"));
  const logPath = join(directory, "violations.log");
  const smokePreload = fileURLToPath(new URL("./smoke-provider-preload.cjs", import.meta.url));
  const env = { ...process.env, OPENADMINOS_SMOKE_PROVIDER_GUARD: JSON.stringify({ origins: [], logPath }) };
  for (const name of ["OPENADMINOS_INTUNE_CHAT_SMOKE", "OPENADMINOS_REPORT_ISSUE_SMOKE", "OPENADMINOS_OFFICE_SMOKE", "NODE_TEST_CONTEXT"]) {
    delete env[name];
  }
  try {
    const run = (extra) => new Promise((resolve) => {
      execFile(process.execPath, ["--require", smokePreload, "-e", ""], { env: { ...env, ...extra } },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stderr }));
    });
    const plain = await run({});
    assert.equal(plain.code, 0, plain.stderr);
    await assert.rejects(access(logPath), { code: "ENOENT" });
    // With a smoke flag the preload proceeds and insists on the Electron main process.
    const flagged = await run({ OPENADMINOS_INTUNE_CHAT_SMOKE: "1" });
    assert.notEqual(flagged.code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("accepts a file URL for a registered fork entry", async () => {
  const { code, stdout, stderr } = await runFixture("fork-file-url", "");
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout, /^# pass 1$/m);
});

it("rejects transport overrides for an approved origin without connecting to another listener", async () => {
  let connections = 0;
  const listener = createServer((_request, response) => response.end("unexpected request"));
  listener.on("connection", () => { connections += 1; });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    const { code, stdout, stderr } = await runFixture("route-overrides", `http://127.0.0.1:${listener.address().port}`);
    assert.equal(code, 1, stdout + stderr);
    assert.match(stdout, /failureType: 'hookFailed'/);
    for (const key of ["agent", "lookup", "createConnection", "socketPath", "socket", "_defaultAgent", "dispatcher"]) {
      assert.ok(stdout.includes(`outside test HTTP servers: ${key} override`), stdout);
    }
    assert.equal(connections, 0);
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

it("pins localhost requests to the fixture's bound address", async (t) => {
  const { code, stdout, stderr } = await runFixture("localhost-family", "");
  assert.equal(code, 0, stdout + stderr);
  if (/IPv6 loopback unavailable/.test(stdout)) {
    t.skip("IPv6 loopback unavailable");
    return;
  }
  assert.match(stdout, /^# pass 1$/m);
});

it("sends approved requests directly despite inherited proxy settings and a preinstalled dispatcher", async () => {
  let connections = 0;
  const proxy = createServer((_request, response) => response.writeHead(502).end());
  proxy.on("connection", () => { connections += 1; });
  proxy.on("connect", (_request, socket) => socket.destroy());
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const { code, stdout, stderr } = await runFixture("proxy", "", {
      NODE_USE_ENV_PROXY: "1", node_use_env_proxy: "1",
      HTTP_PROXY: url, http_proxy: url,
      HTTPS_PROXY: url, https_proxy: url,
      ALL_PROXY: url, all_proxy: url,
      NO_PROXY: "", no_proxy: "",
    });
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /^# pass 1$/m);
    assert.equal(connections, 0);
  } finally {
    await new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  }
});
