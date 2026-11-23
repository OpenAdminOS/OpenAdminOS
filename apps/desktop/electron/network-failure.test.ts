import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { classifyNetworkFailure, describeNetworkFailure, systemProxyFrom } from "./network-failure.js";
import { AppStateStore } from "./state.js";

/** Design and enterprise round: proxy and offline failures name the host, the proxy and the fix. */

const coded = (code: string, message = `connect ${code}`) => Object.assign(new Error(message), { code });
const fetchFailed = (cause: unknown) => Object.assign(new TypeError("fetch failed"), { cause });

describe("network failure classification", () => {
  it("reads Node codes, fetch causes, Ollama's Go errors, Chromium net errors and proxy credentials", () => {
    assert.equal(classifyNetworkFailure(fetchFailed(coded("ENOTFOUND"))), "dns");
    assert.equal(classifyNetworkFailure(fetchFailed(coded("ECONNREFUSED"))), "refused");
    assert.equal(classifyNetworkFailure(fetchFailed(coded("UND_ERR_CONNECT_TIMEOUT"))), "timeout");
    assert.equal(classifyNetworkFailure(fetchFailed(coded("SELF_SIGNED_CERT_IN_CHAIN"))), "certificate");
    assert.equal(classifyNetworkFailure(new Error('pull model manifest: Get "https://registry.ollama.ai/v2/x": dial tcp: lookup registry.ollama.ai: no such host')), "dns");
    assert.equal(classifyNetworkFailure(new Error("tls: failed to verify certificate: x509: certificate signed by unknown authority")), "certificate");
    assert.equal(classifyNetworkFailure(new Error("net::ERR_INTERNET_DISCONNECTED")), "offline");
    assert.equal(classifyNetworkFailure(new Error("HTTP 407 Proxy Authentication Required")), "proxy-auth");
    assert.equal(classifyNetworkFailure(new Error("HTTP 404")), undefined, "an HTTP error is not a network failure");
    assert.equal(classifyNetworkFailure(new Error("Unexpected token < in JSON")), undefined);
  });

  it("reads the system proxy from Electron's answer", () => {
    assert.equal(systemProxyFrom("DIRECT"), undefined);
    assert.equal(systemProxyFrom("PROXY proxy.contoso.com:8080; DIRECT"), "proxy.contoso.com:8080");
    assert.equal(systemProxyFrom("HTTPS secure.contoso.com:443"), "secure.contoso.com:443");
  });
});

