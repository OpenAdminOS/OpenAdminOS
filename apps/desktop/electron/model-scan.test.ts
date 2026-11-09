import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { providerCatalog, type ModelScanProbe, type ProviderSummary } from "@openadminos/agent-sdk";

import {
  buildModelScanChecks,
  checkingProbe,
  runModelScan,
  runtimeLaunch,
  scanOutcome,
  startLocalRuntime,
  scanProbeFromProvider,
  type ModelScanCheck,
} from "./model-scan.js";
import { checkLmStudio, checkOllama } from "./provider-detail.js";
import { chmod, readFile } from "node:fs/promises";
import { scanProviderCheck, runScanCheck } from "./model-scan.js";
import { AppStateStore } from "./state.js";

const catalog = (id: string) => providerCatalog.find((provider) => provider.id === id)!;
const ollamaReady = (models: string[]): ProviderSummary => ({ ...catalog("ollama"), status: "connected", models, defaultModel: models[0] });
const claudeReady: ProviderSummary = { ...catalog("anthropic"), status: "connected", models: ["claude-sonnet-5-5"], cli: { state: "ready", version: "2.4.0" } };
const delayed = (ms: number, probe: ModelScanProbe): ModelScanCheck => ({
  providerId: probe.providerId,
  name: probe.name,
  where: probe.where,
  target: probe.target,
  run: () => new Promise((resolve) => setTimeout(() => resolve(probe), ms)),
});
const found = (providerId: "ollama" | "anthropic" | "openai", name: string): ModelScanProbe => ({
  ...checkingProbe({ providerId, name, where: providerId === "ollama" ? "local" : "hosted", target: "test" }),
  state: "found",
  summary: "Running",
});

