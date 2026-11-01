import assert from "node:assert/strict";
import { it } from "node:test";
import { probeSubscribedSkus } from "./entra-tier.js";

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

it("keeps unavailable licence inventories unknown and requires active Intune plans", async () => {
  for (const response of [new Response("Forbidden", { status: 403 }), Response.json({}), Response.json({ value: "invalid" })]) {
    assert.equal(await probeSubscribedSkus(async () => "token", undefined, (async () => response) as typeof fetch), null);
  }
  const result = await probeSubscribedSkus(async () => "token", undefined, (async () => Response.json({ value: [
    { capabilityStatus: "Suspended", servicePlans: [{ servicePlanName: "INTUNE_A", provisioningStatus: "Success" }] },
    { capabilityStatus: "Enabled", servicePlans: [{ servicePlanName: "INTUNE_A", provisioningStatus: "PendingActivation" }] },
  ] })) as typeof fetch);
  assert.equal(result?.intuneLicensed, false);
});
