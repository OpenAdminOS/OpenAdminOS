import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GraphAccessDeniedError } from "@openadminos/agent-sdk";

import { runFailureAccessDenial } from "./run-failure-access.js";

describe("runFailureAccessDenial", () => {
  it("does not read a 403 in what Ollama said as a Graph denial", () => {
    const error = new Error("Ollama could not load gpt-oss:20b with the 45,056 token context size kept from an earlier request, usually because free memory ran out. The next request starts from Ollama's default context size. Ollama said: cudaMalloc failed: out of memory (403 MiB)");
    assert.equal(runFailureAccessDenial(error), undefined);
  });

  it("still reads a 403 in the app's own words", () => {
    assert.ok(runFailureAccessDenial(new Error("Graph responded with HTTP 403: reconnect to grant scopes")));
  });

  it("keeps a typed Graph denial", () => {
    const typed = new GraphAccessDeniedError({ path: "/users", requiredScopes: ["User.Read.All"], grantedScopes: [] });
    assert.deepEqual(runFailureAccessDenial(typed), typed.accessDenial);
  });
});