describe("first-launch model scan", () => {
  it("runs every check in parallel and reports each as it resolves, after showing all as checking", async () => {
    const events: string[] = [];
    const started = Date.now();
    const probes = await runModelScan({
      checks: [delayed(300, found("ollama", "Ollama")), delayed(300, found("anthropic", "Claude Code")), delayed(300, found("openai", "Codex"))],
      onProbe: (probe) => events.push(`${probe.providerId}:${probe.state}`),
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 600, `three 300 ms checks took ${elapsed} ms, so they did not run in parallel`);
    assert.deepEqual(events.slice(0, 3), ["ollama:checking", "anthropic:checking", "openai:checking"]);
    assert.deepEqual(new Set(events.slice(3)), new Set(["ollama:found", "anthropic:found", "openai:found"]));
    assert.ok(probes.every((probe) => typeof probe.durationMs === "number"));
  });

  it("turns a check that does not answer in time into a designed could-not-check state, without holding up the others", async () => {
    const started = Date.now();
    const probes = await runModelScan({
      checks: [
        { providerId: "copilot", name: "GitHub Copilot CLI", where: "hosted", target: "copilot sign-in status", run: () => new Promise(() => undefined) },
        { providerId: "gemini", name: "Gemini CLI", where: "hosted", target: "gemini --version", run: async () => { throw new Error("Gemini CLI could not start."); } },
        delayed(10, found("ollama", "Ollama")),
      ],
      timeoutMs: 120,
    });
    assert.ok(Date.now() - started < 400);
    const copilot = probes.find((probe) => probe.providerId === "copilot")!;
    assert.equal(copilot.state, "could-not-check");
    assert.equal(copilot.summary, "Could not check");
    assert.match(copilot.facts[0]!, /did not answer within 0\.1 seconds\. Retry to check again\./);
    const gemini = probes.find((probe) => probe.providerId === "gemini")!;
    assert.equal(gemini.state, "could-not-check");
    assert.deepEqual(gemini.facts, ["Gemini CLI could not start."]);
    assert.equal(probes.find((probe) => probe.providerId === "ollama")!.state, "found");
  });

  describe("stays on this device", () => {
    const originalFetch = globalThis.fetch;
    const originalOllama = process.env.OPENAGENTS_OLLAMA_URL;
    const originalLmStudio = process.env.OPENADMINOS_LM_STUDIO_URL;
    afterEach(() => {
      globalThis.fetch = originalFetch;
      if (originalOllama === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
      else process.env.OPENAGENTS_OLLAMA_URL = originalOllama;
      if (originalLmStudio === undefined) delete process.env.OPENADMINOS_LM_STUDIO_URL;
      else process.env.OPENADMINOS_LM_STUDIO_URL = originalLmStudio;
    });

    it("calls only loopback endpoints for the local runtimes", async () => {
      const urls: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        urls.push(String(input instanceof Request ? input.url : input));
        throw new Error("connection refused");
      }) as typeof fetch;
      delete process.env.OPENAGENTS_OLLAMA_URL;
      const checks = buildModelScanChecks({
        catalog: providerCatalog.filter((provider) => provider.id === "ollama" || provider.id === "lm-studio"),
        check: (id) => (id === "ollama" ? checkOllama(catalog("ollama")) : checkLmStudio(catalog("lm-studio"))),
        onDisk: async () => false,
      });
      const probes = await runModelScan({ checks });
      assert.ok(urls.length > 0);
      for (const url of urls) assert.match(new URL(url).hostname, /^(127\.0\.0\.1|localhost|\[::1\])$/, url);
      assert.ok(probes.every((probe) => probe.state === "not-found"), JSON.stringify(probes));
    });

    it("does not contact an Ollama endpoint outside this device", async () => {
      let fetched = false;
      let checked = false;
      globalThis.fetch = (async () => {
        fetched = true;
        throw new Error("must not fetch");
      }) as typeof fetch;
      process.env.OPENAGENTS_OLLAMA_URL = "http://10.20.30.40:11434";
      const [probe] = await runModelScan({
        checks: buildModelScanChecks({
          catalog: [catalog("ollama")],
          check: async () => { checked = true; return catalog("ollama"); },
          env: { PATH: "" },
          platform: "linux",
        }),
      });
      assert.equal(fetched, false);
      assert.equal(checked, false);
      assert.equal(probe!.state, "could-not-check");
      assert.equal(probe!.summary, "Endpoint outside this device");
      assert.match(probe!.facts[0]!, /The scan only checks this device\./);
    });
  });

  describe("result lines", () => {
    it("names OpenAdmin 8B when it is pulled, and an installed runtime that is not running", () => {
      const running = scanProbeFromProvider(ollamaReady(["openadminos/openadmin-8b:latest", "qwen3:8b"]));
      assert.equal(running.state, "found");
      assert.equal(running.ready, true);
      assert.equal(running.summary, "Running, 2 models");
      assert.equal(running.hasOpenAdmin8B, true);
      assert.equal(running.facts[0], "OpenAdmin 8B is on this device.");

      const stopped = scanProbeFromProvider({ ...catalog("ollama"), status: "not-installed", models: [] }, { installedOnDisk: true });
      assert.equal(stopped.state, "found");
      assert.equal(stopped.ready, false);
      assert.equal(stopped.summary, "Installed, not running");
      assert.deepEqual(stopped.facts, ["Start it with `ollama serve`, then scan again."]);

      assert.equal(scanProbeFromProvider({ ...catalog("ollama"), status: "not-installed", models: [] }).state, "not-found");
    });

    it("reads hosted CLIs from their sign-in status", () => {
      assert.deepEqual(
        { ...scanProbeFromProvider(claudeReady), durationMs: undefined },
        { providerId: "anthropic", name: "Claude Code", where: "hosted", target: "claude auth status", models: ["claude-sonnet-5-5"], state: "found", ready: true, summary: "Signed in", facts: ["Version 2.4.0"], durationMs: undefined },
      );
      const signedOut = scanProbeFromProvider({ ...catalog("openai"), status: "error", detail: "Run `codex login`.", models: [], cli: { state: "signed-out" } });
      assert.equal(signedOut.summary, "Installed, not signed in");
      assert.equal(signedOut.ready, false);
      assert.equal(scanProbeFromProvider({ ...catalog("copilot"), status: "not-installed", models: [], cli: { state: "not-installed" } }).state, "not-found");
    });
  });

  describe("outcome", () => {
    it("selects a ready local model, preferring OpenAdmin 8B, for an admin who never chose a provider", () => {
      assert.deepEqual(
        scanOutcome([ollamaReady(["qwen3:8b", "openadminos/openadmin-8b:latest"]), claudeReady], { activeProviderId: "ollama", providerChosenByUser: false }),
        { kind: "local-ready", providerId: "ollama", model: "openadminos/openadmin-8b:latest" },
      );
      const lmStudio: ProviderSummary = { ...catalog("lm-studio"), status: "connected", models: ["local-model"], defaultModel: "local-model" };
      assert.deepEqual(
        scanOutcome([{ ...catalog("ollama"), status: "not-installed", models: [] }, lmStudio], { activeProviderId: "ollama", providerChosenByUser: false }),
        { kind: "local-selected", providerId: "lm-studio", model: "local-model" },
      );
    });

    it("never selects a hosted provider: it is only offered", () => {
      assert.deepEqual(
        scanOutcome([{ ...catalog("ollama"), status: "not-installed", models: [] }, claudeReady], { activeProviderId: "ollama", providerChosenByUser: false }),
        { kind: "hosted-detected", providerIds: ["anthropic"] },
      );
    });

    it("does not switch an admin's own choice, and reports nothing when nothing is ready", () => {
      const lmStudio: ProviderSummary = { ...catalog("lm-studio"), status: "connected", models: ["m"], defaultModel: "m" };
      assert.deepEqual(scanOutcome([lmStudio], { activeProviderId: "anthropic", providerChosenByUser: true }), { kind: "local-available", providerId: "lm-studio", model: "m", selectedProviderId: "anthropic" });
      // An Ollama with only embedding models is not ready.
      assert.deepEqual(scanOutcome([{ ...catalog("ollama"), status: "error", models: [] }], { activeProviderId: "ollama", providerChosenByUser: false }), { kind: "nothing" });
    });
  });

  describe("in the app store", () => {
    it("is pending on a fresh install only, applies the local selection, and is cleared once completed", async () => {
      const dir = await mkdtemp(join(tmpdir(), "openadminos-model-scan-"));
      const lmStudio: ProviderSummary = { ...catalog("lm-studio"), status: "connected", models: ["local-model"], defaultModel: "local-model" };
      const providers = providerCatalog.map((provider) => (provider.id === "lm-studio" ? lmStudio : { ...provider, status: "not-installed" as const, models: [] }));
      const store = new AppStateStore({
        filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "",
        tokenStore: { read: async () => "", write: async () => undefined },
        providerListFactory: () => providers,
      });
      try {
        assert.equal((await store.getAppState()).firstRunScanPending, true);
        const progress: string[] = [];
        const result = await store.scanModels((probe) => progress.push(`${probe.providerId}:${probe.state}`));
        // App state skips provider detection while the scan is pending, so the scan selects the ready local provider.
        assert.deepEqual(result.outcome, { kind: "local-selected", providerId: "lm-studio", model: "local-model" });
        assert.ok(progress.includes("lm-studio:found"));
        assert.ok(progress.includes("anthropic:not-found"));
        const after = await store.completeFirstRunScan();
        assert.equal(after.firstRunScanPending, undefined);
        assert.equal(after.activeProviderId, "lm-studio");
      } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
      }

      const existing = await mkdtemp(join(tmpdir(), "openadminos-model-scan-"));
      await writeFile(join(existing, "state.json"), JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [] }));
      const upgraded = new AppStateStore({
        filePath: join(existing, "state.json"), userDataPath: existing, statsApiUrl: "",
        tokenStore: { read: async () => "", write: async () => undefined },
        providerListFactory: () => providers,
      });
      try {
        assert.equal((await upgraded.getAppState()).firstRunScanPending, undefined);
      } finally {
        upgraded.close();
        await rm(existing, { recursive: true, force: true });
      }
    });
  });
});

