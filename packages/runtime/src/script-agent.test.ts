import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import {
  ConnectorScopeError,
  GraphAccessDeniedError,
  graphAccessDenialFromError,
  type RunContext,
  type SandboxBrokerRequest,
  type SandboxBrokerResponse,
} from "@openadminos/agent-sdk";

import {
  agentTemplateToModule,
  parseAgentTemplate,
} from "./agent-template.js";
import { reasoningWithoutAnswerInChain } from "./llm-ollama.js";
import { scriptAgentTemplateToModule } from "./script-agent.js";
/**
 * Stderr as Node writes it for an uncaught exception with this header and
 * message, and the exit record the run's hook writes for it.
 */
const uncaught = (input: SandboxRunInput, text: string) => {
  writeFileSync(input.env!.OPENADMINOS_EXIT_RECORD!, JSON.stringify({ message: text.replace(/^[A-Za-z]*Error: /, "") }));
  return `file:///agent.mjs:1\nthrow error;\n^\n\n${text}\n    at main (file:///agent.mjs:1:1)\n\nNode.js v22.0.0`;
};

import type { SandboxRunInput, SandboxRunner } from "./sandbox.js";

describe("script-backed MXC agents", () => {
  it("runs a read agent through the sandbox runner and host broker", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openadminos-script-test-"));
    const realTempRoot = await realpath(tempRoot);
    const agentDir = path.join(tempRoot, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "agent.mjs"), "process.exit(0);\n");

    let capturedInput: SandboxRunInput | undefined;
    const runner: SandboxRunner = {
      id: "mxc",
      probe: async () => ({
        backend: "mxc",
        status: "available",
        experimentalEnabled: true,
        supported: true,
        detail: "test",
      }),
      run: async (input) => {
        capturedInput = input;
        assert.equal(input.allowNetwork, false);
        assert.equal(input.broker, undefined);
        assert.equal(input.env?.ELECTRON_RUN_AS_NODE, "1");
        assert.ok(input.env?.OPENADMINOS_BROKER_DIR);
        assert.ok(input.env.OPENADMINOS_BROKER_DIR.startsWith(input.cwd!));

        const brokerDir = input.env.OPENADMINOS_BROKER_DIR;
        const graphResponse = await requestViaBrokerDir(brokerDir, {
          id: "graph-1",
          method: "graph.request",
          params: {
            method: "GET",
            path: "/deviceManagement/managedDevices",
            query: { $select: "id,deviceName" },
          },
        } satisfies SandboxBrokerRequest);
        assert.equal(graphResponse.ok, true);

        const llmResponse = await requestViaBrokerDir(brokerDir, {
          id: "llm-1",
          method: "llm.complete",
          params: {
            prompt: "Summarize the posture metrics.",
            maxTokens: 100,
          },
        } satisfies SandboxBrokerRequest);
        assert.equal(llmResponse.ok, true);

        await writeFile(
          path.join(input.cwd!, "result.json"),
          JSON.stringify({
            summary: "Device posture summary.",
            result: {
              graph: graphResponse.result,
              llm: llmResponse.result,
            },
          }),
          "utf8",
        );
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
    };

    const manifest = parseAgentTemplate(`
descriptor:
  id: script-auditor
  name: Script Auditor
  description: Test script auditor.
  version: 0.1.0
  author:
    name: OpenAdminOS
  category: devices
  mode: read
execution:
  kind: script
  sandbox: mxc
  entrypoint: agent.mjs
skills:
  - id: load_devices
    format: graph
    label: Load devices
    settings:
      method: GET
      path: /deviceManagement/managedDevices
      select:
        - id
        - deviceName
      scopes:
        - DeviceManagementManagedDevices.Read.All
  - id: summarize
    format: llm
    label: Summarize
    settings:
      prompt: Summarize.
definition:
  result:
    summary: Script result.
`);

    const module = scriptAgentTemplateToModule(manifest, agentDir, {
      sandboxRunner: runner,
      tempRoot,
      nodePath: process.execPath,
    });
    const result = await module.run(fakeRunContext());

    assert.equal(result.summary, "Device posture summary.");
    assert.equal(capturedInput?.cwd?.startsWith(realTempRoot), true);
    assert.equal(capturedInput?.readwritePaths.length, 1);
    assert.ok(capturedInput?.cwd?.startsWith(`${capturedInput.readwritePaths[0]}${path.sep}`));
    assert.ok(capturedInput?.readonlyPaths.includes(agentDir));
    assert.equal(capturedInput?.env?.ELECTRON_RUN_AS_NODE, "1");
    assert.ok(capturedInput?.env?.OPENADMINOS_BROKER_DIR);
  });

  it("keeps the brokered Graph denial the script exited on as the cause", async () => {
    const consent = new GraphAccessDeniedError({ method: "GET", path: "/deviceManagement/managedDevices", requiredScopes: ["DeviceManagementManagedDevices.Read.All"], grantedScopes: [] });
    const role = new GraphAccessDeniedError({ method: "GET", path: "/deviceManagement/managedDevices", requiredScopes: ["DeviceManagementManagedDevices.Read.All"], grantedScopes: ["DeviceManagementManagedDevices.Read.All"] });
    const teams = new ConnectorScopeError("Microsoft Graph rejected the request (HTTP 403). The signed-in admin lacks the required Teams scopes.", { connectorId: "teams", missingScopes: [] });
    // Each case: the errors Graph raises in order, the response the script exits on, and the cause expected.
    const cases: Array<{ denials: Error[]; exitOn: number | "other" | "llm"; via?: "connector"; cause: string | undefined }> = [
      { denials: [consent], exitOn: 0, cause: "missing-consent" },
      { denials: [consent], exitOn: "other", cause: undefined },
      { denials: [consent, role], exitOn: 1, cause: "missing-role" },
      // The script recovered from the first denial and failed on the second request.
      { denials: [consent, role], exitOn: 0, cause: undefined },
      { denials: [teams], exitOn: 0, via: "connector", cause: "unknown" },
      // The script logged a Graph denial, went on, and exited on a provider 403.
      { denials: [consent], exitOn: "llm", cause: undefined },
    ];
    for (const testCase of cases) {
      const tempRoot = await mkdtemp(path.join(tmpdir(), "openadminos-script-denial-"));
      const agentDir = path.join(tempRoot, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(path.join(agentDir, "agent.mjs"), "process.exit(1);\n");
      const runner: SandboxRunner = {
        id: "mxc",
        probe: async () => ({ backend: "mxc", status: "available", experimentalEnabled: true, supported: true, detail: "test" }),
        run: async (input) => {
          const messages: string[] = [];
          for (const [index] of testCase.denials.entries()) {
            const response = await requestViaBrokerDir(input.env!.OPENADMINOS_BROKER_DIR!, testCase.via === "connector"
              ? { id: `teams-${index}`, method: "connector.invoke", params: { connector: "teams", capability: "post-channel-message", args: {} } } as SandboxBrokerRequest
              : { id: `graph-${index}`, method: "graph.request", params: { method: "GET", path: "/deviceManagement/managedDevices", query: { $select: "id,deviceName" } } } satisfies SandboxBrokerRequest);
            assert.equal(response.ok, false, JSON.stringify(response));
            messages.push(response.error?.message ?? "");
          }
          const method = testCase.via === "connector" ? "connector.invoke" : "graph.request";
          let stderr: string;
          if (testCase.exitOn === "other") stderr = "Error: result file could not be written";
          else if (testCase.exitOn === "llm") {
            const llm = await requestViaBrokerDir(input.env!.OPENADMINOS_BROKER_DIR!, { id: "llm-1", method: "llm.complete", params: { prompt: "Summarize.", maxTokens: 10 } } satisfies SandboxBrokerRequest);
            assert.equal(llm.ok, false);
            stderr = `Warning: ${method}: ${messages[0]}\nError: llm.complete: ${llm.error?.message}`;
          } else stderr = `Error: ${method}: ${messages[testCase.exitOn]}`;
          return { exitCode: 1, signal: null, stdout: "", stderr };
        },
      };
      const manifest = parseAgentTemplate(`
descriptor:
  id: script-auditor
  name: Script Auditor
  description: Test script auditor.
  version: 0.1.0
  author:
    name: OpenAdminOS
  category: devices
  mode: read
  connectors:
    - id: teams
      minVersion: 1.0.0
      required: false
      capabilities:
        - id: post-channel-message
          version: 1
execution:
  kind: script
  sandbox: mxc
  entrypoint: agent.mjs
skills:
  - id: load_devices
    format: graph
    label: Load devices
    settings:
      method: GET
      path: /deviceManagement/managedDevices
      select:
        - id
        - deviceName
      scopes:
        - DeviceManagementManagedDevices.Read.All
definition:
  result:
    summary: Script result.
`);
      const module = scriptAgentTemplateToModule(manifest, agentDir, { sandboxRunner: runner, tempRoot, nodePath: process.execPath });
      const ctx = fakeRunContext();
      let call = 0;
      ctx.graph.request = async () => { throw testCase.denials[call++]!; };
      ctx.llm.complete = async () => { throw new Error("Ollama responded with HTTP 403 at http://127.0.0.1:11434/api/chat: Forbidden"); };
      ctx.connectors = { teams: { capabilities: { postChannelMessage: async () => { throw testCase.denials[call++]!; } } } } as unknown as RunContext["connectors"];
      const error = await module.run(ctx).then(() => undefined, (failure: unknown) => failure);
      assert.ok(error instanceof Error);
      assert.equal(graphAccessDenialFromError(error)?.cause, testCase.cause, JSON.stringify({ ...testCase, denials: undefined }));
    }
  });

  it("keeps a brokered model reply with reasoning and no answer the script exited on as the cause", async () => {
    const failure = Object.assign(
      new Error('Ollama returned only reasoning from "gpt-oss:20b" and no answer. Retry, or pick a model that answers without reasoning.'),
      { name: "OllamaReasoningWithoutAnswerError" },
    );
    for (const [exitOnModel, readAfter] of [[true, false], [true, true], [false, false]] as const) {
      const tempRoot = await mkdtemp(path.join(tmpdir(), "openadminos-script-reasoning-"));
      const agentDir = path.join(tempRoot, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(path.join(agentDir, "agent.mjs"), "process.exit(1);\n");
      const runner: SandboxRunner = {
        id: "mxc",
        probe: async () => ({ backend: "mxc", status: "available", experimentalEnabled: true, supported: true, detail: "test" }),
        run: async (input) => {
          const llm = await requestViaBrokerDir(input.env!.OPENADMINOS_BROKER_DIR!, { id: "llm-1", method: "llm.complete", params: { prompt: "Summarize." } } satisfies SandboxBrokerRequest);
          assert.equal(llm.ok, false);
          // A brokered read after the model failure, as in a finally block.
          if (readAfter) await requestViaBrokerDir(input.env!.OPENADMINOS_BROKER_DIR!, { id: "read-1", method: "graph.request", params: { method: "GET", path: "/deviceManagement/managedDevices" } } satisfies SandboxBrokerRequest);
          const stderr = uncaught(input, exitOnModel ? `Error: llm.complete: ${llm.error?.message}` : "Error: result file could not be written");
          return { exitCode: 1, signal: null, stdout: "", stderr };
        },
      };
      const manifest = parseAgentTemplate(`
descriptor:
  id: script-auditor
  name: Script Auditor
  description: Test script auditor.
  version: 0.1.0
  author:
    name: OpenAdminOS
  category: devices
  mode: read
execution:
  kind: script
  sandbox: mxc
  entrypoint: agent.mjs
skills:
  - id: summarize
    format: llm
    label: Summarize
    settings:
      prompt: Summarize.
definition:
  result:
    summary: Script result.
`);
      const module = scriptAgentTemplateToModule(manifest, agentDir, { sandboxRunner: runner, tempRoot, nodePath: process.execPath });
      const ctx = fakeRunContext();
      ctx.llm.complete = async () => { throw failure; };
      const error = await module.run(ctx).then(() => undefined, (thrown: unknown) => thrown);
      assert.ok(error instanceof Error);
      assert.match(error.message, /^MXC script agent "script-auditor" failed: /);
      assert.equal(reasoningWithoutAnswerInChain(error), exitOnModel);
    }
  });

  it("keeps the cause the script exited with when its output carries a model failure and a Graph denial", async () => {
    const reasoning = Object.assign(
      new Error('Ollama returned only reasoning from "gpt-oss:20b" and no answer. Retry, or pick a model that answers without reasoning.'),
      { name: "OllamaReasoningWithoutAnswerError" },
    );
    const denial = new GraphAccessDeniedError({ method: "GET", path: "/deviceManagement/managedDevices", requiredScopes: ["DeviceManagementManagedDevices.Read.All"], grantedScopes: [] });
    for (const exitOn of ["model", "graph"] as const) {
      const tempRoot = await mkdtemp(path.join(tmpdir(), "openadminos-script-both-"));
      const agentDir = path.join(tempRoot, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(path.join(agentDir, "agent.mjs"), "process.exit(1);\n");
      const runner: SandboxRunner = {
        id: "mxc",
        probe: async () => ({ backend: "mxc", status: "available", experimentalEnabled: true, supported: true, detail: "test" }),
        run: async (input) => {
          const dir = input.env!.OPENADMINOS_BROKER_DIR!;
          const llm = await requestViaBrokerDir(dir, { id: "llm-1", method: "llm.complete", params: { prompt: "Summarize." } } satisfies SandboxBrokerRequest);
          const graph = await requestViaBrokerDir(dir, { id: "graph-1", method: "graph.request", params: { method: "GET", path: "/deviceManagement/managedDevices", query: { $select: "id,deviceName" } } } satisfies SandboxBrokerRequest);
          assert.equal(llm.ok, false);
          assert.equal(graph.ok, false);
          const model = `llm.complete: ${llm.error?.message}`;
          const read = `graph.request: ${graph.error?.message}`;
          // The cleanup read's denial is logged, then the script rethrows its error, or the other way round.
          const stderr = exitOn === "model" ? `Warning: ${read}\n${uncaught(input, `Error: ${model}`)}` : `Warning: ${model}\n${uncaught(input, `Error: ${read}`)}`;
          return { exitCode: 1, signal: null, stdout: "", stderr };
        },
      };
      const manifest = parseAgentTemplate(`
descriptor:
  id: script-auditor
  name: Script Auditor
  description: Test script auditor.
  version: 0.1.0
  author:
    name: OpenAdminOS
  category: devices
  mode: read
execution:
  kind: script
  sandbox: mxc
  entrypoint: agent.mjs
skills:
  - id: load_devices
    format: graph
    label: Load devices
    settings:
      method: GET
      path: /deviceManagement/managedDevices
      select:
        - id
        - deviceName
      scopes:
        - DeviceManagementManagedDevices.Read.All
definition:
  result:
    summary: Script result.
`);
      const module = scriptAgentTemplateToModule(manifest, agentDir, { sandboxRunner: runner, tempRoot, nodePath: process.execPath });
      const ctx = fakeRunContext();
      ctx.llm.complete = async () => { throw reasoning; };
      ctx.graph.request = async () => { throw denial; };
      const error = await module.run(ctx).then(() => undefined, (thrown: unknown) => thrown);
      assert.ok(error instanceof Error);
      assert.equal(reasoningWithoutAnswerInChain(error), exitOn === "model", exitOn);
      assert.equal(graphAccessDenialFromError(error)?.cause, exitOn === "graph" ? "missing-consent" : undefined, exitOn);
    }
  });

  it("reads the error a real script process ended with from its own exit record", async () => {
    const reasoning = Object.assign(
      new Error('Ollama returned only reasoning from "gpt-oss:20b" and no answer. Retry, or pick a model that answers without reasoning.'),
      { name: "OllamaReasoningWithoutAnswerError" },
    );
    const carried = JSON.stringify(`llm.complete: ${reasoning.message}`);
    const caretNote = JSON.stringify("config.json:3\n  \"model\": gpt-oss\n           ^\n");
    const cases: Array<{ agent: string; cause: boolean }> = [
      // Throws the brokered failure.
      { agent: `throw new Error(${carried});`, cause: true },
      // A rejected promise carrying it.
      { agent: `await Promise.reject(new Error(${carried}));`, cause: true },
      // Its message also holds a diagnostic with a caret; the error carries the request id, as the bundled scripts set it.
      { agent: `throw Object.assign(new Error(${caretNote} + "\\n" + ${carried}), { brokerRequestId: "llm-1" });`, cause: true },
      // Wrapped: the failure with its request id is the cause of the error the script throws.
      { agent: `throw new Error("summary step failed", { cause: Object.assign(new Error(${carried}), { brokerRequestId: "llm-1" }) });`, cause: true },
      // An error of the script's own that only quotes the failure.
      { agent: `throw new Error("ENOSPC: could not write the fallback report after " + ${carried});`, cause: false },
      // Handled by a capture callback, then a later explicit exit.
      { agent: `process.setUncaughtExceptionCaptureCallback((error) => console.error(error.message)); setTimeout(() => process.exit(1), 20); throw new Error(${carried});`, cause: false },
      // Prints a diagnostic with a caret, logs the failure it caught, and exits.
      { agent: `console.error(${caretNote}); console.error(new Error(${carried})); process.exit(1);`, cause: false },
      // Handles the failure with its own listener, carries on, and exits later.
      { agent: `process.on("uncaughtException", (error) => console.error(error.message)); setTimeout(() => process.exit(1), 20); throw new Error(${carried});`, cause: false },
      // Logs the failure, then ends on an error of its own.
      { agent: `console.error(new Error(${carried})); throw new Error("ENOSPC: no space left on device, write");`, cause: false },
    ];
    for (const testCase of cases) {
      const tempRoot = await mkdtemp(path.join(tmpdir(), "openadminos-script-exit-"));
      const agentDir = path.join(tempRoot, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(path.join(agentDir, "agent.mjs"), `${testCase.agent}\n`);
      const runner: SandboxRunner = {
        id: "mxc",
        probe: async () => ({ backend: "mxc", status: "available", experimentalEnabled: true, supported: true, detail: "test" }),
        run: async (input) => {
          const llm = await requestViaBrokerDir(input.env!.OPENADMINOS_BROKER_DIR!, { id: "llm-1", method: "llm.complete", params: { prompt: "Summarize." } } satisfies SandboxBrokerRequest);
          assert.equal(llm.ok, false);
          // The command line the app builds, run by a real Node process.
          return await new Promise((resolve) => {
            exec(input.commandLine, { cwd: input.cwd, env: input.env }, (error, stdout, stderr) => {
              resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, signal: null, stdout, stderr });
            });
          });
        },
      };
      const manifest = parseAgentTemplate(`
descriptor:
  id: script-auditor
  name: Script Auditor
  description: Test script auditor.
  version: 0.1.0
  author:
    name: OpenAdminOS
  category: devices
  mode: read
execution:
  kind: script
  sandbox: mxc
  entrypoint: agent.mjs
skills:
  - id: summarize
    format: llm
    label: Summarize
    settings:
      prompt: Summarize.
definition:
  result:
    summary: Script result.
`);
      const module = scriptAgentTemplateToModule(manifest, agentDir, { sandboxRunner: runner, tempRoot, nodePath: process.execPath });
      const ctx = fakeRunContext();
      ctx.llm.complete = async () => { throw reasoning; };
      const error = await module.run(ctx).then(() => undefined, (thrown: unknown) => thrown);
      assert.ok(error instanceof Error, testCase.agent);
      assert.equal(reasoningWithoutAnswerInChain(error), testCase.cause, testCase.agent);
    }
  });

  it("refuses direct template-module conversion for script agents", () => {
    const manifest = parseAgentTemplate(`
descriptor:
  id: script-auditor
  name: Script Auditor
  description: Test script auditor.
  version: 0.1.0
  author:
    name: OpenAdminOS
  category: devices
  mode: read
execution:
  kind: script
  sandbox: mxc
  entrypoint: agent.mjs
skills:
  - id: load_devices
    format: graph
    label: Load devices
    settings:
      method: GET
      path: /deviceManagement/managedDevices
      scopes:
        - DeviceManagementManagedDevices.Read.All
  - id: summarize
    format: llm
    label: Summarize
    settings:
      prompt: Summarize.
definition:
  result:
    summary: Script result.
`);

    assert.throws(
      () => agentTemplateToModule(manifest),
      /must be loaded through loadAgentModule/,
    );
  });
});

function fakeRunContext(): RunContext {
  return {
    agent: {
      id: "script-auditor",
      slug: "script-auditor",
      name: "Script Auditor",
      description: "Test script auditor.",
      mode: "read",
      category: "devices",
      tier: "agent",
      requiresEntraTier: "free",
      scopes: ["DeviceManagementManagedDevices.Read.All"],
      author: { name: "OpenAdminOS" },
      version: "0.1.0",
    },
    providerId: "ollama",
    graph: {
      listManagedDevices: async () => [],
      retireManagedDevice: async () => undefined,
      request: async () => ({
        value: [{ id: "device-1", deviceName: "LAPTOP-01" }],
      }),
    },
    llm: {
      available: true,
      defaultModel: "test-model",
      complete: async () => ({
        text: "LLM summary.",
        model: "test-model",
      }),
      stream: async function* () {
        yield {
          delta: "LLM summary.",
          accumulated: "LLM summary.",
          done: true,
          model: "test-model",
        };
      },
    },
    realWrites: false,
    log: () => undefined,
    step: async (_label, _detail, fn) => await fn(),
  };
}

async function requestViaBrokerDir(
  brokerDir: string,
  request: SandboxBrokerRequest,
): Promise<SandboxBrokerResponse> {
  const requestPath = path.join(brokerDir, `${request.id}.request.json`);
  const responsePath = path.join(brokerDir, `${request.id}.response.json`);
  const tempPath = `${requestPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(request), "utf8");
  await rename(tempPath, requestPath);

  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const response = JSON.parse(await readFile(responsePath, "utf8"));
      await unlink(responsePath).catch(() => undefined);
      await unlink(requestPath).catch(() => undefined);
      return response as SandboxBrokerResponse;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await delay(10);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Timed out waiting for broker response ${request.id}.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
