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

const directories = new Set();
const servers = new Map();
const refusedOrigins = new Set();
const unexpected = [];
let reported = 0;
let installed = false;
// Ports cover any request to the default model addresses. Paths also cover
// provider calls to configured ports and remote model endpoints.
const modelPorts = new Set(["11434", "1234", "13305"]);
const modelPath = /\/(?:api\/(?:tags|show|chat|pull|embed|embeddings)|models|chat\/completions|embeddings)\/?$/;
const systemHelpers = new Map([["where.exe", "where.exe"], ["taskkill", "taskkill.exe"]]);

export function assertProviderTestGuardActive() {
  assert.ok(installed, "Load tests/provider-test-setup.mjs with --import before running provider tests.");
}

export function registerProviderFixtureDirectory(directory) {
  assertProviderTestGuardActive();
  directories.add(realpathSync(directory));
}

export function stubLoopbackConnectionRefused() {
  assertProviderTestGuardActive();
  // Simulate a stopped service without assuming port 9 is free on this machine.
  refusedOrigins.add("http://127.0.0.1:9");
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
  const argv = Array.isArray(second) ? second : [];
  const options = (Array.isArray(second) ? third : second) ?? {};
  const node = realAbsolutePath(process.execPath);
  const failure = () => blocked(`Blocked ${method} outside provider fixtures: ${command}`);

  // These APIs always invoke a shell, which would interpret the command and arguments.
  if (method === "exec" || method === "execSync" || options.shell) throw failure();

  if (method === "fork") {
    if (!isFixture(command) || (options.execPath && realAbsolutePath(options.execPath) !== node) ||
        options.execArgv?.length) throw failure();
    return Reflect.apply(call, receiver, [command, argv, { ...options, execArgv: [] }]);
  }

  // An empty command reaches Node's native parameter validation without launching anything.
  if (command === "") return Reflect.apply(call, receiver, args);
  const helper = process.platform === "win32" && systemHelpers.get(command);
  if (helper) {
    // Use the system copy even when the test or developer has a different executable on PATH.
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", helper);
    return Reflect.apply(call, receiver, [executable, ...args.slice(1)]);
  }

  const allowed = node && realAbsolutePath(command) === node ? isFixture(argv[0]) : isFixture(command);
  if (!allowed) throw failure();
  return Reflect.apply(call, receiver, args);
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
    servers.set(server, { protocol, host });
    server.once("close", () => servers.delete(server));
    return server;
  };
}

function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "localhost." || hostname === "[::1]" ||
    /^127(?:\.\d+){3}$/.test(hostname) ||
    /^\[::ffff:7f[\da-f]{2}:/.test(hostname);
}

function checkHttpTarget(method, url, path = url.pathname) {
  if (refusedOrigins.has(url.origin)) {
    const cause = Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
    throw method === "fetch" ? new TypeError("fetch failed", { cause }) : cause;
  }
  if (!isLoopback(url.hostname) && !modelPorts.has(url.port) && !modelPath.test(path)) return;

  const fixture = [...servers].some(([server, { protocol, host }]) => {
    const address = server.address();
    if (!server.listening || !address || typeof address === "string" || protocol !== url.protocol) return false;
    const port = url.port || (protocol === "https:" ? "443" : "80");
    return port === String(address.port) &&
      (url.hostname === new URL(`${protocol}//${urlHost(address.address)}`).hostname ||
        (host === "localhost" && url.hostname === host));
  });
  if (!fixture) throw blocked(`Blocked ${method} outside test HTTP servers: ${url.origin}${path}`);
}

function checkNodeRequest(method, protocol, args) {
  const [input, overrides] = args;
  const options = typeof input === "string" || input instanceof URL
    ? { ...urlToHttpOptions(new URL(input)), ...overrides }
    : input ?? {};
  if (options.socketPath) return;

  // Match the connection options used by Node, including URL overrides and defaults.
  const host = urlHost(options.hostname || options.host || "localhost");
  const agent = options.agent || (protocol === "https:" ? https.globalAgent : http.globalAgent);
  const port = options.port || options.defaultPort || agent.defaultPort || 80;
  const origin = new URL(`${options.protocol || protocol}//${host}:${port}`);
  checkHttpTarget(method, origin, String(options.path ?? "/").split("?")[0]);
}

function guardHttp() {
  trackTestServers();
  for (const [httpModule, protocol] of [[http, "http:"], [https, "https:"]]) {
    for (const method of ["request", "get"]) {
      const original = httpModule[method];
      httpModule[method] = (...args) => {
        checkNodeRequest(`node:${protocol.slice(0, -1)}.${method}`, protocol, args);
        return Reflect.apply(original, httpModule, args);
      };
    }
  }

  http.ClientRequest = new Proxy(http.ClientRequest, {
    construct(target, args, newTarget) {
      checkNodeRequest("node:http.ClientRequest", "http:", args);
      return Reflect.construct(target, args, newTarget);
    },
  });

  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    checkHttpTarget("fetch", url);
    // Any redirect can lead to an unregistered origin. Explicit redirect
    // handlers can issue the next request through this guard.
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    return fetch(input, { ...init, redirect: redirect === "follow" ? "error" : redirect });
  };
}

export function installProviderTestGuard() {
  if (installed) return;
  installed = true;
  guardChildren();
  guardHttp();
  syncBuiltinESMExports();

  process.on("exit", () => {
    if (unexpected.length === 0) return;
    process.exitCode = 1;
    writeSync(2, `Provider test guard violations:\n${unexpected.join("\n")}\n`);
  });

  let saved;
  const guardedFetch = globalThis.fetch;
  beforeEach(() => {
    saved = overrides.map((key) => [key, process.env[key]]);
    for (const [key] of saved) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    directories.clear();
    refusedOrigins.clear();
    globalThis.fetch = guardedFetch;
    // Provider probes can catch blocked calls and report a provider as unavailable.
    const violations = unexpected.slice(reported);
    reported = unexpected.length;
    assert.deepEqual(violations, [], "Use registered provider fixtures or stub the provider check.");
  });
}