describe("starting a local runtime from the scan", () => {
  const present = (paths: string[]) => async (path: string) => paths.includes(path);

  it("uses the Ollama app on macOS, ollama serve elsewhere, and lms server start for LM Studio", async () => {
    assert.deepEqual(await runtimeLaunch("ollama", { PATH: "" }, "darwin", present(["/Applications/Ollama.app"])), { command: "open", args: ["-a", "Ollama"], display: "open -a Ollama" });
    assert.deepEqual(await runtimeLaunch("ollama", { PATH: "/opt/bin" }, "linux", present(["/opt/bin/ollama"])), { command: "/opt/bin/ollama", args: ["serve"], display: "ollama serve" });
    assert.deepEqual(await runtimeLaunch("lm-studio", { PATH: "", HOME: "/home/a" }, "linux", present(["/home/a/.lmstudio/bin/lms"])), { command: "/home/a/.lmstudio/bin/lms", args: ["server", "start"], display: "lms server start" });
    assert.equal(await runtimeLaunch("lm-studio", { PATH: "", HOME: "/home/a" }, "linux", present([])), undefined);
  });

  it("waits for the loopback endpoint and reports success", async () => {
    let calls = 0;
    const spawned: string[] = [];
    const result = await startLocalRuntime({
      name: "Ollama", manualCommand: "ollama serve",
      launch: { command: "/opt/bin/ollama", args: ["serve"], display: "ollama serve" },
      spawn: async (launch) => { spawned.push(`${launch.command} ${launch.args.join(" ")}`); },
      isUp: async () => ++calls >= 3,
      intervalMs: 5,
    });
    assert.deepEqual(result, { started: true });
    assert.deepEqual(spawned, ["/opt/bin/ollama serve"]);
  });

  it("gives a designed failure that names the command to run by hand", async () => {
    const notFound = await startLocalRuntime({ name: "LM Studio", manualCommand: "lms server start", launch: undefined, spawn: async () => undefined, isUp: async () => true });
    assert.deepEqual(notFound, { started: false, message: "LM Studio was not found on this device. Start it yourself with `lms server start`, then scan again." });
    const failed = await startLocalRuntime({
      name: "Ollama", manualCommand: "ollama serve",
      launch: { command: "ollama", args: ["serve"], display: "ollama serve" },
      spawn: async () => { throw new Error("spawn EACCES"); },
      isUp: async () => true,
    });
    assert.equal(failed.started, false);
    assert.match((failed as { message: string }).message, /^Ollama did not start\. spawn EACCES\. Start it yourself with `ollama serve`, then scan again\.$/);
    const silent = await startLocalRuntime({
      name: "Ollama", manualCommand: "ollama serve",
      launch: { command: "ollama", args: ["serve"], display: "ollama serve" },
      spawn: async () => undefined,
      isUp: async () => false,
      timeoutMs: 100, intervalMs: 5,
    });
    assert.match((silent as { message: string }).message, /^Ollama did not answer within 0\.1 seconds\. Start it yourself with `ollama serve`, then scan again\.$/);
  });
});

