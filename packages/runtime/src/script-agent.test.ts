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
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import type {
  RunContext,
  SandboxBrokerRequest,
  SandboxBrokerResponse,
} from "@openadminos/agent-sdk";

import {
  agentTemplateToModule,
  parseAgentTemplate,
} from "./agent-template.js";
import { scriptAgentTemplateToModule } from "./script-agent.js";
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
