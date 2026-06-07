import { PassThrough } from "node:stream";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OPENADMINOS_MXC_FLAG,
  createMxcSandboxRunner,
  probeMxcSandbox,
} from "./sandbox.js";

describe("MXC sandbox runner", () => {
  it("stays disabled unless the experimental flag is set", async () => {
    let loaded = false;
    const diagnostics = await probeMxcSandbox({
      env: {},
      loadSdk: async () => {
        loaded = true;
        throw new Error("should not load");
      },
    });

    assert.equal(loaded, false);
    assert.equal(diagnostics.status, "disabled");
    assert.equal(diagnostics.experimentalEnabled, false);
  });

  it("refuses to run and does not load MXC when disabled", async () => {
    let loaded = false;
    const runner = createMxcSandboxRunner({
      env: {},
      loadSdk: async () => {
        loaded = true;
        throw new Error("should not load");
      },
    });

    await assert.rejects(
      () =>
        runner.run({
          commandLine: "node guest.js",
          readonlyPaths: ["/app/guest"],
          readwritePaths: ["/tmp/openadminos-run"],
        }),
      /MXC sandbox is disabled/,
    );
    assert.equal(loaded, false);
  });

  it("reports SDK platform support when enabled", async () => {
    const diagnostics = await probeMxcSandbox({
      env: { [OPENADMINOS_MXC_FLAG]: "1" },
      loadSdk: async () => ({
        getPlatformSupport: () => ({
          isSupported: true,
          availableMethods: ["processcontainer"],
          isolationTier: "base-container",
          isolationWarnings: ["host-prep check passed"],
        }),
        createConfigFromPolicy: () => ({ process: {} }),
        spawnSandboxFromConfig: () => fakeChildProcess(),
      }),
    });

    assert.equal(diagnostics.status, "available");
    assert.equal(diagnostics.supported, true);
    assert.equal(diagnostics.containment, "processcontainer");
    assert.deepEqual(diagnostics.availableMethods, ["processcontainer"]);
    assert.equal(diagnostics.isolationTier, "base-container");
    assert.match(diagnostics.detail, /processcontainer/);
    assert.match(diagnostics.detail, /base-container/);
  });

  it("spawns with no network and a scrubbed environment by default", async () => {
    let capturedPolicy: Record<string, unknown> | undefined;
    let capturedConfig: { process?: { commandLine?: string } } | undefined;
    let capturedOptions: Record<string, unknown> | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedContainment: string | undefined;
    const readonlyPath = path.resolve("/app/guest");
    const readwritePath = path.resolve("/tmp/openadminos-run");

    const runner = createMxcSandboxRunner({
      env: {
        [OPENADMINOS_MXC_FLAG]: "1",
        PATH: "/usr/bin",
        OPENAI_API_KEY: "secret",
      },
      loadSdk: async () => ({
        getPlatformSupport: () => ({ isSupported: true }),
        createConfigFromPolicy: (policy, containment) => {
          capturedPolicy = policy;
          capturedContainment = containment;
          return { process: {} };
        },
        spawnSandboxFromConfig: (config, options, _cwd, env) => {
          capturedConfig = config;
          capturedOptions = options;
          capturedEnv = env;
          return fakeChildProcess("hello\n", "");
        },
      }),
    });

    const result = await runner.run({
      commandLine: "node guest.js",
      readonlyPaths: [readonlyPath, readonlyPath],
      readwritePaths: [readwritePath],
      containment: "processcontainer",
      timeoutMs: 1000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "hello\n");
    assert.equal(capturedContainment, "processcontainer");
    assert.equal(capturedConfig?.process?.commandLine, "node guest.js");
    assert.deepEqual(capturedOptions, { usePty: false });
    assert.equal(capturedEnv?.PATH, "/usr/bin");
    assert.equal(capturedEnv?.OPENAI_API_KEY, undefined);

    const network = capturedPolicy?.network as { allowOutbound?: boolean } | undefined;
    assert.equal(network?.allowOutbound, false);

    const filesystem = capturedPolicy?.filesystem as
      | { readonlyPaths?: string[]; readwritePaths?: string[] }
      | undefined;
    assert.deepEqual(filesystem?.readonlyPaths, [readonlyPath]);
    assert.deepEqual(filesystem?.readwritePaths, [readwritePath]);
  });

  it("sets the sandbox process cwd and requires filesystem policy coverage", async () => {
    let capturedConfig: { process?: { commandLine?: string; cwd?: string } } | undefined;
    const cwd = path.resolve("/tmp/openadminos-run/work");
    const runner = createMxcSandboxRunner({
      env: { [OPENADMINOS_MXC_FLAG]: "1" },
      loadSdk: async () => ({
        getPlatformSupport: () => ({ isSupported: true }),
        createConfigFromPolicy: () => ({ process: {} }),
        spawnSandboxFromConfig: (config) => {
          capturedConfig = config;
          return fakeChildProcess();
        },
      }),
    });

    await assert.rejects(
      () =>
        runner.run({
          commandLine: "node guest.js",
          readonlyPaths: [path.resolve("/app/guest")],
          readwritePaths: [path.resolve("/tmp/openadminos-run")],
          cwd: path.resolve("/outside"),
        }),
      /cwd must be covered/,
    );

    await runner.run({
      commandLine: "node guest.js",
      readonlyPaths: [path.resolve("/app/guest")],
      readwritePaths: [path.resolve("/tmp/openadminos-run")],
      cwd,
    });

    assert.equal(capturedConfig?.process?.cwd, cwd);
  });

  it("uses the SDK experimental flag only for experimental MXC backends", async () => {
    const options: Record<string, unknown>[] = [];
    const runner = createMxcSandboxRunner({
      env: { [OPENADMINOS_MXC_FLAG]: "1" },
      loadSdk: async () => ({
        getPlatformSupport: () => ({ isSupported: true }),
        createConfigFromPolicy: () => ({ process: {} }),
        spawnSandboxFromConfig: (_config, spawnOptions) => {
          options.push(spawnOptions ?? {});
          return fakeChildProcess();
        },
      }),
    });

    await runner.run({
      commandLine: "node guest.js",
      readonlyPaths: [path.resolve("/app/guest")],
      readwritePaths: [path.resolve("/tmp/openadminos-run")],
      containment: "bubblewrap",
    });
    await runner.run({
      commandLine: "node guest.js",
      readonlyPaths: [path.resolve("/app/guest")],
      readwritePaths: [path.resolve("/tmp/openadminos-run")],
      containment: "microvm",
    });

    assert.deepEqual(options, [
      { usePty: false },
      { usePty: false, experimental: true },
    ]);
  });

  it("brokers sandbox stdout protocol over child stdin", async () => {
    const child = fakeChildProcess(
      JSON.stringify({
        id: "log-1",
        method: "log",
        params: {
          level: "info",
          message: "sandbox started",
        },
      }) + "\n",
      "diagnostic only\n",
    );
    const stdinWrites: string[] = [];
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdinWrites.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        callback();
      },
    });

    const runner = createMxcSandboxRunner({
      env: {
        [OPENADMINOS_MXC_FLAG]: "1",
        PATH: "/usr/bin",
      },
      loadSdk: async () => ({
        getPlatformSupport: () => ({ isSupported: true }),
        createConfigFromPolicy: () => ({ process: {} }),
        spawnSandboxFromConfig: () => child,
      }),
    });

    const result = await runner.run({
      commandLine: "node guest.js",
      readonlyPaths: ["/app/guest"],
      readwritePaths: ["/tmp/openadminos-run"],
      broker: {
        async handle(request) {
          assert.equal(request.method, "log");
          return { id: request.id, ok: true };
        },
      },
    });

    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "diagnostic only\n");
    assert.deepEqual(stdinWrites.map((line) => JSON.parse(line)), [
      { id: "log-1", ok: true },
    ]);
  });
});

function fakeChildProcess(stdoutText = "", stderrText = ""): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(emitter, {
    stdout,
    stderr,
    killed: false,
    kill: () => {
      Object.assign(emitter, { killed: true });
      return true;
    },
  });

  process.nextTick(() => {
    if (stdoutText.length > 0) stdout.write(stdoutText);
    stdout.end();
    if (stderrText.length > 0) stderr.write(stderrText);
    stderr.end();
    emitter.emit("close", 0, null);
  });

  return emitter;
}