describe("review round 1 on PR #175", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  async function fakeCli(dir: string, name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\necho "$*" >> "${join(dir, `${name}.log`)}"\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it("keeps a remembered hosted choice and only offers the local model (finding 1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-model-scan-"));
    await writeFile(join(dir, "state.json"), JSON.stringify({ activeProviderId: "anthropic", providerChosenByUser: true, installedAgents: [], runs: [], tenants: [] }));
    const providers = providerCatalog.map((provider) =>
      provider.id === "ollama" ? ollamaReady(["openadminos/openadmin-8b:latest"]) : provider.id === "anthropic" ? claudeReady : { ...provider, status: "not-installed" as const, models: [] });
    const store = new AppStateStore({ filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "", tokenStore: { read: async () => "", write: async () => undefined }, providerListFactory: () => providers });
    try {
      const result = await store.scanModels();
      assert.deepEqual(result.outcome, { kind: "local-available", providerId: "ollama", model: "openadminos/openadmin-8b:latest", selectedProviderId: "anthropic" });
      assert.equal((await store.getAppState()).activeProviderId, "anthropic");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs only each CLI's version and sign-in status, and never Copilot's model catalog (finding 2)", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-scan-cli-"));
    try {
      const binaries = {
        anthropic: await fakeCli(dir, "claude", 'echo "9.9.9 (Claude Code)"'),
        openai: await fakeCli(dir, "codex", 'echo "codex-cli 9.9.9"'),
        copilot: await fakeCli(dir, "copilot", 'echo "9.9.9"'),
        gemini: await fakeCli(dir, "gemini", 'echo "9.9.9"'),
      } as const;
      for (const [id, binaryPath] of Object.entries(binaries)) {
        await scanProviderCheck(catalog(id), { binaryPath });
      }
      const allowed: Record<string, string[]> = {
        claude: ["--version", "auth status --text"],
        codex: ["--version", "login status"],
        copilot: ["--version"],
        gemini: ["--version"],
      };
      for (const [name, args] of Object.entries(allowed)) {
        const calls = (await readFile(join(dir, `${name}.log`), "utf8")).trim().split("\n");
        for (const call of calls) assert.ok(args.includes(call), `${name} ran "${call}"`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads app state without provider detection while the first-run scan is pending (finding 3)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-model-scan-"));
    const original = process.env.OPENAGENTS_OLLAMA_URL;
    process.env.OPENAGENTS_OLLAMA_URL = "http://10.20.30.40:11434";
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => { urls.push(String(input)); throw new Error("must not fetch"); }) as typeof fetch;
    let listed = false;
    const store = new AppStateStore({
      filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
      // A provider check that never answers must not hold up the first screen.
      providerListFactory: () => { listed = true; return new Promise<ProviderSummary[]>(() => undefined); },
    });
    try {
      const started = Date.now();
      const state = await store.getAppState();
      assert.equal(state.firstRunScanPending, true);
      assert.ok(Date.now() - started < 2_000);
      assert.equal(listed, false);
      assert.deepEqual(urls.filter((url) => !/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)), []);
    } finally {
      if (original === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
      else process.env.OPENAGENTS_OLLAMA_URL = original;
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not contact an off-device Ollama even through the shared check (finding 3)", async () => {
    const original = process.env.OPENAGENTS_OLLAMA_URL;
    process.env.OPENAGENTS_OLLAMA_URL = "http://10.20.30.40:11434";
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; throw new Error("must not fetch"); }) as typeof fetch;
    try {
      const summary = await scanProviderCheck(catalog("ollama"));
      assert.equal(fetched, false);
      assert.equal(scanProbeFromProvider(summary).state, "could-not-check");
    } finally {
      if (original === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
      else process.env.OPENAGENTS_OLLAMA_URL = original;
    }
  });

  it("kills a CLI that does not answer when the check times out (finding 4)", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-scan-hang-"));
    try {
      const pidFile = join(dir, "pid");
      const claude = await fakeCli(dir, "claude", `echo $$ > "${pidFile}"\nexec sleep 30`);
      const probe = await runScanCheck(
        { providerId: "anthropic", name: "Claude Code", where: "hosted", target: "claude auth status", run: (signal) => scanProviderCheck(catalog("anthropic"), { signal, binaryPath: claude }).then((summary) => scanProbeFromProvider(summary)) },
        300,
      );
      assert.equal(probe.state, "could-not-check");
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.throws(() => process.kill(pid, 0), "the hanging CLI must be killed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not count LM Studio with no loaded model as ready (finding 5)", () => {
    const empty: ProviderSummary = { ...catalog("lm-studio"), status: "connected", models: [] };
    const line = scanProbeFromProvider(empty);
    assert.equal(line.ready, false);
    assert.equal(line.summary, "Running, no model loaded");
    assert.deepEqual(scanOutcome([empty], { activeProviderId: "ollama", providerChosenByUser: false }), { kind: "nothing" });
  });

  it("reports a failed check as could not check, not as a negative result (finding 7)", async () => {
    delete process.env.OPENAGENTS_OLLAMA_URL;
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    const http = scanProbeFromProvider(await scanProviderCheck(catalog("ollama")));
    assert.equal(http.state, "could-not-check");
    const cli = scanProbeFromProvider({ ...catalog("anthropic"), status: "error", detail: "Claude Code could not be checked.", models: [], cli: { state: "request-failed" } });
    assert.equal(cli.state, "could-not-check");
    assert.deepEqual(cli.facts, ["Claude Code could not be checked."]);
    const signedOut = scanProbeFromProvider({ ...catalog("anthropic"), status: "error", models: [], cli: { state: "signed-out" } });
    assert.equal(signedOut.state, "found");
    assert.equal(signedOut.summary, "Installed, not signed in");
  });
});

