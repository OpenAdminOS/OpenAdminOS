import assert from "node:assert/strict";
import { it } from "node:test";
import { searchPublicWeb, publicSourceUrl, WEB_SEARCH_MODEL } from "./web-search.js";
const payload = () => ({ status: "completed", output: [
  { type: "web_search_call", status: "completed" },
  { type: "message", content: [{ type: "output_text", text: "Verified public facts.", annotations: [
    { type: "url_citation", title: "Vendor documentation", url: "https://learn.microsoft.com/public-page" },
    { type: "url_citation", title: "Invalid", url: "javascript:alert(1)" },
  ] }] },
] });
const signal = () => new AbortController().signal;
it("uses hosted Responses search, only sends the public query, and extracts cited sources", async () => {
  const result = await searchPublicWeb("Microsoft Intune recent announcements", "test-key", signal(), async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, WEB_SEARCH_MODEL);
    assert.equal(body.input, "Microsoft Intune recent announcements");
    assert.equal(body.store, false);
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    assert.equal(body.tool_choice, "required");
    assert.equal(init?.redirect, "error");
    return Response.json(payload());
  });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, "https://learn.microsoft.com/public-page");
  assert.ok(result.searchedAt);
});
it("rejects empty, oversized and obviously private queries before network access", async () => {
  for (const query of ["", "a".repeat(1001), "admin@contoso.com", "tenant 12345678-1234-1234-1234-123456789012", "IP 10.1.1.1", "Bearer secret"]) {
    await assert.rejects(searchPublicWeb(query, "test-key", signal(), async () => { assert.fail("Network should not run"); }));
  }
});
it("never treats missing search evidence, truncated output or missing citations as verified", async () => {
  for (const body of [
    null, { status: "completed", output: [null] },
    { ...payload(), status: "incomplete" },
    { ...payload(), output: payload().output.slice(1) },
    { status: "completed", output: [{ type: "web_search_call", status: "completed" }] },
  ]) await assert.rejects(searchPublicWeb("public question", "test-key", signal(), async () => Response.json(body)), /did not complete|no cited evidence/);
});
it("reports actionable API failure without returning vendor body or credentials", async () => {
  for (const status of [401, 403, 429, 500])
    await assert.rejects(searchPublicWeb("public question", "test-key", signal(), async () => new Response("sensitive vendor body", { status })), error => {
      assert.match((error as Error).message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch((error as Error).message, /sensitive|test-key/);
      return true;
    });
});
it("bounds response bodies and propagates cancellation", async () => {
  await assert.rejects(searchPublicWeb("public question", "test-key", signal(), async () => new Response("x".repeat(1024 * 1024 + 1))), /too much data/);
  const controller = new AbortController();
  const pending = searchPublicWeb("public question", "test-key", controller.signal, async (_url, init) => {
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
it("only retains public HTTPS citation destinations", () => {
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://127.0.0.1", "https://localhost", "https://server.local", "https://[::1]"])
    assert.equal(publicSourceUrl(url), undefined);
});
