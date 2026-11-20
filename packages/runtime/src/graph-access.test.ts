import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyGraphAccessDenied, errorComesFromGraph, GraphAccessDeniedError, graphAccessDenialFromError, graphAccessDenialFromStoredText, graphAccessDenialText, storedGraphAccessDenial, ConnectorRemoteError, ConnectorScopeError } from "@openadminos/agent-sdk";

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
    const denial = graphAccessDenialFromStoredText("Graph responded with HTTP 403 for https://graph.microsoft.com/v1.0/users: reconnect to grant scopes")!;
    assert.equal(denial.cause, "unknown");
    assert.match(denial.message, /cannot determine the cause/);
    assert.match(denial.message, /missing consent.*role.*licence.*policy/);
    assert.doesNotMatch(graphAccessDenialText(denial), /reconnect/i);
    assert.equal(classifyGraphAccessDenied({ ...users, grantedScopes: ["User.Read.All"], errorCode: "insufficient_claims" }).cause, "unknown");
    assert.equal(graphAccessDenialFromError("HTTP 429"), undefined);
  });

  it("classifies only errors that come from Microsoft Graph", () => {
    // Bodies as Graph returned them for a real 403 (verified 2026-11-19).
    const forbidden = '{"error":{"code":"Forbidden","message":"You cannot perform the requested operation, required scopes are missing in the token.","innerError":{"date":"2026-11-20T02:51:48"}}}';
    const accessDenied = '{"error":{"code":"accessDenied","message":"Request Authorization failed","innerError":{"date":"2026-11-20T02:52:02"}}}';
    for (const [raw, code] of [
      [`Graph responded with HTTP 403 for https://graph.microsoft.com/v1.0/identityProtection/riskyUsers: ${forbidden}`, "Forbidden"],
      [`Graph responded with HTTP 403 for https://graph.microsoft.com/v1.0/users/1/authentication/methods: ${accessDenied}`, "accessDenied"],
    ] as const) {
      assert.equal(errorComesFromGraph(raw), true);
      const denial = graphAccessDenialFromStoredText(raw)!;
      assert.equal(denial.cause, "unknown");
      assert.equal(denial.title, "Graph access cause unverified");
      assert.match(raw, new RegExp(code));
    }
    assert.equal(graphAccessDenialFromStoredText("Microsoft Graph rejected the request (HTTP 403). The signed-in admin lacks the required Teams scopes.")?.cause, "unknown");
    assert.equal(graphAccessDenialFromStoredText("Microsoft Graph rejected the Outlook request (HTTP 403). The signed-in admin lacks Mail.Send.")?.cause, "unknown");
    assert.equal(graphAccessDenialFromStoredText("Microsoft Graph answered /subscribedSkus with HTTP 403.")?.cause, "unknown");
    assert.equal(graphAccessDenialFromStoredText("Graph responded with HTTP 404 for https://graph.microsoft.com/v1.0/users/x: {}"), undefined);
    assert.equal(graphAccessDenialFromStoredText('Graph responded with HTTP 403 for https://graph.microsoft.com/beta/auditLogs/signIns: {"error":{"code":"Authentication_RequestFromNonPremiumTenantOrB2CTenant"}}', { path: "/auditLogs/signIns" })?.cause, "missing-licence");
    assert.equal(classifyGraphAccessDenied({}).source, "microsoft-graph");
    // A stored denial's own text still reads as a Graph error.
    const stored = graphAccessDenialText(classifyGraphAccessDenied({ ...users, grantedScopes: [] }));
    assert.equal(errorComesFromGraph(stored), true);
    assert.equal(graphAccessDenialFromStoredText(stored)?.cause, "unknown");
    // An agent that wraps the Graph error keeps its evidence.
    const thrown = new GraphAccessDeniedError({ ...users, grantedScopes: [] });
    assert.equal(graphAccessDenialFromError(new Error("Listing users failed.", { cause: thrown }))?.cause, "missing-consent");
    assert.equal(errorComesFromGraph(new Error("Listing users failed.", { cause: thrown })), true);
    assert.equal(graphAccessDenialFromError(thrown)?.cause, "missing-consent");
  });

  it("does not classify an HTTP 403 from a model server, a vendor API, or an MCP server as a Graph denial", () => {
    for (const raw of [
      "HTTP 403",
      "Ollama could not report the model's context limit: HTTP 403 at http://127.0.0.1:11434/api/show: Forbidden",
      "LM Studio responded with HTTP 403 at http://127.0.0.1:1234/v1/models: forbidden",
      "Anthropic API returned 403 Forbidden: permission_error",
      "Azure OpenAI responded with HTTP 403 for https://contoso.openai.azure.com/openai/deployments/gpt: {\"error\":{\"code\":\"PermissionDenied\"}}",
      "MCP server \"tickets\" responded with HTTP 403: forbidden",
      "Splashtop refused this request (HTTP 403) at my.splashtop.com.",
      // A provider error that appends a response body quoting Graph.
      "Ollama could not report the model's context limit: HTTP 403 at http://127.0.0.1:11434/api/show: Forbidden by the Microsoft Graph lab proxy",
      "MCP server \"tickets\" responded with HTTP 403: Graph responded with HTTP 403 for https://graph.microsoft.com/v1.0/users",
      "Proxy answered HTTP 403 for https://graph.microsoft.com.example.org/v1.0/users",
      // A model gateway message that copies the adapter's wording.
      "Graph responded with HTTP 403 for https://gateway.example.com/v1/messages: forbidden",
      "Graph responded with HTTP 403 for https://graph.microsoft.com.example.org/v1.0/users: forbidden",
    ]) {
      assert.equal(errorComesFromGraph(raw), false, raw);
      assert.equal(graphAccessDenialFromError(raw), undefined, raw);
      assert.equal(graphAccessDenialFromStoredText(raw), undefined, raw);
      assert.equal(graphAccessDenialFromError(new Error(raw), { path: "/users", requiredScopes: ["User.Read.All"] }), undefined, raw);
    }
  });

  it("classifies new failures from typed Graph errors only, never from their text", () => {
    const text = 'Graph responded with HTTP 403 for https://graph.microsoft.com/v1.0/users: {"error":{"code":"Forbidden"}}';
    assert.equal(graphAccessDenialFromError(text), undefined);
    assert.equal(graphAccessDenialFromError(new Error(text)), undefined);
    assert.equal(graphAccessDenialFromError(new Error("Claude Code failed: Graph responded with HTTP 403 for https://graph.microsoft.com/v1.0/users")), undefined);
    const teams = new ConnectorScopeError("Microsoft Graph rejected the request (HTTP 403). The signed-in admin lacks the required Teams scopes.", { connectorId: "teams", missingScopes: ["ChannelMessage.Send"] });
    assert.equal(graphAccessDenialFromError(teams)?.cause, "unknown");
    const outlook = new ConnectorRemoteError("Microsoft Graph responded with HTTP 403 for /me/sendMail: {}", { connectorId: "outlook", recovery: "fatal", statusCode: 403 });
    assert.equal(graphAccessDenialFromError(outlook)?.cause, "unknown");
    const slack = new ConnectorRemoteError("Slack responded with HTTP 403", { connectorId: "slack", recovery: "fatal", statusCode: 403 });
    assert.equal(graphAccessDenialFromError(slack), undefined);
    const outlook500 = new ConnectorRemoteError("Microsoft Graph responded with HTTP 500 for /me/sendMail: {}", { connectorId: "outlook", recovery: "retry", statusCode: 500 });
    assert.equal(graphAccessDenialFromError(outlook500), undefined);
  });

  it("keeps a stored denial only when it was classified from a Graph error", () => {
    const current = classifyGraphAccessDenied({ ...users, grantedScopes: [] });
    const { source: _source, ...legacy } = current;
    const ollama = "Ollama responded with HTTP 403 at http://127.0.0.1:11434/api/chat: Forbidden";
    assert.equal(storedGraphAccessDenial(current, "Listing users failed."), current);
    assert.equal(storedGraphAccessDenial(legacy, ollama), undefined);
    assert.equal(storedGraphAccessDenial(legacy, graphAccessDenialText(legacy)), legacy);
    assert.equal(storedGraphAccessDenial(undefined, graphAccessDenialText(legacy)), undefined);
  });

  it("never recommends a read-only role for a write action", () => {
    const denial = classifyGraphAccessDenied({ path: "/deviceManagement/managedDevices/test/retire", method: "POST", requiredScopes: ["DeviceManagementManagedDevices.ReadWrite.All"], grantedScopes: ["DeviceManagementManagedDevices.ReadWrite.All"] });
    assert.match(denial.recovery, /Intune Administrator/);
    assert.doesNotMatch(denial.recovery, /Global Reader|Read Only Operator|reconnect/i);
  });
});
