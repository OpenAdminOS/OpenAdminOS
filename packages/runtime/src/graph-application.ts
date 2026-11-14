import { constants as cryptoConstants, createHash, createPrivateKey, createPublicKey, randomUUID, sign, X509Certificate, type KeyObject } from "node:crypto";

import {
  ConfidentialClientApplication,
  type INetworkModule,
  type NetworkRequestOptions,
  type NetworkResponse,
} from "@azure/msal-node";

/**
 * The `graph-application` auth source: an app-only identity in the tenant,
 * signed in with a certificate through the OAuth client credentials flow.
 * Sandboxes on the customer's own infrastructure use it for unattended
 * runs. The token's `roles` claim lists the application permissions the
 * tenant granted; there is no `scp` claim.
 */

/** The only resource a sandbox requests a token for. */
export const GRAPH_APPLICATION_SCOPE = "https://graph.microsoft.com/.default";

const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";
/** A token is used until this long before it expires, then acquired again. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;

/**
 * Signs the client assertion. The PEM signer is the only implementation
 * today; a TPM or an OS key store can implement the same interface later
 * so the private key never sits in a file.
 */
export interface AssertionSigner {
  algorithm: "PS256";
  /** base64url SHA-256 of the DER certificate, the `x5t#S256` header. */
  x5tS256: string;
  /** base64 DER certificates, leaf first, the `x5c` header. */
  x5c: string[];
  /** Certificate validity, for the expiry checks of the host. */
  notBefore: Date;
  notAfter: Date;
  /** Hex SHA-256 thumbprint of the certificate. */
  thumbprintSha256: string;
  sign(data: Buffer): Promise<Buffer>;
}

