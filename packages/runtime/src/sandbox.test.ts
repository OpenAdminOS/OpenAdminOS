import { PassThrough } from "node:stream";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
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

  it("reports SDK platform support when enabled", async () => {
    const diagnostics = await probeMxcSandbox({
      env: { [OPENADMINOS_MXC_FLAG]: "1" },
      loadSdk: async () => ({
        getPlatformSupport: () => ({
          isSupported: true,
          defaultBackend: "processcontainer",
          platform: "windows",
        }),
        createConfigFromPolicy: () => ({ process: {} }),
        spawnSandboxFromConfig: () => fakeChildProcess(),
      }),
    });

    assert.equal(diagnostics.status, "available");
    assert.equal(diagnostics.supported, true);
    assert.equal(diagnostics.containment, "processcontainer");
    assert.match(diagnostics.detail, /windows/);
  });

  it("spawns with no network and a scrubbed environment by default", async () => {
    let capturedPolicy: Record<string, unknown> | undefined;
    let capturedConfig: { process?: { commandLine?: string } } | undefined;
    let capturedOptions: Record<string, unknown> | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    const runner = createMxcSandboxRunner({
      env: {
        [OPENADMINOS_MXC_FLAG]: "1",
        PATH: "/usr/bin",
        OPENAI_API_KEY: "secret",
      },
      loadSdk: async () => ({
        getPlatformSupport: () => ({ isSupported: true }),
        createConfigFromPolicy: (policy) => {
          capturedPolicy = policy;
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
      readonlyPaths: ["/app/guest", "/app/guest"],
      readwritePaths: ["/tmp/openadminos-run"],
      timeoutMs: 1000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "hello\n");
    assert.equal(capturedConfig?.process?.commandLine, "node guest.js");
    assert.deepEqual(capturedOptions, { usePty: false, experimental: true });
    assert.equal(capturedEnv?.PATH, "/usr/bin");
    assert.equal(capturedEnv?.OPENAI_API_KEY, undefined);

    const network = capturedPolicy?.network as { allowOutbound?: boolean } | undefined;
    assert.equal(network?.allowOutbound, false);

    const filesystem = capturedPolicy?.filesystem as
      | { readonlyPaths?: string[]; readwritePaths?: string[] }
      | undefined;
    assert.deepEqual(filesystem?.readonlyPaths, ["/app/guest"]);
    assert.deepEqual(filesystem?.readwritePaths, ["/tmp/openadminos-run"]);
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
