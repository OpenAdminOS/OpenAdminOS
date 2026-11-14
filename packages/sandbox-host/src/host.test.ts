import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunLlmApi } from "@openadminos/agent-sdk";
import { AuditLogStore } from "@openadminos/runtime";

import { loadSandboxConfig } from "./config.js";
import { SandboxHost, type SandboxHostDeps } from "./host.js";
import { main } from "./main.js";
import { appClaims, bundledHash, fakeTokenProviders, ollamaFetch, tempDir, writeCertificate, writeConfig, writePrivate } from "./test-support.js";

const READ = "DeviceManagementManagedDevices.Read.All";

const llm: RunLlmApi = {
  available: true,
  defaultModel: "llama3.1:8b",
  async complete() {
    return { text: "Two devices look inactive.", model: "llama3.1:8b" };
  },
  async *stream() {
    yield { delta: "Two devices look inactive.", accumulated: "Two devices look inactive.", done: true, model: "llama3.1:8b" };
  },
};

function graph(status = 200) {
  const requests: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    requests.push(String(input));
    if (status !== 200) return Response.json({ error: { code: "Forbidden", message: "denied" } }, { status });
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    return Response.json({
      value: [
        { id: "1", deviceName: "LAPTOP-ALICE", operatingSystem: "Windows", lastSyncDateTime: old, complianceState: "compliant", managedDeviceOwnerType: "company" },
        { id: "2", deviceName: "PC-BOB", operatingSystem: "Windows", lastSyncDateTime: new Date().toISOString(), complianceState: "compliant", managedDeviceOwnerType: "company" },
      ],
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function deps(overrides: Partial<SandboxHostDeps> & { roles?: string[]; counter?: { acquired: number } } = {}): SandboxHostDeps {
  const { roles = [READ], counter, ...rest } = overrides;
  return {
    log: () => undefined,
    modelFetch: ollamaFetch(),
    createLlm: () => llm,
    createTokenProvider: fakeTokenProviders(appClaims(roles), counter),
    graphRetryBackoffMs: 0,
    ...rest,
  };
}

function auditTypes(dataDir: string): string[] {
  const store = new AuditLogStore(join(dataDir, "openadminos.db"));
  try {
    return store.readVerified().events.map((event) => event.type);
  } finally {
    store.close();
  }
}

describe("SandboxHost", () => {
  it("runs a bundled read agent, stores the run with where it ran, and audits each request before it is sent", async () => {
    const { dir, cleanup } = tempDir();
    const g = graph();
    const counter = { acquired: 0 };
    const config = loadSandboxConfig(writeConfig(dir));
    const host = new SandboxHost(config, deps({ graphFetch: g.fetchImpl, counter }));
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind, "completed", outcome.kind === "completed" ? "" : outcome.message);
      if (outcome.kind !== "completed") return;
      assert.deepEqual(outcome.run.executedOn, { kind: "sandbox", sandboxId: "mini-pc", name: "Office mini PC", organizationId: "org-1", model: "llama3.1:8b", modelDigest: "sha256:abc" });
      assert.equal(outcome.run.tenantId, config.tenantId);
      assert.equal(outcome.run.initiator, "schedule");
      assert.ok(g.requests.length >= 1);
      await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(counter.acquired, 2, "a fresh token per run");
    } finally {
      await host.close();
    }
    const types = auditTypes(config.dataDir);
    const firstAttempt = types.indexOf("graph.request.attempted");
    assert.ok(firstAttempt > types.indexOf("sandbox.token.acquired"));
    assert.equal(types[firstAttempt + 1], "graph.request.result");
    assert.ok(types.includes("sandbox.run.finished"));
    cleanup();
  });

  it("refuses before any Graph read when the identity can change the tenant", async () => {
    const { dir, cleanup } = tempDir();
    const g = graph();
    const config = loadSandboxConfig(writeConfig(dir));
    const host = new SandboxHost(config, deps({ graphFetch: g.fetchImpl, roles: [READ, "DeviceManagementManagedDevices.ReadWrite.All"] }));
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind, "refused");
      assert.equal(outcome.kind === "refused" && outcome.reason, "identity-can-change-tenant");
      assert.equal(g.requests.length, 0);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("names the reason when Graph denies a read", async () => {
    const { dir, cleanup } = tempDir();
    const config = loadSandboxConfig(writeConfig(dir));
    const host = new SandboxHost(config, deps({ graphFetch: graph(403).fetchImpl }));
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind, "failed");
      assert.equal(outcome.kind === "failed" && outcome.reason, "graph-forbidden");
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("delivers the report once and records a failed delivery on the run", async () => {
    const { dir, cleanup } = tempDir();
    writePrivate(join(dir, "secrets.json"), JSON.stringify({ discord: { webhookUrl: "https://discord.com/api/webhooks/1234567/token_x" } }));
    const config = loadSandboxConfig(writeConfig(dir, {
      agents: [{ id: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 3600, delivery: { connector: "discord" } }],
    }));
    let sends = 0;
    const deliveryFetch = (async () => {
      sends += 1;
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const host = new SandboxHost(config, deps({ graphFetch: graph().fetchImpl, deliveryFetch }));
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind, "completed");
      if (outcome.kind !== "completed") return;
      assert.equal(sends, 1);
      const step = outcome.run.steps.find((candidate) => candidate.label === "Send report to Discord");
      assert.equal(step?.status, "failed");
    } finally {
      await host.close();
    }
    const types = auditTypes(config.dataDir);
    assert.ok(types.indexOf("delivery.attempted") < types.indexOf("delivery.result"));
    cleanup();
  });
});

describe("SandboxHost platform and notices", () => {
  it("refuses to start on Windows", () => {
    const { dir, cleanup } = tempDir();
    try {
      const config = loadSandboxConfig(writeConfig(dir));
      assert.throws(() => new SandboxHost(config, { ...deps(), platform: "win32" }), (error: unknown) => (error as { reason?: string }).reason === "platform-not-supported");
    } finally {
      cleanup();
    }
  });

  it("sends a failure notice only when the reason changes, and once on recovery", async () => {
    const { dir, cleanup } = tempDir();
    writePrivate(join(dir, "secrets.json"), JSON.stringify({ discord: { webhookUrl: "https://discord.com/api/webhooks/1234567/token_x" } }));
    const config = loadSandboxConfig(writeConfig(dir, {
      agents: [{ id: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 3600, delivery: { connector: "discord", notifyOnSuccess: false, notifyOnFailure: false, failureNotice: true } }],
    }));
    const sent: string[] = [];
    const deliveryFetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push(String((JSON.parse(String(init?.body)) as { content: string }).content));
      return Response.json({ id: "m" });
    }) as typeof fetch;
    const agent = config.agents[0]!;
    const run = async (roles: string[]) => {
      const host = new SandboxHost(config, deps({ graphFetch: graph().fetchImpl, deliveryFetch, roles }));
      host.open();
      try {
        return await host.runAgent(agent, "schedule");
      } finally {
        await host.close();
      }
    };
    try {
      assert.equal((await run([])).kind, "refused");
      assert.equal((await run([])).kind, "refused");
      assert.equal(sent.length, 1, "same reason twice, one notice");
      assert.match(sent[0] ?? "", /Reason: identity-has-no-roles/);
      await run([READ, "Mail.Send"]);
      assert.equal(sent.length, 2, "a new reason, a new notice");
      assert.equal((await run([READ])).kind, "completed");
      assert.equal(sent.length, 3);
      assert.match(sent[2] ?? "", /runs complete again/);
      await run([READ]);
      assert.equal(sent.length, 3, "no notice while healthy");
    } finally {
      cleanup();
    }
  });
});

describe("SandboxHost failures before the secrets and after the run", () => {
  function noticeSetup(dir: string, extra: Record<string, unknown> = {}) {
    writePrivate(join(dir, "secrets.json"), JSON.stringify({ discord: { webhookUrl: "https://discord.com/api/webhooks/1234567/token_x" } }));
    return loadSandboxConfig(writeConfig(dir, {
      agents: [{ id: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 3600, delivery: { connector: "discord", notifyOnSuccess: false, notifyOnFailure: false, failureNotice: true } }],
      ...extra,
    }));
  }
  function capture() {
    const sent: string[] = [];
    const deliveryFetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push(String((JSON.parse(String(init?.body)) as { content: string }).content));
      return Response.json({ id: "m" });
    }) as typeof fetch;
    return { sent, deliveryFetch };
  }

  it("sends a notice when the model is unreachable, before the secrets were loaded", async () => {
    const { dir, cleanup } = tempDir();
    const config = noticeSetup(dir);
    const { sent, deliveryFetch } = capture();
    const modelFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const host = new SandboxHost(config, { ...deps({ deliveryFetch }), modelFetch });
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind === "refused" && outcome.reason, "model-unreachable");
      assert.equal(sent.length, 1);
      assert.match(sent[0] ?? "", /Reason: model-unreachable/);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("sends a notice when the certificate expired", async () => {
    const { dir, cleanup } = tempDir();
    const now = Date.now();
    const config = noticeSetup(dir, { certificates: [writeCertificate(dir, "old", new Date(now - 30 * 86_400_000), new Date(now - 86_400_000))] });
    const { sent, deliveryFetch } = capture();
    const host = new SandboxHost(config, deps({ deliveryFetch }));
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind === "refused" && outcome.reason, "certificate-expired");
      assert.match(sent[0] ?? "", /Reason: certificate-expired/);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("does not count a run whose completion the audit log could not record, and sends nothing for it", async () => {
    const { dir, cleanup } = tempDir();
    writePrivate(join(dir, "secrets.json"), JSON.stringify({ discord: { webhookUrl: "https://discord.com/api/webhooks/1234567/token_x" } }));
    const config = loadSandboxConfig(writeConfig(dir, {
      agents: [{ id: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 3600, delivery: { connector: "discord" } }],
    }));
    const { sent, deliveryFetch } = capture();
    let host: SandboxHost | undefined;
    // The model step runs last; closing the audit log there leaves only the completion event to fail.
    const closingLlm: RunLlmApi = {
      ...llm,
      async *stream(options) {
        (host as unknown as { audit?: AuditLogStore }).audit?.close();
        yield* llm.stream(options);
      },
    };
    host = new SandboxHost(config, { ...deps({ graphFetch: graph().fetchImpl, deliveryFetch }), createLlm: () => closingLlm });
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind, "failed");
      assert.equal(outcome.kind === "failed" && outcome.reason, "audit-failed");
      assert.equal(outcome.kind === "failed" && outcome.run.status, "failed");
      assert.equal(sent.length, 0);
    } finally {
      await host.close().catch(() => undefined);
      cleanup();
    }
  });

  it("names a failure while building the run as run-failed with its cause", async () => {
    const { dir, cleanup } = tempDir();
    const config = loadSandboxConfig(writeConfig(dir));
    const host = new SandboxHost(config, { ...deps({ graphFetch: graph().fetchImpl }), createLlm: () => { throw new Error("no model client"); } });
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind === "failed" && outcome.reason, "run-failed");
      assert.match(outcome.kind === "failed" ? outcome.message : "", /no model client/);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("logs unreadable run files at open", () => {
    const { dir, cleanup } = tempDir();
    const config = loadSandboxConfig(writeConfig(dir));
    mkdirSync(join(config.dataDir, "runs", "find-inactive-devices"), { recursive: true });
    writePrivate(join(config.dataDir, "runs", "find-inactive-devices", "broken.json"), "{");
    const lines: string[] = [];
    const host = new SandboxHost(config, { ...deps(), log: (_level, message, fields) => lines.push(`${String(fields?.reason)} ${message}`) });
    try {
      host.open();
      assert.ok(lines.some((line) => line.startsWith("storage-corrupt") && line.includes("find-inactive-devices/broken.json")));
    } finally {
      void host.close();
      cleanup();
    }
  });
});

