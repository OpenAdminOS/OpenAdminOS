import assert from "node:assert/strict";
import { it } from "node:test";
import { detectEntraTier, probeSubscribedSkus, SubscribedSkusProbeError } from "./entra-tier.js";

it("reuses the existing subscribed-SKU request for Intune licence evidence", async () => {
  const calls: string[] = [];
  const result = await probeSubscribedSkus(async scopes => {
    assert.deepEqual(scopes, ["Organization.Read.All"]);
    return "token";
  }, undefined, (async url => {
    calls.push(String(url));
    return Response.json({ value: [{ skuPartNumber: "EMS", capabilityStatus: "Enabled", servicePlans: [
      { servicePlanName: "AAD_PREMIUM", provisioningStatus: "Success" },
      { servicePlanName: "INTUNE_A", provisioningStatus: "Success" },
    ] }] });
  }) as typeof fetch);
  assert.equal(result?.tier, "p1");
  assert.equal(result?.intuneLicensed, true);
  assert.deepEqual(calls, ["https://graph.microsoft.com/beta/subscribedSkus"]);
});

it("reports why the licence read failed instead of an empty inventory", async () => {
  const cases: Array<[string, () => Promise<Response>, Record<string, unknown>]> = [
    ["HTTP 403", async () => new Response("Forbidden", { status: 403 }), { reason: "http", status: 403, message: "Microsoft Graph answered /subscribedSkus with HTTP 403." }],
    ["HTTP 503", async () => new Response("Unavailable", { status: 503 }), { reason: "http", status: 503 }],
    ["no value", async () => Response.json({}), { reason: "malformed" }],
    ["value not a list", async () => Response.json({ value: "invalid" }), { reason: "malformed" }],
    ["not JSON", async () => new Response("<html>", { status: 200 }), { reason: "malformed" }],
    ["network error", async () => { throw new TypeError("fetch failed"); }, { reason: "network", message: "Microsoft Graph could not be reached for /subscribedSkus: fetch failed" }],
  ];
  for (const [label, respond, expected] of cases) {
    await assert.rejects(
      probeSubscribedSkus(async () => "token", undefined, respond as typeof fetch),
      (error: unknown) => {
        assert.ok(error instanceof SubscribedSkusProbeError, label);
        for (const [key, value] of Object.entries(expected)) {
          assert.equal((error as unknown as Record<string, unknown>)[key], value, `${label}: ${key}`);
        }
        return true;
      },
    );
    assert.equal(await detectEntraTier(async () => "token", undefined, respond as typeof fetch), "unknown", label);
  }
});

it("passes token errors through unchanged", async () => {
  class SignInCancelled extends Error {}
  const cancelled = new SignInCancelled("Tenant sign-in was cancelled.");
  await assert.rejects(
    probeSubscribedSkus(async () => { throw cancelled; }, undefined, (async () => Response.json({ value: [] })) as typeof fetch),
    (error: unknown) => error === cancelled,
  );
});

it("stops waiting when Graph does not answer in time or the caller aborts", async () => {
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  await assert.rejects(
    probeSubscribedSkus(async () => "token", undefined, hang, { timeoutMs: 20 }),
    { name: "SubscribedSkusProbeError", reason: "timeout" },
  );
  const controller = new AbortController();
  const reason = new Error("Check cancelled.");
  const pending = probeSubscribedSkus(async () => "token", undefined, hang, { signal: controller.signal });
  setTimeout(() => controller.abort(reason), 5);
  await assert.rejects(pending, (error: unknown) => error === reason);
});

it("requires active Intune plans", async () => {
  const result = await probeSubscribedSkus(async () => "token", undefined, (async () => Response.json({ value: [
    { capabilityStatus: "Suspended", servicePlans: [{ servicePlanName: "INTUNE_A", provisioningStatus: "Success" }] },
    { capabilityStatus: "Enabled", servicePlans: [{ servicePlanName: "INTUNE_A", provisioningStatus: "PendingActivation" }] },
  ] })) as typeof fetch);
  assert.equal(result?.intuneLicensed, false);
});
