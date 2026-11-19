import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Server } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach } from "node:test";
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
const unexpected = [];
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
  syncBuiltinESMExports();
}

function guardFetch() {
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (...args) {
    const server = Reflect.apply(listen, this, args);
    const host = typeof args[1] === "string" ? args[1] : args[0]?.host;
    servers.set(server, host);
    server.once("close", () => servers.delete(server));
    return server;
  };

  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === "http://127.0.0.1:9") {
      // Simulate a stopped service without assuming port 9 is free on this machine.
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" }) });
    }
    if (!modelPorts.has(url.port) && !modelPath.test(url.pathname)) return fetch(input, init);

    const fixture = [...servers].some(([server, host]) => {
      const address = server.address();
      return server.listening && url.protocol === "http:" && address &&
        (url.hostname === (address.family === "IPv6" ? `[${address.address}]` : address.address) ||
          (host === "localhost" && url.hostname === host)) &&
        (url.port || "80") === String(address.port);
    });
    if (!fixture) throw blocked(`Blocked fetch outside test HTTP servers: ${url.origin}${url.pathname}`);

    // A test fixture may send redirects. Production redirect handlers can follow
    // them explicitly through this guard, but native fetch must never follow them.
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    return fetch(input, { ...init, redirect: redirect === "follow" ? "error" : redirect });
  };
}

export function installProviderTestGuard() {
  if (installed) return;
  installed = true;
  guardChildren();
  guardFetch();

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
    globalThis.fetch = guardedFetch;
    // Provider probes can catch blocked calls and report a provider as unavailable.
    assert.deepEqual(unexpected.splice(0), [], "Use registered provider fixtures or stub the provider check.");
  });
}
