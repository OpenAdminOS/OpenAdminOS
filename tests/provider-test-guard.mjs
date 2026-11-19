// Catch accidental access to real providers from test and app code, including
// missing stubs, inherited environment settings and fallback paths. This guard
// is not a sandbox against test code written to evade it.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { realpathSync, writeSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { Server } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { urlToHttpOptions } from "node:url";
import { promisify } from "node:util";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const overrides = [
  "OPENADMINOS_CLAUDE_CODE_BINARY",
  "OPENADMINOS_CODEX_BINARY",
  "OPENADMINOS_COPILOT_BINARY",
  "OPENADMINOS_GEMINI_BINARY",
  "OPENADMINOS_APPLE_FOUNDATION_HELPER",
  "OPENAGENTS_OLLAMA_URL",
  "OLLAMA_HOST",
  "OPENADMINOS_LM_STUDIO_URL",
  "OPENADMINOS_LEMONADE_URL",
  "OPENADMINOS_EMBEDDING_ENDPOINT",
];

const proxyKeys = ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
const proxyOverrides = [...proxyKeys, ...proxyKeys.map((key) => key.toLowerCase())];
const directories = new Set();
const fixtureSpawnObservers = new Map();
const servers = new Map();
const refusedOrigins = new Set();
const liveMcpOrigins = new Set();
const unexpected = [];
let reported = 0;
let installed = false;
const systemHelpers = new Map([["where.exe", "where.exe"], ["taskkill", "taskkill.exe"]]);

export function assertProviderTestGuardActive() {
  assert.ok(installed, "Load tests/provider-test-setup.mjs with --import before running provider tests.");
}

export function registerProviderFixtureDirectory(directory) {
  assertProviderTestGuardActive();
  directories.add(realpathSync(directory));
}

export function waitForProviderFixtureExit(executable) {
  assertProviderTestGuardActive();
  assert.ok(isFixture(executable), "Register the provider fixture before watching its exit.");
  const path = realpathSync(executable);
  assert.ok(!fixtureSpawnObservers.has(path), "The fixture already has a pending exit watcher.");
  return new Promise((resolve, reject) => {
    fixtureSpawnObservers.set(path, (child) => {
      child.once("exit", (_code, signal) => resolve(signal));
      child.once("error", reject);
    });
  });
}

export function stubLoopbackConnectionRefused() {
  assertProviderTestGuardActive();
  // Simulate a stopped service without assuming port 9 is free on this machine.
  refusedOrigins.add("http://127.0.0.1:9");
}

export function allowLiveMcpOrigin(endpoint) {
  assertProviderTestGuardActive();
  assert.equal(process.env.OPENADMINOS_LIVE_MCP, "1", "Set OPENADMINOS_LIVE_MCP=1 to run live MCP probes.");
  const url = new URL(endpoint);
  assert.equal(url.protocol, "https:", "Live MCP probes must declare an HTTPS origin.");
  liveMcpOrigins.add(url.origin);
}

