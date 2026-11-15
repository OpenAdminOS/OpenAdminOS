// An in-process sandbox host on loopback for tests of the other side of
// pairing, such as the desktop's. It runs with fake Microsoft sign-in, a
// fake Graph that answers every read empty and a fake local model, so no
// request leaves the process. Not for production use.

import type { RunLlmApi, RunRecord } from "@openadminos/agent-sdk";
import { runRecordDigest, signAuditCheckpoint, type AuditCheckpoint, type SignedAuditCheckpoint } from "@openadminos/pairing";
import { appendSandboxEvent } from "@openadminos/runtime";

import { loadSandboxConfig, type SandboxConfig } from "./config.js";
import { SandboxHost, type RunOutcome } from "./host.js";
import type { RunStore } from "./store.js";
import type { SchedulerClock } from "./scheduler.js";
import { appClaims, bundledHash, fakeTokenProviders, ollamaFetch, tempDir, TENANT, writeConfig } from "./test-support.js";

export { bundledHash, TENANT as TEST_SANDBOX_TENANT };

const READ = "DeviceManagementManagedDevices.Read.All";

const llm: RunLlmApi = {
  available: true,
  defaultModel: "llama3.1:8b",
  async complete() {
    return { text: "Nothing stands out.", model: "llama3.1:8b" };
  },
  async *stream() {
    yield { delta: "Nothing stands out.", accumulated: "Nothing stands out.", done: true, model: "llama3.1:8b" };
  },
};

/** Schedules never fire on their own; tests run agents with `runAgent`. */
const idleClock: SchedulerClock = { now: () => Date.now(), setTimer: () => 0, clearTimer: () => undefined };

export interface TestSandboxOptions {
  /** A data folder to reuse across restarts; a temporary one otherwise. */
  dir?: string;
  sandboxId?: string;
  organizationId?: string;
  tenantId?: string;
  /** Roles the fake app-only token carries. */
  roles?: string[];
}

export interface TestSandbox {
  readonly host: SandboxHost;
  readonly config: SandboxConfig;
  /** `127.0.0.1:<port>`. */
  readonly address: string;
  readonly port: number;
  /** The newest pairing code the host logged. */
  code(): string;
  /** Runs a config agent once, as its schedule would. */
  runAgent(agentId?: string): Promise<RunOutcome>;
  /**
   * Changes a finished run the way the host does after a delivery: records
   * `sandbox.run.rewritten` with the new digest, then writes the record.
   */
  rewriteRun(runId: string, change: (run: RunRecord) => RunRecord): RunRecord;
  /** Signs a checkpoint with the sandbox's device key, so tests can stand in for a sandbox that lies. */
  signCheckpoint(checkpoint: AuditCheckpoint): SignedAuditCheckpoint;
  close(): Promise<void>;
}

export async function startTestSandbox(options: TestSandboxOptions = {}): Promise<TestSandbox> {
  const temp = options.dir ? { dir: options.dir, cleanup: () => undefined } : tempDir();
  const codes: string[] = [];
  const configPath = writeConfig(temp.dir, {
    pairing: { listen: "127.0.0.1:0" },
    sandbox: { id: options.sandboxId ?? "mini-pc", name: "Office mini PC" },
    organizationId: options.organizationId ?? "org-1",
    tenantId: options.tenantId ?? TENANT,
  });
  const config = loadSandboxConfig(configPath);
  const host = new SandboxHost(config, {
    log: (_level, _message, fields) => {
      if (typeof fields?.code === "string") codes.push(fields.code);
    },
    modelFetch: ollamaFetch(),
    createLlm: () => llm,
    createTokenProvider: fakeTokenProviders(appClaims(options.roles ?? [READ])),
    graphFetch: (async () => Response.json({ value: [] })) as typeof fetch,
    graphRetryBackoffMs: 0,
    schedulerClock: idleClock,
  });
  host.open();
  let bound;
  try {
    bound = await host.startApi();
    if (!bound) throw new Error("The test sandbox has no pairing section.");
  } catch (error) {
    await host.close();
    temp.cleanup();
    throw error;
  }
  host.startSchedule();
  const port = bound.port;
  return {
    host,
    config,
    address: `127.0.0.1:${port}`,
    port,
    code() {
      const code = codes[codes.length - 1];
      if (!code) throw new Error("The test sandbox logged no pairing code.");
      return code;
    },
    runAgent(agentId) {
      const agent = config.agents.find((entry) => entry.id === (agentId ?? config.agents[0]?.id));
      if (!agent) throw new Error(`The test sandbox config has no agent ${agentId ?? ""}.`);
      return host.runAgent(agent, "schedule");
    },
    rewriteRun(runId, change) {
      const current = host.runsAfter(0, 1000).runs.find((entry) => entry.run.id === runId)?.run;
      if (!current) throw new Error(`The test sandbox has no run ${runId}.`);
      const next = change(current);
      appendSandboxEvent(
        host.auditLog(),
        { tenantId: config.tenantId, organizationId: config.organizationId, sandboxId: config.sandbox.id, runId, agentSlug: next.agentSlug, initiator: "schedule" },
        "sandbox.run.rewritten",
        { status: next.status, runDigest: runRecordDigest(next) },
      );
      // The host's own store, so its cursor index sees the write.
      (host as unknown as { runs: RunStore }).runs.write(next);
      return next;
    },
    signCheckpoint(checkpoint) {
      return signAuditCheckpoint(checkpoint, host.identity.privateKey);
    },
    async close() {
      await host.close();
      temp.cleanup();
    },
  };
}
