import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, get, request } from "node:http";
import { get as httpsGet } from "node:https";
import { after, it } from "node:test";

const { PROVIDER_GUARD_CASE: scenario, PROVIDER_GUARD_ORIGIN: origin } = process.env;

if (scenario === "fetch") {
  it("blocks an unregistered fetch", async () => {
    await assert.rejects(fetch(new Request(`${origin}/inference`)), /Blocked fetch outside test HTTP servers/);
  });
} else if (scenario === "http") {
  it("blocks an unregistered node:http request", () => {
    assert.throws(() => request({ port: new URL(origin).port, path: "/health" }),
      /Blocked node:http\.request outside test HTTP servers: http:\/\/localhost/);
  });
} else if (scenario === "https") {
  it("checks the effective host after node:https URL options override it", () => {
    assert.throws(() => httpsGet("https://example.com/v1/audio/speech", { hostname: "::1", port: new URL(origin).port }),
      /Blocked node:https\.get outside test HTTP servers: https:\/\/\[::1\]/);
  });
} else if (scenario === "alias") {
  it("blocks an unregistered alias before it can resolve to loopback", () => {
    const lookup = (_host, _options, callback) => callback(null, "127.0.0.1", 4);
    assert.throws(() => request({ hostname: "localhost.localdomain", port: new URL(origin).port, family: 4, lookup }),
      /Blocked node:http\.request outside test HTTP servers: http:\/\/localhost\.localdomain/);
  });
} else if (scenario === "external") {
  it("blocks an unregistered external host regardless of HTTP client", async () => {
    await assert.rejects(fetch(origin), /Blocked fetch outside test HTTP servers: https:\/\/external\.example/);
    assert.throws(() => get(origin.replace("https:", "http:")),
      /Blocked node:http\.get outside test HTTP servers: http:\/\/external\.example/);
    assert.throws(() => httpsGet(origin), /Blocked node:https\.get outside test HTTP servers: https:\/\/external\.example/);
  });
} else if (scenario === "late") {
  it("passes before teardown", () => {});
  after(() => {
    assert.throws(() => spawnSync(process.execPath, ["--version"]), /Blocked spawnSync outside provider fixtures/);
    process.exitCode = 0;
  });
} else {
  it("allows requests to its own listening test server", async () => {
    if (scenario === "proxy") {
      const { assertProxiesIsolated, assertProxiesRestored } = await import("./provider-test-proxy.mjs");
      assertProxiesIsolated();
      process.on("exit", assertProxiesRestored);
    }
    const server = createServer((_request, response) => response.end("fixture"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/health`;
    try {
      assert.equal(await (await fetch(url)).text(), "fixture");
      const fromHttp = await new Promise((resolve, reject) => {
        get(new URL(url), async (response) => {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          resolve(Buffer.concat(chunks).toString());
        }).on("error", reject);
      });
      assert.equal(fromHttp, "fixture");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