/** An app-only token could not be acquired or used. `code` names the reason. */
export class ApplicationTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The `AADSTS` code from Microsoft sign-in, when it sent one. */
    readonly aadsts?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApplicationTokenError";
  }
}

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** A signer over a PEM certificate and an unencrypted RSA private key. */
export function createPemAssertionSigner(input: {
  certificatePem: string;
  privateKeyPem: string;
}): AssertionSigner {
  const blocks = input.certificatePem.match(CERTIFICATE_BLOCK) ?? [];
  if (blocks.length === 0) {
    throw new ApplicationTokenError("certificate-unreadable", "The certificate file holds no PEM certificate (-----BEGIN CERTIFICATE-----).");
  }
  let certificates: X509Certificate[];
  try {
    certificates = blocks.map((block) => new X509Certificate(block));
  } catch (cause) {
    throw new ApplicationTokenError("certificate-unreadable", "The certificate file holds a certificate that cannot be read.", undefined, { cause });
  }
  const leaf = certificates[0] as X509Certificate;
  let key: KeyObject;
  try {
    key = createPrivateKey(input.privateKeyPem);
  } catch (cause) {
    const encrypted = /ENCRYPTED/.test(input.privateKeyPem);
    throw new ApplicationTokenError(
      encrypted ? "key-encrypted" : "key-unreadable",
      encrypted
        ? "The private key is encrypted. The sandbox reads an unencrypted key protected by file permissions and disk encryption."
        : "The private key file holds no readable PEM private key.",
      undefined,
      { cause },
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new ApplicationTokenError("key-not-rsa", `The private key is ${key.asymmetricKeyType ?? "of an unknown type"}. Microsoft sign-in needs an RSA key for a certificate credential.`);
  }
  const certificateKey = createPublicKey(leaf.publicKey.export({ type: "spki", format: "pem" }));
  const derivedKey = createPublicKey(key);
  if (!certificateKey.export({ type: "spki", format: "der" }).equals(derivedKey.export({ type: "spki", format: "der" }))) {
    throw new ApplicationTokenError("key-mismatch", "The private key does not belong to the certificate.");
  }
  const leafDer = leaf.raw;
  return {
    algorithm: "PS256",
    x5tS256: createHash("sha256").update(leafDer).digest("base64url"),
    x5c: certificates.map((certificate) => certificate.raw.toString("base64")),
    notBefore: new Date(leaf.validFrom),
    notAfter: new Date(leaf.validTo),
    thumbprintSha256: createHash("sha256").update(leafDer).digest("hex"),
    async sign(data) {
      return sign("sha256", data, {
        key,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      });
    },
  };
}

export interface ApplicationToken {
  accessToken: string;
  /** The `roles` claim; empty when nothing is granted. */
  roles: string[];
  /** Every decoded claim, for identity checks by the host. */
  claims: Record<string, unknown>;
  expiresOn: Date;
}

export interface ApplicationTokenProviderOptions {
  tenantId: string;
  clientId: string;
  /** With `privateKeyPem`, builds a PEM signer. Ignored when `signer` is set. */
  certificatePem?: string;
  privateKeyPem?: string;
  signer?: AssertionSigner;
  /** Microsoft sign-in host. Defaults to https://login.microsoftonline.com. */
  authorityHost?: string;
  /**
   * Transport for every sign-in request. Requests to any origin other than
   * `authorityHost` are refused before they are sent, and redirects fail.
   */
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /**
   * Called for every newly acquired token before it is used. A throw
   * refuses the token: the provider rejects with that error.
   */
  onAcquired?: (token: ApplicationToken) => void | Promise<void>;
  /** Called when acquiring a token fails. */
  onFailed?: (error: ApplicationTokenError) => void | Promise<void>;
}

/**
 * A `tokenProvider` for `createGraphAdapter`: it yields the token with the
 * `roles` claim as its scopes and keeps it until shortly before it
 * expires. `acquire` always asks Microsoft sign-in for a new token,
 * never the MSAL cache.
 */
export type ApplicationTokenProvider = (() => Promise<{ accessToken: string; scopes: string[] }>) & {
  acquire(): Promise<ApplicationToken>;
};

export function createApplicationTokenProvider(options: ApplicationTokenProviderOptions): ApplicationTokenProvider {
  const signer = options.signer ?? (options.certificatePem !== undefined && options.privateKeyPem !== undefined
    ? createPemAssertionSigner({ certificatePem: options.certificatePem, privateKeyPem: options.privateKeyPem })
    : undefined);
  if (!signer) {
    throw new ApplicationTokenError("no-credential", "An app-only token needs a certificate and its private key, or a signer.");
  }
  const authorityHost = new URL(options.authorityHost ?? DEFAULT_AUTHORITY_HOST);
  if (authorityHost.protocol !== "https:") {
    throw new ApplicationTokenError("authority-not-https", `The sign-in host ${authorityHost.origin} does not use https.`);
  }
  const authority = `${authorityHost.origin}/${encodeURIComponent(options.tenantId)}`;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;

  const client = new ConfidentialClientApplication({
    auth: {
      clientId: options.clientId,
      authority,
      clientAssertion: async (config) =>
        signClientAssertion(signer, options.clientId, config.tokenEndpoint ?? `${authority}/oauth2/v2.0/token`, now),
    },
    system: { networkClient: pinnedNetworkClient(fetchImpl, authorityHost.origin, timeoutMs) },
  });

  let current: ApplicationToken | undefined;
  let inFlight: Promise<ApplicationToken> | undefined;

  const acquire = (): Promise<ApplicationToken> => {
    inFlight ??= (async () => {
      let token: ApplicationToken;
      try {
        const result = await client.acquireTokenByClientCredential({ scopes: [GRAPH_APPLICATION_SCOPE], skipCache: true });
        if (!result?.accessToken) throw new ApplicationTokenError("no-token", "Microsoft sign-in returned no access token.");
        const claims = decodeAccessTokenClaims(result.accessToken);
        if (!claims) throw new ApplicationTokenError("token-undecodable", "The access token from Microsoft sign-in cannot be decoded.");
        token = {
          accessToken: result.accessToken,
          roles: rolesFromClaims(claims),
          claims,
          expiresOn: result.expiresOn ?? new Date(now() + 60 * 60_000),
        };
      } catch (error) {
        const failure = toApplicationTokenError(error);
        await options.onFailed?.(failure);
        throw failure;
      }
      await options.onAcquired?.(token);
      current = token;
      return token;
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const provider = (async () => {
    const token = current && current.expiresOn.getTime() - EXPIRY_MARGIN_MS > now() ? current : await acquire();
    return { accessToken: token.accessToken, scopes: [...token.roles] };
  }) as ApplicationTokenProvider;
  provider.acquire = acquire;
  return provider;
}

async function signClientAssertion(
  signer: AssertionSigner,
  clientId: string,
  audience: string,
  now: () => number,
): Promise<string> {
  const issuedAt = Math.floor(now() / 1000);
  const header = { alg: signer.algorithm, typ: "JWT", "x5t#S256": signer.x5tS256, x5c: signer.x5c };
  const payload = { aud: audience, iss: clientId, sub: clientId, jti: randomUUID(), nbf: issuedAt, iat: issuedAt, exp: issuedAt + 600 };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = await signer.sign(Buffer.from(signingInput, "utf8"));
  return `${signingInput}.${signature.toString("base64url")}`;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** MSAL's transport, over fetch, limited to the sign-in host. */
function pinnedNetworkClient(fetchImpl: typeof fetch, origin: string, timeoutMs: number): INetworkModule {
  const send = async <T>(method: "GET" | "POST", url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> => {
    const target = new URL(url);
    if (target.origin !== origin) {
      throw new ApplicationTokenError("egress-refused", `The sign-in request to ${target.origin} was not sent: the sandbox talks only to ${origin} for tokens.`);
    }
    const response = await fetchImpl(target.href, {
      method,
      ...(options?.headers ? { headers: options.headers } : {}),
      ...(method === "POST" && options?.body !== undefined ? { body: options.body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const text = await response.text();
    let body: unknown = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    return { headers, body: body as T, status: response.status };
  };
  return {
    sendGetRequestAsync: (url, options) => send("GET", url, options),
    sendPostRequestAsync: (url, options) => send("POST", url, options),
  };
}

function toApplicationTokenError(error: unknown): ApplicationTokenError {
  if (error instanceof ApplicationTokenError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof (error as { errorCode?: unknown })?.errorCode === "string" ? (error as { errorCode: string }).errorCode : undefined;
  const aadsts = /AADSTS(\d+)/.exec(message)?.[0];
  if (aadsts) return new ApplicationTokenError(aadsts, message, aadsts, { cause: error });
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || /timed? ?out/i.test(message));
  return new ApplicationTokenError(timedOut ? "signin-timeout" : code ?? "signin-failed", message, undefined, { cause: error });
}

/**
 * Decodes the payload of an access token without verifying its signature.
 * The sandbox only reads its own grants; Microsoft Graph validates the token.
 */
export function decodeAccessTokenClaims(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims !== null && typeof claims === "object" && !Array.isArray(claims) ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The `roles` claim of an app-only access token; empty when absent or unreadable. */
export function rolesFromAccessToken(token: string): string[] {
  const claims = decodeAccessTokenClaims(token);
  return claims ? rolesFromClaims(claims) : [];
}

function rolesFromClaims(claims: Record<string, unknown>): string[] {
  const roles = claims.roles;
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string" && role.length > 0) : [];
}

export interface ApplicationRoleClassification {
  readOnly: string[];
  changing: string[];
}

/** Words that mark a permission segment as able to change, send or take out data. */
const CHANGING_WORDS = ["write", "send", "privilegedoperations", "manage", "create", "delete", "invite", "remove", "export", "migrate"];
const READ_SEGMENTS = new Set(["Read", "ReadBasic"]);

/**
 * Sorts application permissions into read-only and changing, deny by
 * default. A role is read-only only when one of its segments after the
 * first is exactly `Read` or `ReadBasic` and none of those segments
 * contains a changing word. The first segment names the resource
 * (`DeviceManagementManagedDevices`, `RoleManagement`), so it is checked
 * only for `Write` and `Send`; anything else is changing.
 */
export function classifyApplicationRoles(roles: readonly string[]): ApplicationRoleClassification {
  const readOnly: string[] = [];
  const changing: string[] = [];
  for (const role of roles) {
    (isReadOnlyRole(role) ? readOnly : changing).push(role);
  }
  return { readOnly, changing };
}

function isReadOnlyRole(role: string): boolean {
  const segments = role.split(".");
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) return false;
  const [resource, ...rest] = segments as [string, ...string[]];
  const resourceLower = resource.toLowerCase();
  if (resourceLower.includes("write") || resourceLower.includes("send")) return false;
  if (!rest.some((segment) => READ_SEGMENTS.has(segment))) return false;
  return !rest.some((segment) => {
    const lower = segment.toLowerCase();
    return CHANGING_WORDS.some((word) => lower.includes(word));
  });
}

/**
 * Permissions that read secrets or personal content (local admin
 * passwords, BitLocker keys, mail, files, chats). A sandbox refuses an
 * identity that holds one, even read-only.
 */
export const APPLICATION_SECRET_BEARING_ROLE_PATTERNS: readonly string[] = [
  "DeviceLocalCredential.*",
  "BitlockerKey.Read.All",
  "Mail.*",
  "MailboxSettings.*",
  "Files.*",
  "Sites.*",
  "Chat.*",
  "ChatMessage.*",
  "ChannelMessage.*",
  "Notes.*",
  "Calendars.*",
  "Contacts.*",
];

/**
 * A pattern ending in `.*` matches its prefix up to and including the
 * dot, so `Chat.*` matches `Chat.Read.All` but not `ChatMessage.Read.All`;
 * that one has its own entry.
 */
export function isSecretBearingRole(role: string): boolean {
  return APPLICATION_SECRET_BEARING_ROLE_PATTERNS.some((pattern) =>
    pattern.endsWith(".*") ? role.startsWith(pattern.slice(0, -1)) : role === pattern,
  );
}
