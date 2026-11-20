import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, globalAgent as httpGlobalAgent, type Server } from "node:http";
import { describe, it } from "node:test";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { directFetch } from "./direct-fetch.js";

import { AppStateStore } from "../state.js";
import { embeddingModelState, pullEmbeddingModel } from "./embedding-model.js";
import { loopbackTransport } from "./direct-fetch.js";
import { EMBEDDING_QUERY_TIMEOUT_MS, loopbackEmbedQuery, loopbackEndpoints, ollamaEmbedQuery } from "./retrieval.js";

/** An embedding server on this device that redirects every request to a second one, which counts what reaches it. */
async function redirectingPair(): Promise<{ origin: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const target = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embeddings: [[0.1]], data: [{ embedding: [0.1] }], models: [{ name: "nomic-embed-text:latest" }] }));
  });
  await listen(target);
  const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  const origin = createServer((request, response) => response.writeHead(308, { location: `${targetUrl}${request.url ?? "/"}` }).end());
  await listen(origin);
  return {
    origin: `http://127.0.0.1:${(origin.address() as { port: number }).port}`,
    hits: () => hits,
    close: async () => {
      await Promise.all([shut(origin), shut(target)]);
    },
  };
}
const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const shut = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("local documentation retrieval never follows a redirect from this device (PR #204 review round 6)", () => {
  it("sends no question to a redirect target from either embedding request", async () => {
    const pair = await redirectingPair();
    try {
      await assert.rejects(ollamaEmbedQuery(pair.origin)("which devices are noncompliant"), /answered with a redirect to another address/);
      await assert.rejects(loopbackEmbedQuery(pair.origin)("which devices are noncompliant"), /answered with a redirect to another address/);
      assert.equal(pair.hits(), 0);
    } finally {
      await pair.close();
    }
  });

  it("reports a refused redirect in the Settings status and refuses a pull through it", async (t) => {
    const pair = await redirectingPair();
    t.after(() => pair.close());
    const previousEndpoint = process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
    process.env.OPENADMINOS_EMBEDDING_ENDPOINT = pair.origin;
    t.after(() => {
      if (previousEndpoint === undefined) delete process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
      else process.env.OPENADMINOS_EMBEDDING_ENDPOINT = previousEndpoint;
    });
    const dir = await mkdtemp(join(tmpdir(), "openadminos-embedding-redirect-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new AppStateStore({
      filePath: join(dir, "state.json"),
      statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
    });
    t.after(() => store.close());
    for (const status of [await store.getRetrievalStatusWithUpdates(), await store.refreshRetrievalIndex()]) {
      assert.equal(status.ollamaReachable, true);
      assert.equal(status.embeddingModelInstalled, false);
      assert.match(status.embeddingModelError ?? "", /answered with a redirect to another address/);
    }
    await assert.rejects(pullEmbeddingModel(pair.origin), /answered with a redirect to another address/);
    assert.equal(pair.hits(), 0);
  });

  it("keeps missing model and HTTP failures distinct", async (t) => {
    const endpoint = "http://127.0.0.1:11434";
    const request = t.mock.method(loopbackTransport, "fetch", async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) =>
      Response.json({ error: "model 'nomic-embed-text' not found" }, { status: 404 }),
    );
    await assert.rejects(ollamaEmbedQuery(endpoint)("test"), /HTTP 404.*ollama pull nomic-embed-text/i);
    request.mock.mockImplementation(async () => new Response("", { status: 503 }));
    await assert.rejects(ollamaEmbedQuery(endpoint)("test"), (error: Error) =>
      /HTTP 503/.test(error.message) && !error.message.includes("ollama pull"));
  });

  it("bounds each query embedding to 30 seconds, body included (PR #206 review round 1)", { timeout: 10_000 }, async (t) => {
    // A local server that sends its headers, then never finishes the body.
    const stalled = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    await listen(stalled);
    t.after(() => {
      stalled.closeAllConnections();
      return new Promise<void>((resolve) => stalled.close(() => resolve()));
    });
    const endpoint = `http://127.0.0.1:${(stalled.address() as { port: number }).port}`;
    const budgets: number[] = [];
    const timers: AbortController[] = [];
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      budgets.push(ms);
      const controller = new AbortController();
      timers.push(controller);
      return controller.signal;
    });
    // Fire the budget only once the headers are in, so only the body read is left to bound (round 5).
    const realFetch = loopbackTransport.fetch;
    t.mock.method(loopbackTransport, "fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await realFetch(...args);
      setTimeout(() => timers.at(-1)!.abort(new DOMException("The operation timed out.", "TimeoutError")), 10);
      return response;
    });
    for (const [query, name] of [[ollamaEmbedQuery(endpoint), "Ollama"], [loopbackEmbedQuery(endpoint), "The embedding server"]] as const) {
      const pending = query("test");
      await assert.rejects(pending, (error: Error) =>
        error.message === `${name} did not finish embedding the question within 30 seconds. Check that it is running, then ask again.`);
    }
    assert.deepEqual(budgets, [EMBEDDING_QUERY_TIMEOUT_MS, EMBEDDING_QUERY_TIMEOUT_MS]);
    assert.equal(EMBEDDING_QUERY_TIMEOUT_MS, 30_000);
  });

  it("never puts response text, which can echo the question, into an embedding error (PR #206 review round 1)", async (t) => {
    const question = "which devices does alice.private@contoso.com own";
    t.mock.method(loopbackTransport, "fetch", async (_url: Parameters<typeof fetch>[0], options?: RequestInit) =>
      new Response(`not json, you asked: ${String(options?.body)}`, { status: 200, headers: { "content-type": "application/json" } }),
    );
    for (const [query, name] of [[ollamaEmbedQuery("http://127.0.0.1:11434"), "Ollama"], [loopbackEmbedQuery("http://127.0.0.1:11434"), "The embedding server"]] as const) {
      await assert.rejects(query(question), (error: Error) => {
        const everything = `${error.message} ${String(error.cause ?? "")} ${error.stack ?? ""}`;
        assert.equal(error.message, `${name} answered the embedding request with something other than JSON. Check the local server, then ask again.`);
        assert.ok(!everything.includes("alice.private"), everything);
        return true;
      });
    }
  });

  it("names a dropped connection and a body that fails mid-read, never undici's bare message (PR #206 review round 1, Muse)", async (t) => {
    const dropped = () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    };
    const request = t.mock.method(loopbackTransport, "fetch", async () => dropped());
    for (const [query, name] of [[ollamaEmbedQuery("http://127.0.0.1:11434"), "Ollama"], [loopbackEmbedQuery("http://127.0.0.1:11434"), "The embedding server"]] as const) {
      await assert.rejects(query("test"), (error: Error) =>
        error.message === `${name} did not complete the embedding request (UND_ERR_SOCKET). Check the local server, then ask again.`);
    }
    request.mock.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new TypeError("terminated"));
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await assert.rejects(ollamaEmbedQuery("http://127.0.0.1:11434")("test"), (error: Error) =>
      /^Ollama did not complete the embedding request\b.*Check the local server, then ask again\.$/.test(error.message) && !/^terminated$/.test(error.message));
    request.mock.mockImplementation(async () => dropped());
    const state = await embeddingModelState("http://127.0.0.1:11434");
    assert.match(state.error ?? "", /^Could not read Ollama's model list \(UND_ERR_SOCKET\)\./);
  });

  it("connects only to a loopback IP address, so no resolver can send the question elsewhere (PR #206 review rounds 2 and 3)", async (t) => {
    // A localhost name is resolved by the operating system: it becomes 127.0.0.1 before any connection.
    assert.deepEqual(loopbackEndpoints("http://localhost:11434"), ["http://127.0.0.1:11434", "http://[::1]:11434"]);
    assert.deepEqual(loopbackEndpoints("http://LOCALHOST.:11434/"), ["http://127.0.0.1:11434", "http://[::1]:11434"]);
    for (const endpoint of ["http://127.0.0.1:11434", "http://[::1]:11434", "http://127.0.0.2:11434"]) {
      assert.deepEqual(loopbackEndpoints(endpoint), [endpoint]);
    }
    // An IPv4-mapped loopback address, which an OLLAMA_HOST may name, connects as its IPv4 literal (round 5).
    assert.deepEqual(loopbackEndpoints("http://[::ffff:127.0.0.1]:11434"), ["http://127.0.0.1:11434"]);
    assert.deepEqual(loopbackEndpoints("http://[::FFFF:7f00:2]:11434"), ["http://127.0.0.2:11434"]);
    assert.throws(() => loopbackEndpoints("http://[::ffff:10.0.0.5]:11434"), /Retrieval must stay local/);
    for (const endpoint of ["http://10.0.0.5:11434", "https://models.example.com", "http://localhost.example.com:11434", "http://ollama.local:11434", "http://user:pass@127.0.0.1:11434", "unix:///var/run/ollama.sock", "not a url"]) {
      assert.throws(() => loopbackEndpoints(endpoint), /Retrieval must stay local/, endpoint);
    }
    const urls: string[] = [];
    t.mock.method(loopbackTransport, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      urls.push(String(url));
      return Response.json({ embeddings: [[0.1]], data: [{ embedding: [0.1] }], models: [] });
    });
    await ollamaEmbedQuery("http://localhost.:11434")("test");
    await loopbackEmbedQuery("http://localhost:8081")("test");
    await embeddingModelState("http://localhost.:11434");
    assert.deepEqual(urls, ["http://127.0.0.1:11434/api/embed", "http://127.0.0.1:8081/v1/embeddings", "http://127.0.0.1:11434/api/tags"]);
  });

  it("reaches an Ollama on IPv6 only through localhost, by address, and names both addresses when neither answers (PR #206 review round 4)", async (t) => {
    const refused = () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    };
    const urls: string[] = [];
    const request = t.mock.method(loopbackTransport, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      urls.push(String(url));
      if (String(url).startsWith("http://127.0.0.1")) refused();
      return Response.json({ embeddings: [[0.1]], models: [{ name: "nomic-embed-text:latest" }] });
    });
    assert.deepEqual(await ollamaEmbedQuery("http://localhost:11434")("test"), [0.1]);
    assert.deepEqual(await embeddingModelState("http://localhost:11434"), { ollamaReachable: true, installed: true });
    assert.deepEqual(urls, ["http://127.0.0.1:11434/api/embed", "http://[::1]:11434/api/embed", "http://127.0.0.1:11434/api/tags", "http://[::1]:11434/api/tags"]);

    request.mock.mockImplementation(async () => refused());
    await assert.rejects(ollamaEmbedQuery("http://localhost:11434")("test"), (error: Error) =>
      error.message === "Ollama is not reachable at http://127.0.0.1:11434/api/embed or http://[::1]:11434/api/embed. Start the local server, then ask again.");
    assert.equal((await embeddingModelState("http://localhost:11434")).ollamaReachable, false);
  });

  it("treats a reset as a failed request, not a stopped server, and refuses a vector or model list it cannot use (PR #206 review round 2)", async (t) => {
    const reset = () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    };
    const request = t.mock.method(loopbackTransport, "fetch", async () => reset());
    await assert.rejects(ollamaEmbedQuery("http://127.0.0.1:11434")("test"), (error: Error) =>
      error.message === "Ollama did not complete the embedding request (ECONNRESET). Check the local server, then ask again.");
    const state = await embeddingModelState("http://127.0.0.1:11434");
    assert.notEqual(state.ollamaReachable, false);
    assert.match(state.error ?? "", /\(ECONNRESET\)/);

    request.mock.mockImplementation(async () => Response.json({ embeddings: [[0.1, "0.2"]] }));
    await assert.rejects(ollamaEmbedQuery("http://127.0.0.1:11434")("test"), /returned no vector/);
    // 1e400 parses as Infinity: a finite check, not only a type check, refuses it (round 5).
    request.mock.mockImplementation(async () => new Response('{"data":[{"embedding":[0.1,1e400]}]}', { headers: { "content-type": "application/json" } }));
    await assert.rejects(loopbackEmbedQuery("http://127.0.0.1:11434")("test"), /returned no embedding vector/);
    request.mock.mockImplementation(async () => Response.json({ models: [null] }));
    assert.match((await embeddingModelState("http://127.0.0.1:11434")).error ?? "", /^Ollama returned an invalid model list\./);
  });

  it("never sends a retrieval request through a proxy the global fetch or HTTP agent would use (PR #206 review round 6)", async (t) => {
    let hits = 0;
    const local = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embeddings: [[0.1]], models: [{ name: "nomic-embed-text:latest" }] }));
    });
    await listen(local);
    t.after(() => new Promise<void>((resolve) => local.close(() => resolve())));
    const endpoint = `http://127.0.0.1:${(local.address() as { port: number }).port}`;

    // What NODE_USE_ENV_PROXY installs: a global dispatcher (a proxy) for fetch, and proxying global agents.
    const key = Symbol.for("undici.globalDispatcher.1");
    const previous = (globalThis as Record<symbol, unknown>)[key];
    let proxied = 0;
    (globalThis as Record<symbol, unknown>)[key] = {
      dispatch() {
        proxied += 1;
        throw new Error("sent to the proxy");
      },
    };
    t.after(() => {
      (globalThis as Record<symbol, unknown>)[key] = previous;
    });
    // addRequest is how a request joins an agent; it is not in the typings.
    t.mock.method(httpGlobalAgent as unknown as { addRequest: () => void }, "addRequest", () => {
      proxied += 1;
      throw new Error("sent through the global agent");
    });
    // The stand-in is in effect: the global fetch would go through it.
    await assert.rejects(fetch(`${endpoint}/api/tags`));
    assert.equal(proxied, 1);

    assert.deepEqual(await ollamaEmbedQuery(endpoint)("test"), [0.1]);
    assert.deepEqual(await embeddingModelState(endpoint), { ollamaReachable: true, installed: true });
    await pullEmbeddingModel(endpoint);
    assert.equal(proxied, 1);
    assert.equal(hits, 3);
  });

  it("decodes a compressed answer as fetch did, for the embedding, the model check and a failed pull (PR #206 review round 7)", async (t) => {
    const answers: Record<string, { status: number; body: unknown }> = {
      "/api/embed": { status: 200, body: { embeddings: [[0.1]] } },
      "/api/tags": { status: 200, body: { models: [{ name: "nomic-embed-text:latest" }] } },
      "/api/pull": { status: 500, body: { error: "pull model manifest: registry unreachable" } },
    };
    // "deflate raw" is a deflate body without its zlib wrapper, which fetch also accepts (PR #206 review round 8).
    let encodings = ["gzip", "deflate", "deflate raw", "br"];
    const server = createServer((request, response) => {
      const encoding = encodings[0]!;
      const answer = answers[request.url ?? ""]!;
      const raw = Buffer.from(JSON.stringify(answer.body));
      const packed = encoding === "gzip" ? gzipSync(raw) : encoding === "deflate" ? deflateSync(raw) : encoding === "deflate raw" ? deflateRawSync(raw) : brotliCompressSync(raw);
      response.writeHead(answer.status, { "content-type": "application/json", "content-encoding": encoding.split(" ")[0]!, "content-length": packed.length }).end(packed);
    });
    await listen(server);
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (; encodings.length > 0; encodings = encodings.slice(1)) {
      assert.deepEqual(await ollamaEmbedQuery(endpoint)("test"), [0.1], encodings[0]);
      assert.deepEqual(await embeddingModelState(endpoint), { ollamaReachable: true, installed: true }, encodings[0]);
      await assert.rejects(pullEmbeddingModel(endpoint), /Ollama pull failed: pull model manifest: registry unreachable/, encodings[0]);
    }
  });

  it("dials localhost by address but sends the name it was given as Host, as fetch did (PR #206 review round 8)", async (t) => {
    const hosts: string[] = [];
    const server = createServer((request, response) => {
      hosts.push(`${request.url} ${request.headers.host}`);
      const body = request.url === "/api/tags"
        ? { models: [{ name: "nomic-embed-text:latest" }] }
        : request.url === "/v1/embeddings"
          ? { data: [{ embedding: [0.1] }] }
          : request.url === "/api/pull"
            ? { status: "success" }
            : { embeddings: [[0.1]] };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await listen(server);
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    await ollamaEmbedQuery(`http://localhost:${port}`)("test");
    await loopbackEmbedQuery(`http://localhost:${port}`)("test");
    await embeddingModelState(`http://localhost:${port}`);
    await pullEmbeddingModel(`http://localhost:${port}`);
    await ollamaEmbedQuery(`http://127.0.0.1:${port}`)("test");
    assert.deepEqual(hosts, [
      `/api/embed localhost:${port}`,
      `/v1/embeddings localhost:${port}`,
      `/api/tags localhost:${port}`,
      `/api/pull localhost:${port}`,
      `/api/embed 127.0.0.1:${port}`,
    ]);
  });

  it("keeps the dialled address as Host over HTTPS, where Node checks the certificate against it (PR #206 review round 9)", async (t) => {
    const sent: Array<string | null> = [];
    t.mock.method(loopbackTransport, "fetch", async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      sent.push(new Headers(options?.headers).get("host"));
      return new Response(JSON.stringify({ embeddings: [[0.1]] }), { status: 200 });
    });
    await ollamaEmbedQuery("https://localhost:8443")("test");
    await ollamaEmbedQuery("http://localhost:8443")("test");
    assert.deepEqual(sent, [null, "localhost:8443"]);
  });

  it("stops decoding a compressed answer when its budget runs out, also after the connection has closed (PR #206 review round 9)", async (t) => {
    // Decoded, the body is far larger than the stream buffers, so most of it is still being decoded when the budget runs out.
    const raw = Buffer.from(JSON.stringify({ embeddings: [new Array(2_000_000).fill(0)] }));
    const bodies: Record<string, Buffer> = { gzip: gzipSync(raw), deflate: deflateSync(raw), "deflate raw": deflateRawSync(raw) };
    let encoding = "gzip";
    const server = createServer((_request, response) => {
      const packed = bodies[encoding]!;
      response.writeHead(200, { "content-type": "application/json", "content-encoding": encoding.split(" ")[0]!, "content-length": packed.length }).end(packed);
    });
    await listen(server);
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/embed`;
    for (encoding of Object.keys(bodies)) {
      const budget = new AbortController();
      const response = await directFetch(url, { signal: budget.signal });
      await new Promise((resolve) => setTimeout(resolve, 200));
      budget.abort(new DOMException("The budget ran out.", "TimeoutError"));
      await assert.rejects(response.text(), (error: Error) => error.name === "TimeoutError", encoding);
    }
  });

  it("fails a model pull that stalls before its answer or while sending it, with the reason (PR #206 review round 7)", { timeout: 10_000 }, async (t) => {
    let mode: "before" | "during" = "before";
    const server = createServer((_request, response) => {
      if (mode === "during") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      }
      // Otherwise nothing: no headers at all.
    });
    await listen(server);
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const previous = loopbackTransport.idleTimeoutMs;
    loopbackTransport.idleTimeoutMs = 100;
    t.after(() => {
      loopbackTransport.idleTimeoutMs = previous;
    });
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const stopped = /Ollama stopped answering while downloading nomic-embed-text\. Check that Ollama is running, then restart OpenAdminOS to download it again\.$/;
    await assert.rejects(pullEmbeddingModel(endpoint), stopped);
    mode = "during";
    await assert.rejects(pullEmbeddingModel(endpoint), stopped);
    assert.equal(previous, 300_000);
  });

  it("searches the documentation at the same endpoint Settings checks, also when OLLAMA_HOST moved Ollama (PR #206 review round 1)", async (t) => {
    let hits = 0;
    const moved = createServer((request, response) => {
      hits += 1;
      assert.equal(request.url, "/api/embed");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embeddings: [[1, 0]] }));
    });
    await listen(moved);
    t.after(() => new Promise<void>((resolve) => moved.close(() => resolve())));
    const previous = { endpoint: process.env.OPENADMINOS_EMBEDDING_ENDPOINT, host: process.env.OLLAMA_HOST };
    delete process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
    process.env.OLLAMA_HOST = `127.0.0.1:${(moved.address() as { port: number }).port}`;
    t.after(() => {
      for (const [key, value] of [["OPENADMINOS_EMBEDDING_ENDPOINT", previous.endpoint], ["OLLAMA_HOST", previous.host]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "openadminos-embedding-endpoint-"));
    const indexDir = join(dir, "retrieval-index");
    await mkdir(indexDir);
    await writeFile(join(indexDir, "index-meta.json"), JSON.stringify({ dim: 2, embeddingModel: "nomic-embed-text-v1.5", builtAt: "2026-08-29T00:00:00.000Z", chunkCount: 1 }));
    await writeFile(join(indexDir, "chunks.jsonl"), `${JSON.stringify({ file: "a.md", text: "a" })}\n`);
    await writeFile(join(indexDir, "embeddings.f32"), Buffer.from(new Float32Array([1, 0]).buffer));
    const store = new AppStateStore({
      filePath: join(dir, "state.json"),
      userDataPath: dir,
      statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
    });
    // Close the store before removing its folder: it may still be writing its state file.
    t.after(async () => {
      await store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    });
    const passages = await store.retrieveDocumentation("question");
    assert.equal(passages.length, 1);
    assert.equal(hits, 1);
  });
});
