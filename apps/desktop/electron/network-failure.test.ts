import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  it("records why Ollama could not download it, naming the registry and Ollama's own proxy setting", async () => {
    const { createServer } = await import("node:http");
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
    const { writeFile } = await import("node:fs/promises");
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
});
