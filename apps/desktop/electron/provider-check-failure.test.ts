import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { providerCatalog } from "@openadminos/agent-sdk";
import { checkLemonade, checkLmStudio, checkOllama } from "./provider-detail.js";
import { scanProbeFromProvider } from "./model-scan.js";

const checks = [
  { id: "ollama", name: "Ollama", check: checkOllama, env: "OPENAGENTS_OLLAMA_URL", port: 11434, path: "", list: "models" },
  { id: "lm-studio", name: "LM Studio", check: checkLmStudio, env: "OPENADMINOS_LM_STUDIO_URL", port: 1234, path: "/v1", list: "data" },
  { id: "lemonade", name: "Lemonade", check: checkLemonade, env: "OPENADMINOS_LEMONADE_URL", port: 13305, path: "/v1", list: "data" },
] as const;

const coded = (code: string) => Object.assign(new Error(code), { code });
const fetchFailed = (cause: unknown) => new TypeError("fetch failed", { cause });

function failFetch(error: unknown): void {
  mock.method(globalThis, "fetch", async () => { throw error; });
}

afterEach(() => mock.restoreAll());

for (const { id, name, check, env, port, path, list } of checks) {
  describe(`${name} check failures`, () => {
    const provider = providerCatalog.find((entry) => entry.id === id)!;
    const endpoint = `http://127.0.0.1:${port}${path}`;
    async function run(address: string | null = endpoint, options?: Parameters<typeof check>[1]) {
      const previous = process.env[env];
      const previousHost = process.env.OLLAMA_HOST;
      if (address === null) {
        delete process.env[env];
        if (id === "ollama") delete process.env.OLLAMA_HOST;
      } else {
        process.env[env] = address;
      }
      try {
        return await check(provider, options);
      } finally {
        if (previous === undefined) delete process.env[env];
        else process.env[env] = previous;
        if (id === "ollama" && previousHost !== undefined) process.env.OLLAMA_HOST = previousHost;
      }
    }
    async function expectFailure(
      expected: RegExp,
      address = endpoint,
      options?: Parameters<typeof check>[1],
    ) {
      const result = await run(address, options);
      assert.equal(result.status, "error");
      assert.equal(result.checkFailed, true);
      assert.equal(scanProbeFromProvider(result).state, "could-not-check");
      assert.deepEqual(result.models, []);
      assert.ok(result.detail?.includes(`${name} on ${address}`), result.detail);
      assert.match(result.detail!, expected);
      return result.detail!;
    }

    it("names the blocked port and the endpoint override using real fetch on port 1", async () => {
      const detail = await expectFailure(/port 1 is blocked/, `http://127.0.0.1:1${path}`);
      assert.ok(detail.includes(`${name}'s default port is ${port}.`));
      assert.ok(detail.includes(env));
    });

    it("gives recovery for the default endpoint without naming an environment variable", async () => {
      failFetch(new TypeError("fetch failed"));
      const result = await run(null);
      assert.equal(result.status, "error");
      assert.equal(result.checkFailed, true);
      assert.ok(result.detail?.includes(`${name} on ${endpoint}`), result.detail);
      assert.match(result.detail!, /Check that the server is running at that address, then try again\./);
      assert.doesNotMatch(result.detail!, /OPENAGENTS_OLLAMA_URL|OLLAMA_HOST|OPENADMINOS_LM_STUDIO_URL|OPENADMINOS_LEMONADE_URL/);
    });

    it("keeps a refused local server in the not-installed state", async () => {
      failFetch(fetchFailed(coded("ECONNREFUSED")));
      const result = await run();
      assert.equal(result.status, "not-installed");
      assert.equal(result.checkFailed, undefined);
      assert.ok(result.detail?.startsWith(`The connection to ${name} on ${endpoint} was refused. Start`), result.detail);
    });

    it("reports a remote refusal as a failed check", async () => {
      failFetch(fetchFailed(coded("ECONNREFUSED")));
      await expectFailure(/was refused\. Check .*_URL, then try again/, `http://models.example.test:${port}${path}`);
    });

    const transportFailures: Array<[string, unknown, RegExp]> = [
      ["host name not found", fetchFailed(coded("ENOTFOUND")), /could not be resolved\. Check DNS/],
      ["temporary DNS failure", fetchFailed(coded("EAI_AGAIN")), /could not be resolved\. Check DNS/],
      ["network unreachable", fetchFailed(coded("ENETUNREACH")), /route to .* is unavailable\. Check the address/],
      ["host unreachable", fetchFailed(coded("EHOSTUNREACH")), /route to .* is unavailable\. Check the address/],
      ["connection reset", fetchFailed(coded("ECONNRESET")), /was interrupted\. Check that the server is running/],
      ["TLS certificate", fetchFailed(coded("SELF_SIGNED_CERT_IN_CHAIN")), /could not be verified\. Check the certificate/],
      ["TLS handshake", fetchFailed(coded("ERR_SSL_WRONG_VERSION_NUMBER")), /failed\. Check that the URL scheme/],
      ["proxy tunnel", fetchFailed(new Error("Proxy response (502) !== 200", { cause: coded("ECONNRESET") })), /A proxy connection failed.*Check proxy and bypass settings/],
      ["TLS proxy", fetchFailed(new Error("Proxy certificate failed", { cause: Object.assign(coded("UND_ERR_PRX_TLS"), { cause: coded("CERT_HAS_EXPIRED") }) })), /A proxy connection failed.*Check proxy and bypass settings/],
      ["proxy authentication", fetchFailed(new Error("Proxy response (407) !== 200")), /A proxy asked for credentials.*Check proxy authentication/],
      ["offline", fetchFailed(new Error("ERR_INTERNET_DISCONNECTED")), /offline\. Connect to a network/],
      ["request timeout", new DOMException("The operation was aborted", "AbortError"), /did not answer in time\. Check that the server/],
      ["connect timeout", fetchFailed(coded("UND_ERR_CONNECT_TIMEOUT")), /did not answer in time\. Check that the server/],
      ["multiple addresses", fetchFailed(new AggregateError([coded("ECONNREFUSED"), coded("ETIMEDOUT")])), /did not answer in time/],
      ["unclassified fetch failure", new TypeError("fetch failed"), /OpenAdminOS could not connect.*then try again/],
    ];
    for (const [label, error, expected] of transportFailures) {
      it(`reports ${label} as a failed check`, async () => {
        failFetch(error);
        const detail = await expectFailure(expected);
        assert.doesNotMatch(detail, /answered with a response/);
      });
    }

    it("describes a stopped check", async () => {
      const controller = new AbortController();
      controller.abort();
      await expectFailure(/was stopped\. Try again/, endpoint, { signal: controller.signal });
    });

    it("includes the HTTP status when the model list is unreadable", async () => {
      const responses = [
        new Response("bad port and an endpoint response body", { status: 202 }),
        Response.json({ unrelated: [] }, { status: 202 }),
        Response.json({ [list]: [null] }, { status: 202 }),
      ];
      const fetch = mock.method(globalThis, "fetch", async () => responses.shift());
      for (let index = 0; index < 3; index++) {
        const detail = await expectFailure(/answered with a response OpenAdminOS could not read \(HTTP 202\)\. Check that the endpoint serves/);
        assert.doesNotMatch(detail, /response body|bad port/);
      }
      assert.equal(fetch.mock.callCount(), 3);
    });

    it("keeps an interrupted body read distinct from invalid JSON", async () => {
      const stream = new ReadableStream({ start(controller) { controller.error(fetchFailed(coded("ECONNRESET"))); } });
      mock.method(globalThis, "fetch", async () => new Response(stream));
      const detail = await expectFailure(/was interrupted/);
      assert.doesNotMatch(detail, /answered with a response/);
    });

    it("gives distinct recovery for an HTTP error and for an authenticating proxy", async () => {
      const responses = [new Response(null, { status: 503 }), new Response(null, { status: 407 })];
      mock.method(globalThis, "fetch", async () => responses.shift());
      await expectFailure(/responded with HTTP 503\. Check the server address and configuration/);
      await expectFailure(/A proxy asked for credentials.*\(HTTP 407\)\. Check proxy authentication/);
    });
  });
}

it("points Ollama's blocked port recovery at OLLAMA_HOST when it supplied the endpoint", async () => {
  const previousOverride = process.env.OPENAGENTS_OLLAMA_URL;
  const previousHost = process.env.OLLAMA_HOST;
  delete process.env.OPENAGENTS_OLLAMA_URL;
  process.env.OLLAMA_HOST = "127.0.0.1:1";
  try {
    const result = await checkOllama(providerCatalog.find((entry) => entry.id === "ollama")!);
    assert.equal(result.status, "error");
    assert.match(result.detail!, /port 1 is blocked\. Ollama's default port is 11434\. Set OLLAMA_HOST/);
  } finally {
    if (previousOverride !== undefined) process.env.OPENAGENTS_OLLAMA_URL = previousOverride;
    if (previousHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previousHost;
  }
});
