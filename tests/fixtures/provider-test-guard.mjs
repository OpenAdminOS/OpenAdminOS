import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent as HttpAgent, ClientRequest, createServer, get, request } from "node:http";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { after, it } from "node:test";
import { Agent as FetchAgent } from "undici";
import { registerProviderFixtureDirectory } from "../provider-test-guard.mjs";

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
} else if (scenario === "spawn-options" || scenario === "spawn-shell") {
  it("checks the same effective options that Node receives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-guard-spawn-"));
    try {
      const fixture = join(directory, "cli");
      await writeFile(fixture, '#!/bin/sh\nexit "${FIXTURE_EXIT_CODE:-0}"\n', { mode: 0o755 });
      registerProviderFixtureDirectory(directory);

      if (scenario === "spawn-shell") {
        const options = { shell: true };
        for (const args of [[options], [undefined, options], [null, options]]) {
          assert.throws(() => spawn(fixture, ...args), /Blocked spawn outside provider fixtures/);
          assert.throws(() => spawnSync(fixture, ...args), /Blocked spawnSync outside provider fixtures/);
        }
      } else if (process.platform !== "win32") {
        const options = { env: { FIXTURE_EXIT_CODE: "23" } };
        for (const args of [[options], [undefined, options], [null, options]]) {
          assert.deepEqual(await once(spawn(fixture, ...args), "exit"), [23, null]);
          assert.equal(spawnSync(fixture, ...args).status, 23);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
} else if (scenario === "route-overrides") {
  it("rejects options that can route an approved origin elsewhere", async () => {
    const fixture = createServer((_request, response) => response.end("fixture"));
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${fixture.address().port}/health`);
    const destination = new URL(origin);
    const reroute = () => connect(Number(destination.port), destination.hostname);
    const tlsFixture = createHttpsServer();
    tlsFixture.listen(0, "127.0.0.1");
    await once(tlsFixture, "listening");
    // Open the second connection only if TLS starts writing through this socket.
    let upstream;
    const socket = new Duplex({
      read() {},
      write(chunk, encoding, callback) {
        upstream ??= reroute();
        upstream.write(chunk, encoding, callback);
      },
    });
    const agent = new HttpAgent();
    agent.createConnection = reroute;
    const dispatcher = new FetchAgent({ connect: (_options, callback) => {
      const socket = reroute();
      socket.once("connect", () => callback(null, socket));
      socket.once("error", callback);
    } });
    try {
      for (const [key, value] of [
        ["agent", agent],
        ["lookup", () => assert.fail("lookup override called")],
        ["createConnection", reroute],
        ["socketPath", "/unregistered-provider.sock"],
        ["_defaultAgent", agent],
      ]) {
        assert.throws(() => get(url, { [key]: value }), new RegExp(`Blocked node:http\\.get.*${key} override`));
      }
      assert.throws(() => new ClientRequest(url, { agent }), /Blocked node:http\.ClientRequest.*agent override/);
      assert.throws(() => httpsGet(`https://127.0.0.1:${tlsFixture.address().port}/health`, { socket }),
        /Blocked node:https\.get.*socket override/);
      await assert.rejects(fetch(url, { dispatcher }), /Blocked fetch.*dispatcher override/);
    } finally {
      upstream?.destroy();
      socket.destroy();
      agent.destroy();
      await dispatcher.close();
      await Promise.all([fixture, tlsFixture].map((server) => new Promise((resolve) => server.close(resolve))));
    }
  });
} else if (scenario === "localhost-family") {
  it("pins localhost to the registered fixture even when family requests another listener", async (t) => {
    const fixture = createServer((_request, response) => response.end("fixture"));
    fixture.listen(0, "localhost");
    await once(fixture, "listening");
    const { family, port } = fixture.address();
    const otherFamily = family === "IPv4" ? 6 : 4;
    const otherHost = otherFamily === 6 ? "::1" : "127.0.0.1";
    let connections = 0;
    const other = createTcpServer((socket) => {
      connections++;
      socket.destroy();
    });
    try {
      other.listen(port, otherHost);
      try {
        await once(other, "listening");
      } catch (error) {
        if (otherFamily !== 6 || !["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) throw error;
        t.skip("IPv6 loopback unavailable");
        return;
      }
      const url = `http://localhost:${port}/health`;
      const response = await new Promise((resolve, reject) => {
        get(url, { family: otherFamily }, resolve).once("error", reject);
      });
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), "fixture");
      assert.equal(await (await fetch(url)).text(), "fixture");
      assert.equal(connections, 0);
    } finally {
      await Promise.all([fixture, other].map((server) => new Promise((resolve) => server.close(resolve))));
    }
  });
} else if (scenario === "dual-stack") {
  it("allows IPv4 and IPv6 loopback for the default wildcard listener", async (t) => {
    const server = createServer((_request, response) => response.end("fixture"));
    server.listen(0);
    await once(server, "listening");
    try {
      const { address, port } = server.address();
      if (address !== "::") {
        t.skip("IPv6 wildcard unavailable");
        return;
      }
      for (const host of ["[::1]", "127.0.0.1"]) {
        assert.equal(await (await fetch(`http://${host}:${port}/health`)).text(), "fixture");
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
