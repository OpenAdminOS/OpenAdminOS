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
  scanOutcome,
  scanProbeFromProvider,
  type ModelScanCheck,
} from "./model-scan.js";
import { checkLmStudio, checkOllama } from "./provider-detail.js";
import { AppStateStore } from "./state.js";

const catalog = (id: string) => providerCatalog.find((provider) => provider.id === id)!;
const ollamaReady = (models: string[]): ProviderSummary => ({ ...catalog("ollama"), status: "connected", models, defaultModel: models[0] });
const claudeReady: ProviderSummary = { ...catalog("anthropic"), status: "connected", models: ["claude-sonnet-5-5"], cli: { state: "ready", version: "2.4.0" } };
const delayed = (ms: number, probe: ModelScanProbe): ModelScanCheck => ({
  providerId: probe.providerId,
  name: probe.name,
  where: probe.where,
  run: () => new Promise((resolve) => setTimeout(() => resolve(probe), ms)),
});
const found = (providerId: "ollama" | "anthropic" | "openai", name: string): ModelScanProbe => ({
  ...checkingProbe({ providerId, name, where: providerId === "ollama" ? "local" : "hosted" }),
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
        { providerId: "copilot", name: "GitHub Copilot CLI", where: "hosted", run: () => new Promise(() => undefined) },
        { providerId: "gemini", name: "Gemini CLI", where: "hosted", run: async () => { throw new Error("Gemini CLI could not start."); } },
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
        { providerId: "anthropic", name: "Claude Code", where: "hosted", models: ["claude-sonnet-5-5"], state: "found", ready: true, summary: "Signed in", facts: ["Version 2.4.0"], durationMs: undefined },
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
      assert.equal(scanOutcome([lmStudio], { activeProviderId: "anthropic", providerChosenByUser: true }).kind, "local-ready");
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
        // Loading app state already selected the ready local provider, so the scan finds it ready.
        assert.deepEqual(result.outcome, { kind: "local-ready", providerId: "lm-studio", model: "local-model" });
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