function realAbsolutePath(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isFixture(path) {
  const resolved = realAbsolutePath(path);
  return resolved !== undefined && [...directories].some((directory) => {
    const entry = relative(directory, resolved);
    return entry !== "" && entry !== ".." && !entry.startsWith(`..${sep}`) && !isAbsolute(entry);
  });
}

function blocked(message) {
  unexpected.push(message);
  process.exitCode = 1;
  return new Error(message);
}

function guardCommand(method, call, receiver, args) {
  const [command, second, third] = args;
  const node = realAbsolutePath(process.execPath);
  const failure = () => blocked(`Blocked ${method} outside provider fixtures: ${command}`);

  // These APIs always invoke a shell, which would interpret the command and arguments.
  if (method === "exec" || method === "execSync") throw failure();

  // Node treats an options object in slot two differently from null or
  // undefined, which leave the options in slot three. Keep the native
  // callback overloads for execFile and its promisified variant.
  const optionsInSecond = second != null && typeof second === "object" && !Array.isArray(second);
  const argv = Array.isArray(second) ? [...second] : second == null || optionsInSecond ? [] : second;
  const effectiveOptions = optionsInSecond ? second : third;
  const options = effectiveOptions != null && typeof effectiveOptions === "object" && !Array.isArray(effectiveOptions)
    ? { ...effectiveOptions }
    : effectiveOptions;
  const normalized = method === "execFile" && typeof second === "function"
    ? [command, second]
    : method === "execFile"
      ? [command, argv, options, optionsInSecond ? third : args[3]]
      : [command, argv, options];

  // Shell scripts in fixture directories run directly via their shebang.
  // No fixture is registered for shell command interpretation.
  if (options?.shell) throw failure();

  if (method === "fork") {
    if (!isFixture(command) || (options?.execPath && realAbsolutePath(options.execPath) !== node) ||
        options?.execArgv?.length) throw failure();
    return Reflect.apply(call, receiver, [command, argv, { ...options, execArgv: [] }]);
  }

  // An empty command reaches Node's native parameter validation without launching anything.
  if (command === "") return Reflect.apply(call, receiver, normalized);
  const helper = process.platform === "win32" && systemHelpers.get(command);
  if (helper) {
    // Use the system copy even when the test or developer has a different executable on PATH.
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", helper);
    return Reflect.apply(call, receiver, [executable, ...normalized.slice(1)]);
  }

  const allowed = node && realAbsolutePath(command) === node ? Array.isArray(argv) && isFixture(argv[0]) : isFixture(command);
  if (!allowed) throw failure();
  const result = Reflect.apply(call, receiver, normalized);
  if (method === "spawn" && fixtureSpawnObservers.size > 0) {
    const path = realAbsolutePath(command);
    const observe = fixtureSpawnObservers.get(path);
    if (observe) {
      fixtureSpawnObservers.delete(path);
      observe(result);
    }
  }
  return result;
}

function guardChildren() {
  for (const method of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const original = childProcess[method];
    const guarded = (...args) => guardCommand(method, original, childProcess, args);
    const custom = original[promisify.custom];
    // The built-in promisified variants call Node's original functions internally.
    if (custom) {
      Object.defineProperty(guarded, promisify.custom, {
        value: (...args) => guardCommand(method, custom, childProcess, args),
      });
    }
    childProcess[method] = guarded;
  }
}

function trackTestServers() {
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (...args) {
    const server = Reflect.apply(listen, this, args);
    const protocol = server instanceof https.Server ? "https:" : server instanceof http.Server ? "http:" : undefined;
    if (!protocol) return server;

    const host = typeof args[1] === "string" ? args[1] : args[0]?.host;
    servers.set(server, { protocol, host, ipv6Only: args[0]?.ipv6Only === true });
    server.once("close", () => servers.delete(server));
    return server;
  };
}

function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function checkHttpTarget(method, url, path = url.pathname) {
  if (refusedOrigins.has(url.origin)) {
    const cause = Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
    throw method === "fetch" ? new TypeError("fetch failed", { cause }) : cause;
  }
  if (liveMcpOrigins.has(url.origin)) return;

  const fixture = [...servers].some(([server, { protocol, host, ipv6Only }]) => {
    const address = server.address();
    if (!server.listening || !address || typeof address === "string" || protocol !== url.protocol) return false;
    const port = url.port || (protocol === "https:" ? "443" : "80");
    return port === String(address.port) &&
      (url.hostname === new URL(`${protocol}//${urlHost(address.address)}`).hostname ||
        (address.address === "::" && (url.hostname === "[::1]" || (!ipv6Only && url.hostname === "127.0.0.1"))) ||
        (host === "localhost" && url.hostname === host));
  });
  if (!fixture) throw blocked(`Blocked ${method} outside test HTTP servers: ${url.origin}${path}`);
}

function checkedNodeRequest(method, protocol, agent, args) {
  const [input, overrides] = args;
  const hasUrl = typeof input === "string" || input instanceof URL;
  const options = hasUrl
    ? { ...urlToHttpOptions(new URL(input)), ...overrides }
    : { ...input };
  const callback = hasUrl && typeof overrides !== "function" ? args[2] : overrides;

  // Match the connection options used by Node, including URL overrides and defaults.
  const host = urlHost(options.hostname || options.host || "localhost");
  const port = options.port || options.defaultPort || agent.defaultPort || 80;
  const origin = new URL(`${options.protocol || protocol}//${host}:${port}`);
  checkHttpTarget(method, origin, String(options.path ?? "/").split("?")[0]);

  for (const key of ["lookup", "createConnection", "socketPath", "_defaultAgent"]) {
    if (options[key] != null) throw blocked(`Blocked ${method} outside test HTTP servers: ${key} override`);
  }
  if (options.agent != null && options.agent !== agent) {
    throw blocked(`Blocked ${method} outside test HTTP servers: agent override`);
  }
  return [{ ...options, agent }, callback];
}

function guardHttp({ directHttpAgent, directHttpsAgent, directDispatcher }) {
  trackTestServers();
  for (const [httpModule, protocol, agent] of [[http, "http:", directHttpAgent], [https, "https:", directHttpsAgent]]) {
    for (const method of ["request", "get"]) {
      const original = httpModule[method];
      httpModule[method] = (...args) => {
        const checked = checkedNodeRequest(`node:${protocol.slice(0, -1)}.${method}`, protocol, agent, args);
        return Reflect.apply(original, httpModule, checked);
      };
    }
  }

  http.ClientRequest = new Proxy(http.ClientRequest, {
    construct(target, args, newTarget) {
      const checked = checkedNodeRequest("node:http.ClientRequest", "http:", directHttpAgent, args);
      return Reflect.construct(target, checked, newTarget);
    },
  });

  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    checkHttpTarget("fetch", url);
    const options = { ...init };
    if (options.dispatcher != null && options.dispatcher !== directDispatcher) {
      throw blocked("Blocked fetch outside test HTTP servers: dispatcher override");
    }
    // Any redirect can lead to an unregistered origin. Explicit redirect
    // handlers can issue the next request through this guard.
    const redirect = options.redirect ?? (input instanceof Request ? input.redirect : "follow");
    return fetch(input, { ...options, dispatcher: directDispatcher, redirect: redirect === "follow" ? "error" : redirect });
  };
}

