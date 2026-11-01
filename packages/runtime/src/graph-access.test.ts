import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyGraphAccessDenied, graphAccessDenialFromError, graphAccessDenialText } from "@openadminos/agent-sdk";

describe("Graph access denial classification", () => {
  const users = { path: "/users", requiredScopes: ["User.Read.All"] };

  it("requires actual token evidence before recommending consent", () => {
    const denial = classifyGraphAccessDenied({ ...users, grantedScopes: ["AuditLog.Read.All"] });
    assert.equal(denial.cause, "missing-consent");
    assert.deepEqual(denial.missingScopes, ["User.Read.All"]);
    assert.equal(denial.message, "Microsoft Graph denied access to GET /users (HTTP 403). The access token does not include User.Read.All.");
    assert.equal(denial.recovery, "Reconnect this tenant to grant User.Read.All, or forward the required scopes to an administrator who can grant consent, then retry.");
    assert.equal(classifyGraphAccessDenied({ ...users, grantedScopes: [] }).cause, "missing-consent");
  });

  it("keeps Graph's own message for diagnosis, collapsed and bounded", () => {
    const denial = classifyGraphAccessDenied({ ...users, grantedScopes: ["User.Read.All"], graphMessage: "Insufficient privileges\n to complete the operation." });
    assert.equal(denial.cause, "missing-role");
    assert.match(denial.message, /Graph said: "Insufficient privileges to complete the operation\."$/);
    const long = classifyGraphAccessDenied({ ...users, graphMessage: "x".repeat(500) });
    assert.ok(long.message.length < 600);
    assert.doesNotMatch(classifyGraphAccessDenied({ ...users, graphMessage: "  " }).message, /Graph said/);
  });

  it("uses the documented non-premium error code, including B2C uncertainty", () => {
    const denial = classifyGraphAccessDenied({ path: "/auditLogs/signIns", errorCode: "Authentication_RequestFromNonPremiumTenantOrB2CTenant" });
    assert.equal(denial.cause, "missing-licence");
    assert.equal(denial.requiredLicence, "Microsoft Entra ID P1 or P2");
    assert.match(denial.message, /non-premium or Azure AD B2C/);
    assert.doesNotMatch(graphAccessDenialText(denial), /reconnect/i);
  });

  it("uses the existing Entra tier and Intune service-plan inventory", () => {
    for (const [path, entraTier, intuneLicensed, licence] of [
      ["/auditLogs/signIns", "free", undefined, "Microsoft Entra ID P1 or P2"],
      ["/identityProtection/riskyUsers", "p1", undefined, "Microsoft Entra ID P2"],
      ["/identityProtection/riskDetections", "free", undefined, "Microsoft Entra ID P2"],
      ["/deviceManagement/managedDevices", "p2", false, "Microsoft Intune"],
      ["/deviceAppManagement/mobileApps", "p2", false, "Microsoft Intune"],
    ] as const) {
      const denial = classifyGraphAccessDenied({ path, entraTier, intuneLicensed });
      assert.equal(denial.cause, "missing-licence");
      assert.equal(denial.requiredLicence, licence);
      assert.doesNotMatch(graphAccessDenialText(denial), /reconnect/i);
    }
    assert.equal(classifyGraphAccessDenied({ path: "/users", entraTier: "free", intuneLicensed: false }).cause, "unknown");
    assert.equal(classifyGraphAccessDenied({ path: "/auditLogs/signIns", entraTier: "unknown" }).cause, "unknown");
  });

  it("names role recovery when the endpoint scope is granted", () => {
    const denial = classifyGraphAccessDenied({ ...users, grantedScopes: ["User.Read.All"] });
    assert.equal(denial.cause, "missing-role");
    assert.equal(denial.message, "Microsoft Graph denied access to GET /users (HTTP 403). The required delegated scope is granted, but your account does not have access to this resource.");
    assert.match(denial.recovery, /Global Reader/);
    assert.doesNotMatch(graphAccessDenialText(denial), /reconnect/i);
    for (const [path, role] of [["/deviceManagement/managedDevices", "Read Only Operator"], ["/auditLogs/signIns", "Security Reader"], ["/identity/conditionalAccess/policies", "Conditional Access Administrator"]]) {
      const result = classifyGraphAccessDenied({ ...users, path, grantedScopes: ["User.Read.All"] });
      assert.ok(result.recovery.includes(role!));
      assert.doesNotMatch(result.recovery, /reconnect/i);
    }
  });

  it("accepts documented broader scopes and alternatives, without inferring consent from the requested set", () => {
    for (const scope of ["User.ReadWrite.All", "Directory.Read.All", "https://graph.microsoft.com/User.Read.All"]) {
      assert.equal(classifyGraphAccessDenied({ ...users, grantedScopes: [scope] }).cause, "missing-role");
    }
    assert.equal(classifyGraphAccessDenied({ ...users, requiredScopes: ["User.Read.All", "Directory.Read.All"], grantedScopes: ["User.Read.All"] }).cause, "missing-role");
    assert.equal(classifyGraphAccessDenied(users).cause, "unknown");
    assert.equal(classifyGraphAccessDenied({ grantedScopes: ["User.Read.All"] }).cause, "unknown");
  });

  it("explains uncertainty for legacy failures and claims-policy challenges", () => {
    const denial = graphAccessDenialFromError("Graph responded with HTTP 403: reconnect to grant scopes")!;
    assert.equal(denial.cause, "unknown");
    assert.match(denial.message, /cannot determine the cause/);
    assert.match(denial.message, /missing consent.*role.*licence.*policy/);
    assert.doesNotMatch(graphAccessDenialText(denial), /reconnect/i);
    assert.equal(classifyGraphAccessDenied({ ...users, grantedScopes: ["User.Read.All"], errorCode: "insufficient_claims" }).cause, "unknown");
    assert.equal(graphAccessDenialFromError("HTTP 429"), undefined);
  });

  it("never recommends a read-only role for a write action", () => {
    const denial = classifyGraphAccessDenied({ path: "/deviceManagement/managedDevices/test/retire", method: "POST", requiredScopes: ["DeviceManagementManagedDevices.ReadWrite.All"], grantedScopes: ["DeviceManagementManagedDevices.ReadWrite.All"] });
    assert.match(denial.recovery, /Intune Administrator/);
    assert.doesNotMatch(denial.recovery, /Global Reader|Read Only Operator|reconnect/i);
  });
});