describe("the message names the host, whether a proxy was used and the fix", () => {
  it("says a system proxy is set and that OpenAdminOS did not use it", async () => {
    const message = await describeNetworkFailure({
      what: "Microsoft sign-in",
      url: "https://login.microsoftonline.com/",
      error: fetchFailed(coded("ETIMEDOUT")),
      resolveProxy: async () => "PROXY proxy.contoso.com:8080",
    });
    assert.equal(
      message,
      "Microsoft sign-in could not reach login.microsoftonline.com: it did not answer in time. This device has a system proxy (proxy.contoso.com:8080); OpenAdminOS connects directly and did not use it. Ask your network team to allow direct HTTPS access to login.microsoftonline.com, then try again.",
    );
  });

  it("says no system proxy is set when Electron says DIRECT, and that it connected directly without one when it cannot tell", async () => {
    const direct = await describeNetworkFailure({ what: "The Marketplace", url: "https://raw.githubusercontent.com/x/index.json", error: fetchFailed(coded("ENOTFOUND")), resolveProxy: async () => "DIRECT" });
    assert.match(direct!, /^The Marketplace could not reach raw\.githubusercontent\.com: its name did not resolve\. No system proxy is set, and OpenAdminOS connected directly\. Check the network connection, VPN and DNS, then try again\.$/);
    const unknown = await describeNetworkFailure({ what: "The Marketplace", url: "https://raw.githubusercontent.com/x", error: fetchFailed(coded("ECONNRESET")) });
    assert.match(unknown!, /OpenAdminOS connected directly, without a proxy\./);
  });

  it("points a certificate failure at the inspecting proxy's root certificate", async () => {
    const message = await describeNetworkFailure({ what: "The Marketplace", url: "https://raw.githubusercontent.com/x", error: fetchFailed(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY")), resolveProxy: async () => "DIRECT" });
    assert.match(message!, /certificate was not trusted, which a proxy that inspects HTTPS can cause/);
    assert.match(message!, /Add your proxy's root certificate to this device's trust store/);
  });

  it("says Ollama downloads through the proxy in its own environment", async () => {
    const message = await describeNetworkFailure({
      what: "The local index model download",
      url: "https://registry.ollama.ai/",
      error: new Error("dial tcp: lookup registry.ollama.ai: no such host"),
      path: "ollama",
    });
    assert.match(message!, /^The local index model download could not reach registry\.ollama\.ai: its name did not resolve\. Ollama downloads it itself and uses the proxy set in its own environment \(HTTPS_PROXY\)/);
    assert.match(message!, /set HTTPS_PROXY where Ollama runs and restart it/);
  });

  it("says a runtime on this device involves no proxy", async () => {
    const message = await describeNetworkFailure({
      what: "Ollama",
      url: "http://127.0.0.1:11434",
      error: fetchFailed(coded("ECONNREFUSED")),
      path: "loopback",
      loopbackRecovery: "Start it yourself with `ollama serve`, then scan again.",
    });
    assert.equal(message, "Ollama could not reach 127.0.0.1:11434: the connection was refused. It runs on this device, so no proxy is involved. Start it yourself with `ollama serve`, then scan again.");
  });

  it("leaves errors that are not network failures to their own message", async () => {
    assert.equal(await describeNetworkFailure({ what: "x", url: "https://example.com", error: new Error("HTTP 500") }), undefined);
  });
});

describe("Microsoft sign-in in the setup dialog", () => {
  it("names login.microsoftonline.com, the system proxy and the fix when sign-in cannot reach Microsoft", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oaos-network-"));
    const store = new AppStateStore({
      filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
      resolveProxy: async () => "PROXY proxy.contoso.com:8080",
      interactiveSignIn: async () => {
        throw Object.assign(new Error("network_error: Network request failed"), { cause: fetchFailed(coded("ENOTFOUND")) });
      },
    });
    try {
      await assert.rejects(
        () => store.connectTenant({ partIds: ["intune.devices"] }),
        /^Error: Microsoft sign-in could not reach login\.microsoftonline\.com: its name did not resolve\. This device has a system proxy \(proxy\.contoso\.com:8080\); OpenAdminOS connects directly and did not use it\./,
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("the local index model download", () => {
  for (const { reason, phase } of [
    { reason: "reset", phase: "pull" },
    { reason: "reset", phase: "tags" },
    { reason: "quit", phase: "pull" },
  ]) {
    it(`closes the Ollama connection during /api/${phase} on ${reason} and allows a later download`, { timeout: 5_000 }, async () => {
      const dir = await mkdtemp(join(tmpdir(), "oaos-pull-"));
      const statePath = join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({ installedAgents: [], runs: [], tenants: [] }));
      const openStore = () => new AppStateStore({ filePath: statePath, userDataPath: dir, statsApiUrl: "", tokenStore: { read: async () => "", write: async () => undefined } });
      const store = openStore();
      let closed = false;
      let started!: () => void;
      let disconnected!: () => void;
      const pullStarted = new Promise<void>((resolve) => { started = resolve; });
      const pullDisconnected = new Promise<void>((resolve) => { disconnected = resolve; });
      let pulls = 0;
      let stall = true;
      const server = createServer((request, response) => {
        const tags = request.url === "/api/tags";
        if (!tags) pulls += 1;
        response.setHeader("content-type", "application/json");
        if (stall && request.url === `/api/${phase}`) {
          stall = false;
          response.once("close", disconnected);
          // Leave the response unfinished. In the quit case, stop a partial body too.
          if (reason === "quit") response.write('{"status":');
          started();
          return;
        }
        response.end(tags ? '{"models":[]}' : '{"status":"success"}');
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const original = process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
      process.env.OPENADMINOS_EMBEDDING_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        const download = store.autoInstallEmbeddingModel();
        const signal = AbortSignal.timeout(3_000);
        const deadline = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        await Promise.race([pullStarted, deadline]);
        if (reason === "reset") {
          assert.equal(await store.beginLocalReset(), undefined);
          store.markLocalResetCommitted();
        } else {
          store.stopEmbeddingModelDownload();
        }
        await Promise.race([Promise.all([download, pullDisconnected]), deadline]);
        await store.autoInstallEmbeddingModel();
        const abortedPulls = phase === "pull" ? 1 : 0;
        assert.equal(pulls, abortedPulls);
        const saved = JSON.parse(await readFile(statePath, "utf8"));
        assert.equal(saved.embeddingModelPullError, undefined);
        assert.equal(saved.embeddingModelPullAttemptedAt, undefined);
        if (reason === "reset") {
          store.cancelLocalReset();
          await store.autoInstallEmbeddingModel();
        } else {
          store.close();
          closed = true;
          const fresh = openStore();
          try {
            await fresh.autoInstallEmbeddingModel();
          } finally {
            fresh.close();
          }
        }
        assert.equal(pulls, abortedPulls + 1);
        assert.ok(JSON.parse(await readFile(statePath, "utf8")).embeddingModelPullAttemptedAt);
      } finally {
        if (reason === "reset") store.cancelLocalReset();
        if (!closed) store.close();
        if (original === undefined) delete process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
        else process.env.OPENADMINOS_EMBEDDING_ENDPOINT = original;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  }

  it("records why Ollama could not download it, naming the registry and Ollama's own proxy setting", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/tags") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [] }));
        return;
      }
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: 'pull model manifest: Get "https://registry.ollama.ai/v2/library/x/manifests/latest": dial tcp: lookup registry.ollama.ai: no such host' }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const original = process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
    process.env.OPENADMINOS_EMBEDDING_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = await mkdtemp(join(tmpdir(), "oaos-network-"));
    await writeFile(join(dir, "state.json"), JSON.stringify({ installedAgents: [], runs: [], tenants: [] }));
    const store = new AppStateStore({ filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "", tokenStore: { read: async () => "", write: async () => undefined } });
    try {
      await store.autoInstallEmbeddingModel();
      const status = await store.getRetrievalStatusWithUpdates();
      assert.equal(status.embeddingModelInstalled, false);
      assert.match(status.embeddingModelError ?? "", /^The local index model download could not reach registry\.ollama\.ai: its name did not resolve\. Ollama downloads it itself and uses the proxy set in its own environment \(HTTPS_PROXY\)/);
    } finally {
      if (original === undefined) delete process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
      else process.env.OPENADMINOS_EMBEDDING_ENDPOINT = original;
      store.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("says the local Ollama stopped answering, not the registry, and tries again on the next launch (PR #206 review rounds 8 and 9)", { timeout: 10_000 }, async () => {
    const { loopbackTransport } = await import("./retrieval/direct-fetch.js");
    let pulls = 0;
    const server = createServer((request, response) => {
      if (request.url === "/api/tags") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [] }));
        return;
      }
      // The pull gets nothing: the local Ollama stalled.
      pulls += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const original = process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
    process.env.OPENADMINOS_EMBEDDING_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const idle = loopbackTransport.idleTimeoutMs;
    loopbackTransport.idleTimeoutMs = 100;
    const dir = await mkdtemp(join(tmpdir(), "oaos-network-"));
    await writeFile(join(dir, "state.json"), JSON.stringify({ installedAgents: [], runs: [], tenants: [] }));
    const store = new AppStateStore({ filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "", tokenStore: { read: async () => "", write: async () => undefined } });
    try {
      await store.autoInstallEmbeddingModel();
      const status = await store.getRetrievalStatusWithUpdates();
      assert.equal(status.embeddingModelInstalled, false);
      assert.equal(status.embeddingModelError, "Ollama stopped answering while downloading nomic-embed-text. Check that Ollama is running, then restart OpenAdminOS to download it again.");
      // The stall is not the day's attempt: the next launch pulls again instead of waiting 24 hours.
      await store.autoInstallEmbeddingModel();
      assert.equal(pulls, 2);
    } finally {
      loopbackTransport.idleTimeoutMs = idle;
      if (original === undefined) delete process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
      else process.env.OPENADMINOS_EMBEDDING_ENDPOINT = original;
      store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
