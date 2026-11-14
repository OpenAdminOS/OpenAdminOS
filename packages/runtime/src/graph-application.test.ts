import assert from "node:assert/strict";
import { createVerify, constants } from "node:crypto";
import { describe, it } from "node:test";

import {
  ApplicationTokenError,
  classifyApplicationRoles,
  createApplicationTokenProvider,
  createPemAssertionSigner,
  isSecretBearingRole,
  rolesFromAccessToken,
} from "./graph-application.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";

function fakeToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function validCertificate() {
  const now = Date.now();
  return createSelfSignedCertificate({ notBefore: new Date(now - 86_400_000), notAfter: new Date(now + 365 * 86_400_000) });
}

interface Recorded { method: string; url: string; body?: string; redirect?: string }

function signInFetch(options: { roles?: string[]; tokenStatus?: number; tokenBody?: unknown } = {}) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ method: init?.method ?? "GET", url, ...(typeof init?.body === "string" ? { body: init.body } : {}), ...(init?.redirect ? { redirect: init.redirect } : {}) });
    if (url.includes("/oauth2/v2.0/token")) {
      const body = options.tokenBody ?? {
        token_type: "Bearer",
        expires_in: 3599,
        access_token: fakeToken({ idtyp: "app", tid: TENANT, appid: CLIENT, ...(options.roles ? { roles: options.roles } : {}) }),
      };
      return new Response(JSON.stringify(body), { status: options.tokenStatus ?? 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("openid-configuration")) {
      return Response.json({
        token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
        authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
        issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
        jwks_uri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      });
    }
    if (url.includes("discovery/instance")) {
      return Response.json({
        tenant_discovery_endpoint: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
        "api-version": "1.1",
        metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("classifyApplicationRoles", () => {
  it("keeps only clearly read permissions as read-only", () => {
    const result = classifyApplicationRoles([
      "DeviceManagementManagedDevices.Read.All",
      "DeviceManagementConfiguration.Read.All",
      "DeviceManagementManagedDevices.PrivilegedOperations.All",
      "Mail.Send",
      "Directory.ReadWrite.All",
      "DeviceLocalCredential.Read.All",
      "User.ReadBasic.All",
      "RoleManagement.Read.Directory",
      "Sites.Manage.All",
      "User.Export.All",
      "User.Invite.All",
      "Team.Create",
      "RoleAssignmentSchedule.Remove.Directory",
      "User.RevokeSessions.All",
      "Sites.Selected",
      "Policy.ReadWrite.ConditionalAccess",
      "AuditLog.Read.All",
      "Read",
      ".Read.All",
    ]);
    assert.deepEqual(result.readOnly, [
      "DeviceManagementManagedDevices.Read.All",
      "DeviceManagementConfiguration.Read.All",
      "DeviceLocalCredential.Read.All",
      "User.ReadBasic.All",
      "RoleManagement.Read.Directory",
      "AuditLog.Read.All",
    ]);
    assert.ok(result.changing.includes("DeviceManagementManagedDevices.PrivilegedOperations.All"));
    assert.ok(result.changing.includes("Mail.Send"));
    assert.ok(result.changing.includes("Directory.ReadWrite.All"));
    assert.ok(result.changing.includes("Sites.Selected"));
    assert.ok(result.changing.includes("Read"));
  });

  it("names secret-bearing permissions", () => {
    assert.equal(isSecretBearingRole("DeviceLocalCredential.Read.All"), true);
    assert.equal(isSecretBearingRole("BitlockerKey.Read.All"), true);
    assert.equal(isSecretBearingRole("Mail.ReadBasic.All"), true);
    assert.equal(isSecretBearingRole("MailboxSettings.Read"), true);
    assert.equal(isSecretBearingRole("BitlockerKey.ReadBasic.All"), false);
    assert.equal(isSecretBearingRole("Chat.Read.All"), true);
    assert.equal(isSecretBearingRole("ChatMessage.Read.All"), true, "Chat.* stops at the dot, so ChatMessage.* is listed");
    assert.equal(isSecretBearingRole("ChannelMessage.Read.All"), true);
    assert.equal(isSecretBearingRole("Channel.ReadBasic.All"), false);
    assert.equal(isSecretBearingRole("Mail"), false);
    assert.equal(isSecretBearingRole("DeviceManagementManagedDevices.Read.All"), false);
  });
});

describe("rolesFromAccessToken", () => {
  it("reads the roles claim and treats a missing one as no roles", () => {
    assert.deepEqual(rolesFromAccessToken(fakeToken({ roles: ["User.Read.All"] })), ["User.Read.All"]);
    assert.deepEqual(rolesFromAccessToken(fakeToken({ idtyp: "app" })), []);
    assert.deepEqual(rolesFromAccessToken("not-a-token"), []);
  });
});

describe("createPemAssertionSigner", () => {
  it("signs with PS256 and reports the SHA-256 thumbprint", async () => {
    const { certificatePem, privateKeyPem } = validCertificate();
    const signer = createPemAssertionSigner({ certificatePem, privateKeyPem });
    assert.match(signer.thumbprintSha256, /^[0-9a-f]{64}$/);
    const data = Buffer.from("payload");
    const signature = await signer.sign(data);
    const verify = createVerify("sha256");
    verify.update(data);
    assert.equal(verify.verify({ key: certificatePem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature), true);
  });

  it("refuses a key that does not belong to the certificate", () => {
    const first = validCertificate();
    const second = validCertificate();
    assert.throws(
      () => createPemAssertionSigner({ certificatePem: first.certificatePem, privateKeyPem: second.privateKeyPem }),
      (error: unknown) => error instanceof ApplicationTokenError && error.code === "key-mismatch",
    );
  });

  it("refuses a file without a certificate", () => {
    assert.throws(
      () => createPemAssertionSigner({ certificatePem: "nothing", privateKeyPem: validCertificate().privateKeyPem }),
      (error: unknown) => error instanceof ApplicationTokenError && error.code === "certificate-unreadable",
    );
  });
});

describe("createApplicationTokenProvider", () => {
  it("returns the roles as scopes, signs a certificate assertion and caches the token", async () => {
    const { fetchImpl, requests } = signInFetch({ roles: ["DeviceManagementManagedDevices.Read.All"] });
    const acquired: string[][] = [];
    const provider = createApplicationTokenProvider({
      tenantId: TENANT,
      clientId: CLIENT,
      ...validCertificate(),
      fetch: fetchImpl,
      onAcquired: (token) => {
        acquired.push(token.roles);
      },
    });
    const first = await provider();
    assert.deepEqual(first.scopes, ["DeviceManagementManagedDevices.Read.All"]);
    const second = await provider();
    assert.equal(second.accessToken, first.accessToken);
    assert.equal(acquired.length, 1);
    const tokenRequests = requests.filter((request) => request.url.includes("/oauth2/v2.0/token"));
    assert.equal(tokenRequests.length, 1);
    const body = new URLSearchParams(tokenRequests[0]?.body ?? "");
    assert.equal(body.get("grant_type"), "client_credentials");
    assert.equal(body.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    const header = JSON.parse(Buffer.from((body.get("client_assertion") ?? "").split(".")[0] ?? "", "base64url").toString());
    assert.equal(header.alg, "PS256");
    assert.ok(header["x5t#S256"]);
    assert.ok(requests.every((request) => new URL(request.url).origin === "https://login.microsoftonline.com"));
    assert.ok(requests.every((request) => request.redirect === "error"));

    await provider.acquire();
    assert.equal(requests.filter((request) => request.url.includes("/oauth2/v2.0/token")).length, 2);
  });

  it("refuses the token when onAcquired throws", async () => {
    const { fetchImpl } = signInFetch({ roles: ["Directory.ReadWrite.All"] });
    const provider = createApplicationTokenProvider({
      tenantId: TENANT,
      clientId: CLIENT,
      ...validCertificate(),
      fetch: fetchImpl,
      onAcquired: () => {
        throw new Error("refused");
      },
    });
    await assert.rejects(provider(), /refused/);
  });

  it("reports the AADSTS code of a sign-in failure", async () => {
    const { fetchImpl } = signInFetch({
      tokenStatus: 401,
      tokenBody: { error: "invalid_client", error_description: "AADSTS700027: The certificate with identifier used to sign the client assertion is not registered on application.", error_codes: [700027] },
    });
    const failures: string[] = [];
    const provider = createApplicationTokenProvider({
      tenantId: TENANT,
      clientId: CLIENT,
      ...validCertificate(),
      fetch: fetchImpl,
      onFailed: (error) => {
        failures.push(error.code);
      },
    });
    await assert.rejects(provider(), (error: unknown) => error instanceof ApplicationTokenError && error.aadsts === "AADSTS700027");
    assert.deepEqual(failures, ["AADSTS700027"]);
  });

  it("refuses a sign-in host other than https", () => {
    assert.throws(
      () => createApplicationTokenProvider({ tenantId: TENANT, clientId: CLIENT, ...validCertificate(), authorityHost: "http://login.example" }),
      (error: unknown) => error instanceof ApplicationTokenError && error.code === "authority-not-https",
    );
  });
});
