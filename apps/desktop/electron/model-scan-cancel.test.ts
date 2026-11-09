import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { providerCatalog } from "@openadminos/agent-sdk";
import { discoverCli, probeLmStudioLlm } from "@openadminos/runtime";

import { runScanCheck, scanProbeFromProvider, scanProviderCheck } from "./model-scan.js";
import { checkLmStudio, checkOllama } from "./provider-detail.js";
import { AppStateStore } from "./state.js";

/** Review round 2 on PR #175: items 4, 5, 6 and Muse G, K and T. */

const catalog = (id: string) => providerCatalog.find((provider) => provider.id === id)!;
const posix = process.platform !== "win32";

async function fakeCli(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\necho "$*" >> "${join(dir, `${name}.log`)}"\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe("cancellation (item 4 and T)", () => {
  it("spawns nothing when the signal is already aborted, whatever the number of candidates", { skip: !posix }, async () => {
    const one = await mkdtemp(join(tmpdir(), "oaos-cancel-"));
    const two = await mkdtemp(join(tmpdir(), "oaos-cancel-"));
    try {
      await fakeCli(one, "gemini", 'echo "9.9.9"');
      await fakeCli(two, "gemini", 'echo "9.9.9"');
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(() => discoverCli("gemini", { PATH: `${one}:${two}` }, undefined, controller.signal), /stopped/);
      await assert.rejects(() => readFile(join(one, "gemini.log"), "utf8"));
      await assert.rejects(() => readFile(join(two, "gemini.log"), "utf8"));
    } finally {
      await rm(one, { recursive: true, force: true });
      await rm(two, { recursive: true, force: true });
    }
  });

  for (const [id, name] of [["anthropic", "claude"], ["openai", "codex"]] as const) {
    it(`kills a ${name} wrapper and the child it started when the check times out`, { skip: !posix }, async () => {
      const dir = await mkdtemp(join(tmpdir(), "oaos-cancel-"));
      try {
        const childPid = join(dir, "child");
        const binary = await fakeCli(dir, name, `sleep 30 &\necho $! > "${childPid}"\nwait`);
        const probe = await runScanCheck(
          { providerId: id, name, where: "hosted", target: name, run: (signal) => scanProviderCheck(catalog(id), { signal, binaryPath: binary }).then((summary) => scanProbeFromProvider(summary)) },
          1500,
        );
        assert.equal(probe.state, "could-not-check");
        const pid = Number((await readFile(childPid, "utf8")).trim());
        assert.equal(await gone(pid), true, `the ${name} wrapper's child must not survive`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("kills a Gemini CLI that hangs on --version", { skip: !posix }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "oaos-cancel-"));
    try {
      const pidFile = join(dir, "pid");
      const binary = await fakeCli(dir, "gemini", `echo $$ > "${pidFile}"\nexec sleep 30`);
      const probe = await runScanCheck(
        { providerId: "gemini", name: "Gemini CLI", where: "hosted", target: "gemini --version", run: (signal) => scanProviderCheck(catalog("gemini"), { signal, binaryPath: binary }).then((summary) => scanProbeFromProvider(summary)) },
        1500,
      );
      assert.equal(probe.state, "could-not-check");
      assert.equal(await gone(Number((await readFile(pidFile, "utf8")).trim())), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops an LM Studio request that never answers", async () => {
    const { server, url } = await serve(() => undefined);
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const started = Date.now();
      const probe = await probeLmStudioLlm({ endpoint: `${url}/v1`, signal: controller.signal, timeoutMs: 10_000 });
      assert.ok(Date.now() - started < 1_000);
      assert.equal(probe.status, "error", "a stopped check is not a server that is not running");
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("failed HTTP checks are not install results (item 6 and G)", () => {
  const original = { ollama: process.env.OPENAGENTS_OLLAMA_URL, lm: process.env.OPENADMINOS_LM_STUDIO_URL };
  afterEach(() => {
    if (original.ollama === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
    else process.env.OPENAGENTS_OLLAMA_URL = original.ollama;
    if (original.lm === undefined) delete process.env.OPENADMINOS_LM_STUDIO_URL;
    else process.env.OPENADMINOS_LM_STUDIO_URL = original.lm;
  });

  it("reports malformed JSON from a running Ollama and LM Studio as could not check", async () => {
    const { server, url } = await serve((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end("{not json"));
    try {
      process.env.OPENAGENTS_OLLAMA_URL = url;
      process.env.OPENADMINOS_LM_STUDIO_URL = `${url}/v1`;
      assert.equal(scanProbeFromProvider(await checkOllama(catalog("ollama"))).state, "could-not-check");
      assert.equal(scanProbeFromProvider(await checkLmStudio(catalog("lm-studio"))).state, "could-not-check");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a timeout as could not check", async () => {
    const { server, url } = await serve(() => undefined);
    try {
      process.env.OPENAGENTS_OLLAMA_URL = url;
      process.env.OPENADMINOS_LM_STUDIO_URL = `${url}/v1`;
      assert.equal(scanProbeFromProvider(await checkOllama(catalog("ollama"), { timeoutMs: 100 })).state, "could-not-check");
      assert.equal(scanProbeFromProvider(await checkLmStudio(catalog("lm-studio"), { timeoutMs: 100 })).state, "could-not-check");
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // The errors are injected in the shapes Node 22's fetch produces, so the
  // result does not depend on how a closed port behaves on the test host
  // (a parallel test process can take over a just-closed ephemeral port).
  describe("only a refused connection is not running (CI on Linux, PR #175)", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = originalFetch; });
    const coded = (code: string) => Object.assign(new Error(`connect ${code} 127.0.0.1:11434`), { code });
    const fetchFailed = (cause: unknown) => Object.assign(new TypeError("fetch failed"), { cause });
    const refused: Array<[string, unknown]> = [
      ["ECONNREFUSED on 127.0.0.1 (Linux and macOS)", fetchFailed(coded("ECONNREFUSED"))],
      ["localhost refused on IPv6 and IPv4 (AggregateError with a code)", fetchFailed(Object.assign(new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")]), { code: "ECONNREFUSED" }))],
      ["localhost refused on every address (AggregateError without a code)", fetchFailed(new AggregateError([coded("ECONNREFUSED"), coded("EADDRNOTAVAIL")]))],
    ];
    const failed: Array<[string, unknown]> = [
      ["a timeout", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
      ["a socket the server closed mid-response", fetchFailed(Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }))],
      ["one address refused and one timed out", fetchFailed(new AggregateError([coded("ECONNREFUSED"), coded("ETIMEDOUT")]))],
    ];
    for (const [label, error] of refused) {
      it(`not running: ${label}`, async () => {
        globalThis.fetch = (async () => { throw error; }) as typeof fetch;
        process.env.OPENAGENTS_OLLAMA_URL = "http://127.0.0.1:11434";
        process.env.OPENADMINOS_LM_STUDIO_URL = "http://127.0.0.1:1234/v1";
        assert.equal(scanProbeFromProvider(await checkOllama(catalog("ollama"))).state, "not-found");
        assert.equal(scanProbeFromProvider(await checkLmStudio(catalog("lm-studio"))).state, "not-found");
      });
    }
    for (const [label, error] of failed) {
      it(`could not check: ${label}`, async () => {
        globalThis.fetch = (async () => { throw error; }) as typeof fetch;
        process.env.OPENAGENTS_OLLAMA_URL = "http://127.0.0.1:11434";
        process.env.OPENADMINOS_LM_STUDIO_URL = "http://127.0.0.1:1234/v1";
        assert.equal(scanProbeFromProvider(await checkOllama(catalog("ollama"))).state, "could-not-check");
        assert.equal(scanProbeFromProvider(await checkLmStudio(catalog("lm-studio"))).state, "could-not-check");
      });
    }
  });

  it("reads at most four Ollama model capabilities at once (K)", async () => {
    let active = 0;
    let peak = 0;
    const { server, url } = await serve((request, response) => {
      if (request.url === "/api/tags") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: Array.from({ length: 12 }, (_, i) => ({ name: `model-${i}` })) }));
        return;
      }
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ capabilities: ["completion"] }));
      }, 20);
    });
    try {
      process.env.OPENAGENTS_OLLAMA_URL = url;
      const summary = await checkOllama(catalog("ollama"));
      assert.equal(summary.models.length, 12);
      assert.ok(peak <= 4, `peak concurrency ${peak}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Azure settings inside a bounded check (item 5)", () => {
  it("does not hold up the other checks when the keychain read stalls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oaos-azure-"));
    const original = process.env.OPENAGENTS_OLLAMA_URL;
    process.env.OPENAGENTS_OLLAMA_URL = "http://127.0.0.1:9";
    const store = new AppStateStore({ filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "", tokenStore: { read: async () => "", write: async () => undefined } });
    Object.assign(store, { getAzureOpenAIConfig: () => new Promise(() => undefined) });
    try {
      const seen: string[] = [];
      const started = Date.now();
      const result = await store.scanModels((probe) => { if (probe.state !== "checking") seen.push(probe.providerId); });
      assert.ok(Date.now() - started < 6_000);
      assert.equal(result.probes.find((probe) => probe.providerId === "azure-openai")?.state, "could-not-check");
      assert.ok(seen.includes("ollama"), "other checks resolved and reported");
      assert.notEqual(seen[0], "azure-openai");
    } finally {
      if (original === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
      else process.env.OPENAGENTS_OLLAMA_URL = original;
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
