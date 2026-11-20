import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolateSmokeProviders, waitForSmokeServer } from "./smoke-provider-isolation.mjs";

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

it("installs the smoke guard only for the flag combinations the app treats as smoke launches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smoke-preload-"));
  const logPath = join(directory, "violations.log");
  const smokePreload = fileURLToPath(new URL("./smoke-provider-preload.cjs", import.meta.url));
  const env = { ...process.env, OPENADMINOS_SMOKE_PROVIDER_GUARD: JSON.stringify({ origins: [], logPath }) };
  for (const name of ["OPENADMINOS_INTUNE_CHAT_SMOKE", "OPENADMINOS_REPORT_ISSUE_SMOKE", "OPENADMINOS_OFFICE_SMOKE",
    "OPENADMINOS_SCREENSHOT_CAPTURE", "NODE_TEST_CONTEXT"]) {
    delete env[name];
  }
  // Synchronous ESM loading is disabled, as in an Electron launch with
  // --no-experimental-require-module: an unflagged launch must not load the guard.
  const run = (extra) => new Promise((resolve) => {
    execFile(process.execPath, ["--no-experimental-require-module", "--require", smokePreload, "-e", ""],
      { env: { ...env, ...extra } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stderr }));
  });
  try {
    for (const extra of [{}, { OPENADMINOS_OFFICE_SMOKE: "1" }, { OPENADMINOS_SCREENSHOT_CAPTURE: "1" }]) {
      const result = await run(extra);
      assert.equal(result.code, 0, `${JSON.stringify(extra)}: ${result.stderr}`);
      await assert.rejects(access(logPath), { code: "ENOENT" });
    }
    // Real smoke launches proceed past the flag check and then fail in plain Node,
    // which is neither the Electron main process nor loading ESM synchronously.
    for (const extra of [
      { OPENADMINOS_INTUNE_CHAT_SMOKE: "1" },
      { OPENADMINOS_REPORT_ISSUE_SMOKE: "1" },
      { OPENADMINOS_OFFICE_SMOKE: "1", OPENADMINOS_SCREENSHOT_CAPTURE: "1" },
    ]) {
      const result = await run(extra);
      assert.notEqual(result.code, 0, JSON.stringify(extra));
      // The failure comes from loading the guard, so the flag check let it through.
      assert.match(result.stderr, /ERR_REQUIRE_ESM/, JSON.stringify(extra));
    }
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

it("accepts only the smoke run's own server as ready, never a listener another process holds", async () => {
  // A foreign server already answers on the port the smoke wants.
  const foreign = createServer((_request, response) => response.end("foreign"));
  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${foreign.address().port}`;
  const serve = `const { createServer } = require("node:http");
    const server = createServer((_q, r) => r.end("own"));
    server.on("error", (error) => { console.error(error.code); process.exit(1); });
    server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready at " + process.env.URL));`;
  try {
    const clash = spawn(process.execPath, ["-e", serve], {
      env: { ...process.env, PORT: String(foreign.address().port), URL: url }, stdio: ["ignore", "pipe", "pipe"],
    });
    await assert.rejects(waitForSmokeServer(clash, url, 20_000), /exited .* before it was ready/);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
  }

  // The positive fixture binds port 0 and keeps printing a colored banner with
  // its assigned port, as Vite does when color is on, so no port is released
  // and reused between choosing it and binding it.
  const colored = `const { createServer } = require("node:http");
    const server = createServer((_q, r) => r.end("own"));
    server.listen(0, "127.0.0.1", () => {
      const banner = () => console.log("Local: http://127.0.0.1:\\x1b[1m" + server.address().port + "\\x1b[22m/");
      banner(); setInterval(banner, 100);
    });`;
  const own = spawn(process.execPath, ["-e", colored], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await new Promise((resolve, reject) => {
      let text = "";
      own.stdout.on("data", function read(chunk) {
        text += chunk;
        const match = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").match(/127\.0\.0\.1:(\d+)/);
        if (match) { own.stdout.off("data", read); resolve(Number(match[1])); }
      });
      own.once("exit", () => reject(new Error("fixture exited")));
    });
    await waitForSmokeServer(own, `http://127.0.0.1:${port}`, 20_000);
    // Read over a direct connection, like the probe, so an inherited proxy cannot answer.
    const body = await new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${port}`, { agent: false }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve(text));
      }).on("error", reject);
    });
    assert.equal(body, "own");
  } finally {
    own.kill();
  }
});

it("probes the renderer directly, never through a proxy the runner inherited", async () => {
  let proxied = 0;
  const proxy = createServer((_request, response) => {
    proxied += 1;
    response.end("proxy says ok");
  });
  // Proxy clients may tunnel with CONNECT instead of sending the request itself.
  proxy.on("connect", (_request, socket) => {
    proxied += 1;
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  // A test-owned listener holds the port for the whole test and is never ready,
  // so only a proxy could make the probe succeed.
  const notReady = createServer((_request, response) => { response.statusCode = 503; response.end(); });
  await new Promise((resolve) => notReady.listen(0, "127.0.0.1", resolve));
  const port = notReady.address().port;
  const helper = fileURLToPath(new URL("./smoke-provider-isolation.mjs", import.meta.url));
  // The "server" reports the held port's address; that listener answers 503.
  // A proxy reaches the probe through the inherited environment or a dispatcher
  // installed before the helper runs; the probe must ignore both.
  const runner = `const { spawn } = require("node:child_process");
    const { ProxyAgent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new ProxyAgent(process.env.HTTP_PROXY));
    import(${JSON.stringify(pathToFileURL(helper).href)}).then(async ({ waitForSmokeServer }) => {
      const child = spawn(process.execPath, ["-e", "console.log('ready at :${port}'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
      try { await waitForSmokeServer(child, "http://127.0.0.1:${port}", 1500); console.log("READY"); }
      catch (error) { console.log("REJECTED " + error.message); }
      finally { child.kill(); process.exit(0); }
    });`;
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const env = { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  try {
    const stdout = await new Promise((resolve) => {
      execFile(process.execPath, ["-e", runner], { env, cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 30_000 }, (_error, out) => resolve(out));
    });
    assert.match(stdout, /REJECTED Timed out waiting for the smoke server/);
    assert.equal(proxied, 0);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => notReady.close(resolve));
  }
});

it("drops inherited smoke and capture launch flags from the Electron environment", async () => {
  const inherited = ["OPENADMINOS_SCREENSHOT_CAPTURE", "OPENADMINOS_OFFICE_SMOKE", "OPENADMINOS_FIRST_RUN_CAPTURE",
    "OPENADMINOS_INTUNE_CHAT_SMOKE", "OPENADMINOS_SUPPORT_BUNDLE_EXPORT_PATH"];
  const saved = Object.fromEntries(inherited.map((name) => [name, process.env[name]]));
  for (const name of inherited) process.env[name] = "1";
  let isolation;
  try {
    isolation = await isolateSmokeProviders();
    for (const name of inherited) assert.equal(isolation.env[name], undefined, name);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // No Electron ran, so the harness reports that the guard was never installed.
    await assert.rejects(isolation.close(), /without installing the provider guard/);
  }
});
