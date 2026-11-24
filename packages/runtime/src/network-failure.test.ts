import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyNetworkFailure } from "./network-failure.js";

function failedAddresses(...codes: string[]): TypeError {
  const errors = codes.map((code) => Object.assign(new Error(code), { code }));
  return new TypeError("fetch failed", { cause: new AggregateError(errors) });
}

describe("classifyNetworkFailure", () => {
  for (const code of ["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]) {
    it("prefers a refusal when another loopback address reports " + code, () => {
      assert.equal(classifyNetworkFailure(failedAddresses(code, "ECONNREFUSED"), true), "refused");
      assert.equal(classifyNetworkFailure(failedAddresses(code, "ECONNREFUSED")), "unreachable");
    });
  }

  it("reports refusal when all loopback addresses refuse the connection", () => {
    assert.equal(classifyNetworkFailure(failedAddresses("ECONNREFUSED", "ECONNREFUSED"), true), "refused");
  });

  it("recognizes Chromium and proxy error names in messages and codes", () => {
    for (const code of ["ERR_PROXY_CONNECTION_FAILED", "ERR_PROXY"]) {
      assert.equal(classifyNetworkFailure(new Error("net::" + code, { cause: failedAddresses("ECONNRESET") })), "proxy");
      assert.equal(classifyNetworkFailure({ code }), "proxy");
    }
    assert.equal(classifyNetworkFailure(new Error("net::ERR_CONNECTION_TIMED_OUT")), "timeout");
    assert.equal(classifyNetworkFailure({ code: "ERR_CONNECTION_TIMED_OUT" }), "timeout");
  });
});