function clearEnvironment(keys) {
  // Snapshot every value first because environment keys are case-insensitive on Windows.
  const saved = keys.map((key) => [key, process.env[key]]);
  for (const [key] of saved) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function isolateProxies() {
  const restoreEnvironment = clearEnvironment(proxyOverrides);
  const originalHttpAgent = http.globalAgent;
  const originalHttpsAgent = https.globalAgent;
  const originalDispatcher = getGlobalDispatcher();
  // Node can have already configured its agents and Fetch dispatcher at startup.
  const directHttpAgent = new http.Agent({ keepAlive: true });
  const directHttpsAgent = new https.Agent({ keepAlive: true });
  const directDispatcher = new Agent();
  http.globalAgent = directHttpAgent;
  https.globalAgent = directHttpsAgent;
  setGlobalDispatcher(directDispatcher);

  function restore() {
    restoreEnvironment();
    http.globalAgent = originalHttpAgent;
    https.globalAgent = originalHttpsAgent;
    setGlobalDispatcher(originalDispatcher);
    syncBuiltinESMExports();
  }
  return { directHttpAgent, directHttpsAgent, directDispatcher, restore };
}

export function installProviderTestGuard() {
  if (installed) return;
  installed = true;
  const direct = isolateProxies();
  guardChildren();
  guardHttp(direct);
  syncBuiltinESMExports();

  process.on("exit", () => {
    direct.restore();
    if (unexpected.length === 0) return;
    process.exitCode = 1;
    writeSync(2, `Provider test guard violations:\n${unexpected.join("\n")}\n`);
  });

  let restoreOverrides;
  const guardedFetch = globalThis.fetch;
  beforeEach(() => {
    restoreOverrides = clearEnvironment(overrides);
  });

  afterEach(() => {
    restoreOverrides();
    directories.clear();
    fixtureSpawnObservers.clear();
    refusedOrigins.clear();
    liveMcpOrigins.clear();
    globalThis.fetch = guardedFetch;
    // Provider probes can catch blocked calls and report a provider as unavailable.
    const violations = unexpected.slice(reported);
    reported = unexpected.length;
    assert.deepEqual(violations, [], "Use registered provider fixtures or stub the provider check.");
  });
}