describe("SandboxHost storage failures", () => {
  it("names a data folder it cannot write instead of dropping the run", async () => {
    const { dir, cleanup } = tempDir();
    const config = loadSandboxConfig(writeConfig(dir));
    const lines: string[] = [];
    const host = new SandboxHost(config, { ...deps({ graphFetch: graph().fetchImpl }), log: (level, message, fields) => lines.push(`${level} ${String(fields?.reason)} ${message}`) });
    const runsDir = join(config.dataDir, "runs");
    try {
      host.open();
      mkdirSync(runsDir, { recursive: true });
      chmodSync(runsDir, 0o500);
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind, "refused");
      assert.equal(outcome.kind === "refused" && outcome.reason, "storage-failed");
      assert.ok(lines.some((line) => line.startsWith("error storage-failed")));
    } finally {
      chmodSync(runsDir, 0o700);
      await host.close();
      cleanup();
    }
  });
});

describe("main --once", () => {
  it("exits 0 when the setup check passes and 1 when it is refused", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = writeConfig(dir);
      const ok = await main(["--config", path, "--once", "find-inactive-devices"], { log: () => undefined, deps: deps({ graphFetch: graph().fetchImpl }) });
      assert.equal(ok, 0);
      const refused = await main(["--config", path, "--once", "find-inactive-devices"], { log: () => undefined, deps: deps({ graphFetch: graph().fetchImpl, roles: [] }) });
      assert.equal(refused, 1);
      assert.equal(await main(["--config", join(dir, "missing.json")], { log: () => undefined }), 2);
      assert.equal(await main(["--once", "x"], { log: () => undefined }), 2);
    } finally {
      cleanup();
    }
  });

  it("refuses to start while another host holds the data folder", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = writeConfig(dir);
      const config = loadSandboxConfig(path);
      const holder = new SandboxHost(config, deps());
      holder.open();
      try {
        assert.equal(await main(["--config", path, "--once", "find-inactive-devices"], { log: () => undefined, deps: deps() }), 3);
      } finally {
        await holder.close();
      }
    } finally {
      cleanup();
    }
  });

  it("runs the service until the stop signal and then releases everything", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = writeConfig(dir);
      let stop: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      const lines: string[] = [];
      const exit = main(["--config", path], { log: (level, message) => lines.push(`${level} ${message}`), deps: deps({ graphFetch: graph().fetchImpl }), waitForSignal: () => stopped });
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop();
      assert.equal(await exit, 0);
      assert.ok(lines.some((line) => line.includes("Sandbox host stopped.")));
    } finally {
      cleanup();
    }
  });
});