describe("one scan at a time (review round 1, finding L)", () => {
  it("shares a scan that is already running instead of starting a second set of checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-model-scan-"));
    let listed = 0;
    const store = new AppStateStore({
      filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
      providerListFactory: async () => {
        listed += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return providerCatalog.map((provider) => ({ ...provider, status: "not-installed" as const, models: [] }));
      },
    });
    try {
      const [first, second] = await Promise.all([store.scanModels(), store.scanModels()]);
      assert.equal(first, second);
      const checks = first.probes.length;
      assert.equal(listed, checks, "each check ran once");
      await store.scanModels();
      assert.equal(listed, checks * 2, "a later scan runs again");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("startup while the first-run scan is pending (review round 2, items 2 and A)", () => {
  it("runs no provider detection outside the scan: app state, Office, listing, model choice, tests and the Chat preview", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-model-scan-"));
    let listed = 0;
    const store = new AppStateStore({
      filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
      providerListFactory: () => { listed += 1; return providerCatalog.map((provider) => ({ ...provider, status: "connected" as const, models: ["m"] })); },
    });
    try {
      const state = await store.getAppState();
      assert.equal(state.firstRunScanPending, true);
      // Never-checked providers are "not checked", never available (item C).
      assert.ok(state.providers.every((provider) => provider.status === "not-checked"));
      await store.tickOffice().catch(() => undefined);
      const providers = await store.listProviders();
      assert.ok(providers.every((provider) => provider.status === "not-checked"));
      await store.testProvider("ollama").catch(() => undefined);
      await store.setActiveModel("ollama", null).catch(() => undefined);
      await store.previewIntuneChatSend({ content: "Explain Windows Autopatch rings" }).catch(() => undefined);
      assert.equal(listed, 0, "no caller ran provider detection while the scan is pending");

      // The scan itself checks, and listing then serves its results.
      await store.scanModels();
      const afterScan = listed;
      assert.ok(afterScan > 0);
      assert.ok((await store.listProviders()).every((provider) => provider.status === "connected"));
      assert.equal(listed, afterScan);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
