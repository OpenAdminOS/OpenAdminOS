import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunLlmApi } from "@openadminos/agent-sdk";
import { ApplicationTokenError, AuditLogStore, LlmTimeoutError, type ApplicationTokenProvider, type ApplicationTokenProviderOptions } from "@openadminos/runtime";

import { loadSandboxConfig } from "./config.js";
import { SandboxHost, type SandboxHostDeps } from "./host.js";
import { main } from "./main.js";
import { appClaims, bundledHash, fakeTokenProviders, ollamaFetch, tempDir, tokenFor, writeCertificate, writeConfig, writePrivate } from "./test-support.js";

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

describe("SandboxHost round two", () => {
  const discordConfig = (dir: string, delivery: Record<string, unknown>, agents: unknown[] = []) => {
    writePrivate(join(dir, "secrets.json"), JSON.stringify({ discord: { webhookUrl: "https://discord.com/api/webhooks/1234567/token_x" } }));
    return loadSandboxConfig(writeConfig(dir, {
      agents: [{ id: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 3600, delivery: { connector: "discord", ...delivery } }, ...agents],
    }));
  };
  const counting = () => {
    const sent: string[] = [];
    const deliveryFetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push(String((JSON.parse(String(init?.body)) as { content: string }).content));
      return Response.json({ id: "m" });
    }) as typeof fetch;
    return { sent, deliveryFetch };
  };
  const statusGraph = (status: number) => (async () => new Response(JSON.stringify({ error: { code: "x" } }), { status, headers: { "retry-after": "0" } })) as typeof fetch;

  for (const [status, reason] of [[401, "graph-unauthorized"], [403, "graph-forbidden"], [429, "graph-throttled"]] as const) {
    it(`names HTTP ${status} from Graph as ${reason}`, async () => {
      const { dir, cleanup } = tempDir();
      const config = loadSandboxConfig(writeConfig(dir));
      const host = new SandboxHost(config, deps({ graphFetch: statusGraph(status) }));
      try {
        host.open();
        const outcome = await host.runAgent(config.agents[0]!, "schedule");
        assert.equal(outcome.kind === "failed" && outcome.reason, reason);
      } finally {
        await host.close();
        cleanup();
      }
    });
  }

  it("names a model timeout by its code", async () => {
    const { dir, cleanup } = tempDir();
    const config = loadSandboxConfig(writeConfig(dir));
    const timingOut: RunLlmApi = {
      ...llm,
      async complete() {
        throw new LlmTimeoutError("anything at all");
      },
      async *stream() {
        throw new LlmTimeoutError("anything at all");
      },
    };
    const host = new SandboxHost(config, { ...deps({ graphFetch: graph().fetchImpl }), createLlm: () => timingOut });
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind === "failed" && outcome.reason, "model-timeout");
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("marks the run audit-failed when the delivery attempt cannot be recorded, and sends nothing", async () => {
    const { dir, cleanup } = tempDir();
    const config = discordConfig(dir, {});
    const { sent, deliveryFetch } = counting();
    const host = new SandboxHost(config, deps({ graphFetch: graph().fetchImpl, deliveryFetch }));
    try {
      host.open();
      const store = (host as unknown as { audit: AuditLogStore }).audit;
      const append = store.append.bind(store);
      store.append = (events) => {
        if (events.some((event) => event.type === "delivery.attempted")) throw new Error("disk full");
        return append(events);
      };
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind === "failed" && outcome.reason, "audit-failed");
      assert.equal(sent.length, 0);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("names an allowlist with a refused agent in it instead of asking to remove that agent's permission", async () => {
    const { dir, cleanup } = tempDir();
    const config = loadSandboxConfig(writeConfig(dir, {
      agents: [
        { id: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 3600 },
        { id: "user-license-overview", templateSha256: "0".repeat(64), intervalSeconds: 3600 },
      ],
    }));
    const host = new SandboxHost(config, deps({ graphFetch: graph().fetchImpl, roles: [READ, "User.Read.All"] }));
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind === "refused" && outcome.reason, "identity-allowlist-incomplete");
      assert.match(outcome.kind === "refused" ? outcome.message : "", /user-license-overview \(agent-hash-mismatch\)/);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("sends nothing for a run stopped by a shutdown", async () => {
    const { dir, cleanup } = tempDir();
    const config = discordConfig(dir, { failureNotice: true });
    const { sent, deliveryFetch } = counting();
    let closing: Promise<void> | undefined;
    let host: SandboxHost | undefined;
    const waiting: RunLlmApi = {
      ...llm,
      async *stream(options) {
        closing = host?.close();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("stopped");
      },
    };
    host = new SandboxHost(config, { ...deps({ graphFetch: graph().fetchImpl, deliveryFetch }), createLlm: () => waiting });
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind === "failed" && outcome.reason, "run-stopped");
      await closing;
      assert.equal(sent.length, 0);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("reads health.json only after taking the lock, so a refused second host leaves it alone", async () => {
    const { dir, cleanup } = tempDir();
    const config = loadSandboxConfig(writeConfig(dir));
    const holder = new SandboxHost(config, deps());
    try {
      holder.open();
      writePrivate(join(config.dataDir, "health.json"), "{not json");
      const second = new SandboxHost(config, deps());
      assert.throws(() => second.open(), (error: unknown) => (error as { reason?: string }).reason === "already-running");
      assert.equal(readdirSync(config.dataDir).includes("health.json"), true);
      assert.equal(readdirSync(config.dataDir).some((name) => name.startsWith("health.json.unreadable")), false);
    } finally {
      await holder.close();
      cleanup();
    }
  });

  it("sends a failure notice for a storage failure caught outside the preflight", async () => {
    const { dir, cleanup } = tempDir();
    const config = discordConfig(dir, { notifyOnSuccess: false, notifyOnFailure: false, failureNotice: true });
    const { sent, deliveryFetch } = counting();
    const host = new SandboxHost(config, deps({ graphFetch: graph().fetchImpl, deliveryFetch }));
    const runsDir = join(config.dataDir, "runs");
    try {
      host.open();
      mkdirSync(runsDir, { recursive: true });
      chmodSync(runsDir, 0o500);
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind === "refused" && outcome.reason, "storage-failed");
      assert.match(sent[0] ?? "", /Reason: storage-failed/);
    } finally {
      chmodSync(runsDir, 0o700);
      await host.close();
      cleanup();
    }
  });
});

describe("SandboxHost round three", () => {
  it("names the sign-in failure and the audit failure together", async () => {
    const { dir, cleanup } = tempDir();
    const config = loadSandboxConfig(writeConfig(dir));
    const failing = (options: ApplicationTokenProviderOptions): ApplicationTokenProvider => {
      const acquire = async (): Promise<never> => {
        const error = new ApplicationTokenError("AADSTS700027", "AADSTS700027: certificate not registered", "AADSTS700027");
        await options.onFailed?.(error);
        throw error;
      };
      const provider = (async () => acquire()) as unknown as ApplicationTokenProvider;
      provider.acquire = acquire;
      return provider;
    };
    const host = new SandboxHost(config, { ...deps(), createTokenProvider: failing });
    try {
      host.open();
      const store = (host as unknown as { audit: AuditLogStore }).audit;
      const append = store.append.bind(store);
      store.append = (events) => {
        if (events.some((event) => event.type === "sandbox.token.failed")) throw new Error("disk full");
        return append(events);
      };
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind === "refused" && outcome.reason, "signin-certificate-not-registered");
      assert.match(outcome.kind === "refused" ? outcome.message : "", /AADSTS700027.*audit log could not record this sign-in failure either: .*disk full/);
    } finally {
      await host.close();
      cleanup();
    }
  });

  it("puts the run id on token events during the run", async () => {
    const { dir, cleanup } = tempDir();
    const config = loadSandboxConfig(writeConfig(dir));
    // Every Graph request gets a new token, as after an expiry.
    const everyRequest = (options: ApplicationTokenProviderOptions): ApplicationTokenProvider => {
      const acquire = async () => {
        const token = tokenFor(appClaims([READ]));
        await options.onAcquired?.(token);
        return token;
      };
      const provider = (async () => {
        const token = await acquire();
        return { accessToken: token.accessToken, scopes: token.roles };
      }) as ApplicationTokenProvider;
      provider.acquire = acquire;
      return provider;
    };
    const host = new SandboxHost(config, { ...deps({ graphFetch: graph().fetchImpl }), createTokenProvider: everyRequest });
    let runId = "";
    try {
      host.open();
      const outcome = await host.runAgent(config.agents[0]!, "schedule");
      assert.equal(outcome.kind, "completed");
      runId = outcome.kind === "completed" ? outcome.run.id : "";
    } finally {
      await host.close();
    }
    const store = new AuditLogStore(join(config.dataDir, "openadminos.db"));
    try {
      const tokens = store.readVerified().events.filter((event) => event.type === "sandbox.token.acquired");
      assert.equal(tokens[0]?.runId, undefined, "the preflight token comes before the run");
      assert.ok(tokens.length > 1);
      assert.ok(tokens.slice(1).every((event) => event.runId === runId));
    } finally {
      store.close();
      cleanup();
    }
  });

  it("does not pass the setup check when the report was not delivered", async () => {
    const { dir, cleanup } = tempDir();
    try {
      writePrivate(join(dir, "secrets.json"), JSON.stringify({ discord: { webhookUrl: "https://discord.com/api/webhooks/1234567/token_x" } }));
      const path = writeConfig(dir, { agents: [{ id: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 3600, delivery: { connector: "discord" } }] });
      const lines: string[] = [];
      const deliveryFetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
      const exit = await main(["--config", path, "--once", "find-inactive-devices"], { log: (_level, message) => lines.push(message), deps: deps({ graphFetch: graph().fetchImpl, deliveryFetch }) });
      assert.equal(exit, 1);
      assert.equal(lines.includes("Setup check passed."), false);
    } finally {
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
