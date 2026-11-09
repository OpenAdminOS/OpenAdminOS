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
  lmStudioAppInstalled,
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
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
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
        { providerId: "anthropic", name: "Claude Code", where: "hosted", target: "claude --version, claude auth status", models: ["claude-sonnet-5-5"], state: "found", ready: true, summary: "Signed in", facts: ["Version 2.4.0"], durationMs: undefined },
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

  it("finds a Windows .exe before a .cmd launcher, and names a missing lms when only the app is installed (Muse round 2, O)", async () => {
    // The PATH entry has no drive colon, so the host's delimiter splits it the same on every platform.
    const win = { PATH: "winbin", LOCALAPPDATA: "Local", USERPROFILE: "Users" };
    const exe = join("winbin", "ollama.exe");
    const cmd = join("winbin", "ollama.cmd");
    assert.equal((await runtimeLaunch("ollama", win, "win32", present([cmd, exe])))?.command, exe);
    assert.equal((await runtimeLaunch("ollama", win, "win32", present([cmd])))?.command, cmd);
    const app = join("Local", "Programs", "LM Studio", "LM Studio.exe");
    assert.equal(await lmStudioAppInstalled(win, "win32", present([app])), true);
    assert.equal(await lmStudioAppInstalled({ HOME: "/home/a" }, "linux", present([])), false);
    const missing = await startLocalRuntime({ name: "LM Studio", manualCommand: "lms server start", launch: undefined, appWithoutCommand: true, spawn: async () => undefined, isUp: async () => true });
    assert.deepEqual(missing, { started: false, message: "LM Studio is installed, but its `lms` command was not found. Start the server in LM Studio, then scan again." });
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
        1500,
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
    // Every check reads the injected list, and the local endpoints are pinned
    // to loopback, so neither the host's CLIs nor its environment decide
    // what the scan checks.
    const original = { ollama: process.env.OPENAGENTS_OLLAMA_URL, host: process.env.OLLAMA_HOST, lm: process.env.OPENADMINOS_LM_STUDIO_URL };
    process.env.OPENAGENTS_OLLAMA_URL = "http://127.0.0.1:11434";
    delete process.env.OLLAMA_HOST;
    process.env.OPENADMINOS_LM_STUDIO_URL = "http://127.0.0.1:1234/v1";
    // A Gemini CLI spy first on PATH: any spawn writes its arguments.
    const originalPath = process.env.PATH;
    let geminiLog: string | undefined;
    if (process.platform !== "win32") {
      geminiLog = join(dir, "gemini.log");
      await writeFile(join(dir, "gemini"), `#!/bin/sh\necho "$*" >> "${geminiLog}"\necho 9.9.9\n`);
      await chmod(join(dir, "gemini"), 0o755);
      process.env.PATH = `${dir}:${originalPath ?? ""}`;
    }
    let llmBuilt = 0;
    const store = new AppStateStore({
      filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
      providerListFactory: () => { listed += 1; return providerCatalog.map((provider) => ({ ...provider, status: "connected" as const, models: ["m"] })); },
      llmFactory: () => {
        llmBuilt += 1;
        return { available: true, defaultModel: "m", async complete() { return { text: "ok", model: "m" }; }, async *stream() { yield { delta: "", accumulated: "", done: true, model: "m" }; } };
      },
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
      // Gemini is "not checked" here: no test prompt and no CLI spawn while the scan is pending (Muse round 3, M1).
      const gemini = await store.testProvider("gemini");
      assert.equal(gemini.ok, false);
      assert.match(gemini.message ?? "", /first-launch scan is still checking/);
      assert.equal(llmBuilt, 0, "no model was built for a test prompt");
      if (geminiLog) await assert.rejects(() => readFile(geminiLog, "utf8"), "the Gemini CLI was never started");
      await store.setActiveModel("ollama", null).catch(() => undefined);
      await store.previewIntuneChatSend({ content: "Explain Windows Autopatch rings" }).catch(() => undefined);
      assert.equal(listed, 0, "no caller ran provider detection while the scan is pending");

      // The scan itself checks, and listing then serves its results: what
      // the scan checked as it found it, the rest (Apple Intelligence off
      // macOS) still not checked. Listing runs no detection of its own.
      const result = await store.scanModels();
      const afterScan = listed;
      assert.ok(afterScan > 0);
      const checked = new Set(result.probes.map((probe) => probe.providerId));
      assert.deepEqual(
        [...checked].sort(),
        providerCatalog.map((provider) => provider.id).filter((id) => id !== "apple-foundation" || process.platform === "darwin").sort(),
      );
      for (const provider of await store.listProviders()) {
        assert.equal(provider.status, checked.has(provider.id) ? "connected" : "not-checked", provider.id);
      }
      assert.equal(listed, afterScan);
    } finally {
      for (const [key, value] of [["OPENAGENTS_OLLAMA_URL", original.ollama], ["OLLAMA_HOST", original.host], ["OPENADMINOS_LM_STUDIO_URL", original.lm], ["PATH", originalPath]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("tests a provider only from a real ready status (Muse round 3, M1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-model-scan-"));
    await writeFile(join(dir, "state.json"), JSON.stringify({ installedAgents: [], runs: [], tenants: [] }));
    let built = 0;
    const statuses: Record<string, ProviderSummary["status"]> = {};
    const originalPath = process.env.PATH;
    let geminiLog: string | undefined;
    if (process.platform !== "win32") {
      geminiLog = join(dir, "gemini.log");
      await writeFile(join(dir, "gemini"), `#!/bin/sh\necho "$*" >> "${geminiLog}"\necho 9.9.9\n`);
      await chmod(join(dir, "gemini"), 0o755);
      process.env.PATH = `${dir}:${originalPath ?? ""}`;
    }
    const store = new AppStateStore({
      filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
      providerListFactory: () => providerCatalog.map((provider) => ({
        ...provider, status: statuses[provider.id] ?? "connected", models: statuses[provider.id] === "not-installed" ? [] : ["m"],
      })),
      llmFactory: () => {
        built += 1;
        return { available: true, defaultModel: "m", async complete() { return { text: "ok", model: "m" }; }, async *stream() { yield { delta: "", accumulated: "", done: true, model: "m" }; } };
      },
    });
    try {
      for (const status of ["not-checked", "not-installed", "error"] as const) {
        statuses.ollama = status;
        assert.equal((await store.testProvider("ollama")).ok, false, status);
      }
      statuses.gemini = "not-checked";
      assert.equal((await store.testProvider("gemini")).ok, false, "a Gemini that was not checked is not tested");
      assert.equal(built, 0);
      if (geminiLog) await assert.rejects(() => readFile(geminiLog, "utf8"), "the Gemini CLI was never started");
      // An installed Gemini, also after a failed request, is tested: that is how its sign-in is confirmed.
      if (geminiLog) {
        statuses.gemini = "error";
        await store.testProvider("gemini");
        assert.ok((await readFile(geminiLog, "utf8")).split("\n").some((line) => line && line !== "--version"), "the test prompt reached the Gemini CLI");
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("after the first-run scan (review round 3, item 1)", () => {
  it("leaves the scan by every exit without discovery, and checks a provider in full only when the admin acts on it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-model-scan-"));
    let listed = 0;
    let generation = 0;
    const original = { ollama: process.env.OPENAGENTS_OLLAMA_URL, host: process.env.OLLAMA_HOST, lm: process.env.OPENADMINOS_LM_STUDIO_URL };
    process.env.OPENAGENTS_OLLAMA_URL = "http://127.0.0.1:11434";
    delete process.env.OLLAMA_HOST;
    process.env.OPENADMINOS_LM_STUDIO_URL = "http://127.0.0.1:1234/v1";
    const store = new AppStateStore({
      filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
      providerListFactory: () => {
        listed += 1;
        return providerCatalog.map((provider) => ({ ...provider, status: "connected" as const, models: ["m"], detail: `check ${generation}` }));
      },
      llmFactory: () => ({
        available: true, defaultModel: "m",
        async complete() { return { text: "ok", model: "m" }; },
        async *stream() { yield { delta: "ok", accumulated: "ok", done: true, model: "m" }; },
      }),
    });
    const detail = async (id: string) => (await store.listProviders()).find((provider) => provider.id === id)?.detail;
    try {
      await store.scanModels();
      const afterScan = listed;
      // Every exit: Continue to Chat, Open chat with a local model, Preview with sample data, then what runs in the background.
      await store.completeFirstRunScan();
      await store.getAppState();
      await store.setActiveProviderAndModel("ollama", "m");
      await store.addSampleTenant().catch(() => undefined);
      await store.tickOffice().catch(() => undefined);
      await store.setActiveModel("ollama", "m").catch(() => undefined);
      assert.equal(listed, afterScan, "no exit and no background caller ran provider detection");
      assert.equal(await detail("anthropic"), "check 0");

      // Testing and selecting are explicit actions: that provider alone is checked again.
      generation = 1;
      await store.testProvider("anthropic");
      assert.equal(listed, afterScan + 1);
      assert.equal(await detail("anthropic"), "check 1");
      assert.equal(await detail("openai"), "check 0");
      generation = 2;
      await store.setActiveProvider("openai");
      assert.equal(listed, afterScan + 2);
      assert.equal(await detail("openai"), "check 2");
      assert.equal(await detail("ollama"), "check 0");

      // Refresh providers in Settings checks every provider in full again.
      await store.refreshProviders();
      const providers = await store.listProviders();
      assert.ok(providers.every((provider) => provider.detail === "check 2"));
      assert.equal(listed, afterScan + 3);
    } finally {
      for (const [key, value] of [["OPENAGENTS_OLLAMA_URL", original.ollama], ["OLLAMA_HOST", original.host], ["OPENADMINOS_LM_STUDIO_URL", original.lm]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("review round 2: coordination and Start (items 3, 7, B)", () => {
  const fresh = async (onList?: () => void) => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-model-scan-"));
    const store = new AppStateStore({
      filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
      providerListFactory: async () => {
        onList?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return providerCatalog.map((provider) => ({ ...provider, status: "not-installed" as const, models: [] }));
      },
    });
    // A fresh store can still be writing its first state file when a test ends; retry the removal.
    return { store, cleanup: async () => { store.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
  };

  it("sends every progress event to each caller of a shared scan, including one that joins late (B)", async () => {
    const { store, cleanup } = await fresh();
    try {
      const first: string[] = [];
      const second: string[] = [];
      const a = store.scanModels((probe) => first.push(`${probe.providerId}:${probe.state}`));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const b = store.scanModels((probe) => second.push(`${probe.providerId}:${probe.state}`));
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(ra, rb);
      assert.deepEqual(new Set(second), new Set(first));
      assert.ok(first.length >= ra.probes.length * 2);
    } finally {
      await cleanup();
    }
  });

  it("numbers every scan and Retry completion so a window can ignore an older one (7)", async () => {
    const { store, cleanup } = await fresh();
    try {
      const scan = await store.scanModels();
      const [retry, again] = await Promise.all([store.retryModelScanProbe("anthropic"), store.scanModels()]);
      assert.ok(typeof scan.generation === "number");
      assert.equal(retry.generation, scan.generation! + 1, "the Retry was queued first");
      assert.equal(again.generation, scan.generation! + 2, "the scan ran after it, never alongside");
    } finally {
      await cleanup();
    }
  });

  it("returns a failed Start without scanning again", async () => {
    let listed = 0;
    const { store, cleanup } = await fresh(() => { listed += 1; });
    const original = process.env.OPENAGENTS_OLLAMA_URL;
    process.env.OPENAGENTS_OLLAMA_URL = "http://10.20.30.40:11434";
    try {
      const result = await store.startLocalRuntime("ollama");
      assert.equal(result.started, false);
      assert.match(result.message ?? "", /outside this device/);
      assert.equal(result.scan, undefined);
      assert.equal(listed, 0);
    } finally {
      if (original === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
      else process.env.OPENAGENTS_OLLAMA_URL = original;
      await cleanup();
    }
  });

  /**
   * A fake LM Studio: `lms` on PATH appends its arguments to a log, and the
   * stub server answers its models list only once `lms` has run, so
   * "started" means the launch happened (review round 3, item 7).
   */
  async function fakeLmStudio() {
    const { createServer } = await import("node:http");
    const bin = await mkdtemp(join(tmpdir(), "openadminos-lms-"));
    const log = join(bin, "lms.log");
    await writeFile(join(bin, "lms"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
    await chmod(join(bin, "lms"), 0o755);
    const launched = () => readFile(log, "utf8").then((text) => text.trim().split("\n").filter(Boolean), () => [] as string[]);
    const server = createServer((_request, response) => {
      void launched().then((lines) => {
        if (lines.length === 0) response.writeHead(503).end();
        else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "local-model" }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const original = { path: process.env.PATH, home: process.env.HOME, lm: process.env.OPENADMINOS_LM_STUDIO_URL };
    // HOME points at the temp folder, so no real ~/.lmstudio/bin/lms is found first.
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.HOME = bin;
    process.env.OPENADMINOS_LM_STUDIO_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    return {
      launched,
      cleanup: async () => {
        for (const [key, value] of [["PATH", original.path], ["HOME", original.home], ["OPENADMINOS_LM_STUDIO_URL", original.lm]] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(bin, { recursive: true, force: true });
      },
    };
  }

  it("starts LM Studio through the shared CLI launcher with fixed arguments (Muse round 2, O)", { skip: process.platform === "win32" }, async () => {
    const { store, cleanup } = await fresh();
    const lm = await fakeLmStudio();
    try {
      const result = await store.startLocalRuntime("lm-studio");
      assert.equal(result.started, true, result.message);
      assert.deepEqual(await lm.launched(), ["server start"]);
    } finally {
      await lm.cleanup();
      await cleanup();
    }
  });

  it("scans afresh once a started runtime answers, never joining a scan from before, and starts it once for two windows (review round 3, item 3)", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-model-scan-"));
    const lm = await fakeLmStudio();
    // The provider list reads LM Studio's state when a check starts, then takes a while, like a slow scan.
    const store = new AppStateStore({
      filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
      providerListFactory: async () => {
        const running = (await lm.launched()).length > 0;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return providerCatalog.map((provider) =>
          provider.id === "lm-studio" && running
            ? { ...provider, status: "connected" as const, models: ["local-model"], defaultModel: "local-model" }
            : { ...provider, status: "not-installed" as const, models: [] });
      },
    });
    try {
      const before = store.scanModels();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const [scan, first, second] = await Promise.all([before, store.startLocalRuntime("lm-studio"), store.startLocalRuntime("lm-studio")]);
      assert.notEqual(scan.probes.find((probe) => probe.providerId === "lm-studio")?.ready, true, "the scan from before saw LM Studio stopped");
      for (const start of [first, second]) {
        assert.equal(start.started, true, start.message);
        assert.equal(start.scan?.probes.find((probe) => probe.providerId === "lm-studio")?.ready, true, "Start returns a scan made after the runtime answered");
        assert.notEqual(start.scan?.outcome.kind, "nothing");
      }
      assert.deepEqual(await lm.launched(), ["server start"], "two Starts launched LM Studio once");
    } finally {
      await lm.cleanup();
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("polls LM Studio's models list at the default endpoint, without a doubled /v1 (3)", async () => {
    const { createServer } = await import("node:http");
    const { resolveLmStudioEndpoint } = await import("@openadminos/runtime");
    const { runtimeReadyUrl } = await import("./model-scan.js");
    assert.match(runtimeReadyUrl("lm-studio", resolveLmStudioEndpoint()), /\/v1\/models$/);
    assert.doesNotMatch(runtimeReadyUrl("lm-studio", resolveLmStudioEndpoint()), /\/v1\/v1\//);
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(request.url === "/v1/models" ? 200 : 404).end("{\"data\":[]}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await fetch(runtimeReadyUrl("lm-studio", `http://127.0.0.1:${port}/v1`));
      assert.equal(response.ok, true);
      assert.deepEqual(seen, ["/v1/models"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
