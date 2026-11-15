import { randomUUID, type X509Certificate } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";

import {
  createPairingCode,
  exportDevicePublicKey,
  formatPairingCode,
  matchesTlsSpkiPin,
  PAIRING_CODE_LIFETIME_MS,
  SandboxPairingSession,
  signAuditCheckpoint,
  signPairingRecord,
  tlsSpkiSha256,
  type PairingRecord,
  type SignedAuditCheckpoint,
} from "@openadminos/pairing";
import { AUDIT_CHAIN_START_HASH, type AuditLogPosition, type AuditLogStore } from "@openadminos/runtime";

import { AssignmentError } from "./assignments.js";
import { describe } from "./files.js";
import type { SandboxHost } from "./host.js";
import { assertPrivateListenAddress, type ListenAddress } from "./listen.js";
import type { SandboxLogger } from "./log.js";
import { loadOrCreateTlsCertificate } from "./pairing-files.js";
import { isSandboxRefusal } from "./refusal.js";

/** Request bodies larger than this are refused before they are read. */
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RUNS_LIMIT = 100;
export const MAX_AUDIT_LIMIT = 500;
const DEFAULT_RUNS_LIMIT = 50;
const DEFAULT_AUDIT_LIMIT = 200;
/** A whole request, headers and body, must arrive within this. */
const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;
/** The certificate is checked for renewal this often while the host runs. */
const CERTIFICATE_CHECK_MS = 24 * 3_600_000;

/** Every error the API answers with: a code, an HTTP status and a message that says what to do. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

interface ShownCode {
  pairingId: string;
  session: SandboxPairingSession;
  expiresAt: number;
}

/**
 * The sandbox's local API for its paired desktop: TLS 1.3 only, with the
 * sandbox's own certificate, on a private address only. Before pairing it
 * answers only GET and POST /v1/pair. After pairing every route but POST
 * /v1/pair needs the client certificate the desktop paired with; trust is
 * that pin alone, never a CA.
 */
export class SandboxApi {
  private server: Server | undefined;
  private shown: ShownCode | undefined;
  private codeGeneration = 0;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private certificateTimer: ReturnType<typeof setInterval> | undefined;
  private tlsPin = "";
  private readonly clock: () => number;
  private closed = false;

  constructor(
    private readonly host: SandboxHost,
    private readonly listen: ListenAddress,
    private readonly log: SandboxLogger,
    private readonly now: () => Date,
    clock?: () => number,
  ) {
    this.clock = clock ?? Date.now;
  }

  /** Binds, then shows a pairing code when unpaired. Returns the bound address. */
  async start(): Promise<ListenAddress> {
    assertPrivateListenAddress(this.listen.host);
    const config = this.host.sandboxConfig;
    const tls = loadOrCreateTlsCertificate(config.dataDir, config.sandbox.id, this.now());
    this.tlsPin = tls.spkiSha256;
    if (tls.reissued) this.log("info", "The pairing TLS certificate was reissued with the same key.", { pin: tls.spkiSha256 });
    const server = createServer(
      {
        key: tls.privateKeyPem,
        cert: tls.certificatePem,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        requestCert: true,
        // Client certificates are self-signed; the pin decides, per route.
        rejectUnauthorized: false,
      },
      (request, response) => {
        void this.handle(request, response);
      },
    );
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 50;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.listen.port, this.listen.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.certificateTimer = setInterval(() => this.renewCertificate(), CERTIFICATE_CHECK_MS);
    const address = server.address() as AddressInfo;
    this.log("info", "Pairing API listening.", { address: address.address, port: address.port, pin: tls.spkiSha256 });
    if (!this.host.currentPairing) await this.showCode();
    return { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopCode();
    if (this.certificateTimer !== undefined) clearInterval(this.certificateTimer);
    this.certificateTimer = undefined;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /** The pairing code shown now, for tests; the log is how an admin sees it. */
  get shownCode(): { pairingId: string; expiresAt: number } | undefined {
    return this.shown ? { pairingId: this.shown.pairingId, expiresAt: this.shown.expiresAt } : undefined;
  }

  private renewCertificate(): void {
    try {
      const config = this.host.sandboxConfig;
      const tls = loadOrCreateTlsCertificate(config.dataDir, config.sandbox.id, this.now());
      if (!tls.reissued) return;
      this.server?.setSecureContext({ key: tls.privateKeyPem, cert: tls.certificatePem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
      this.log("info", "The pairing TLS certificate was reissued with the same key.", { pin: tls.spkiSha256 });
    } catch (error) {
      this.log("error", `The pairing TLS certificate could not be renewed: ${describe(error)}`, { reason: isSandboxRefusal(error) ? error.reason : "storage-failed" });
    }
  }

  /**
   * Shows a new code, valid for 10 minutes, and renews it until a desktop
   * pairs. One session per code, shared by every connection that tries it.
   */
  private async showCode(): Promise<void> {
    this.stopCode();
    if (this.closed || this.host.currentPairing) return;
    const generation = ++this.codeGeneration;
    const config = this.host.sandboxConfig;
    const code = createPairingCode(this.tlsPin);
    const pairingId = `pairing_${randomUUID()}`;
    const issuedAt = this.clock();
    const session = await SandboxPairingSession.create({
      code,
      pairingId,
      sandboxPublicKey: exportDevicePublicKey(this.host.identity.publicKey),
      tlsSpkiSha256: this.tlsPin,
      organizationId: config.organizationId,
      tenantId: config.tenantId,
      issuedAt,
      now: this.clock,
    });
    if (generation !== this.codeGeneration || this.closed || this.host.currentPairing) return;
    this.shown = { pairingId, session, expiresAt: issuedAt + PAIRING_CODE_LIFETIME_MS };
    this.log("info", "Pairing code for this sandbox. Type it on the desktop within 10 minutes; a new code follows when it expires.", {
      code: formatPairingCode(code),
      expires: new Date(issuedAt + PAIRING_CODE_LIFETIME_MS).toISOString(),
    });
    // Referenced, so the service stays up; cleared on pairing and close.
    this.renewTimer = setTimeout(() => {
      void this.showCode().catch((error: unknown) => this.log("error", `A new pairing code could not be made: ${describe(error)}`, { reason: "pairing-code-failed" }));
    }, PAIRING_CODE_LIFETIME_MS);
  }

  private stopCode(): void {
    if (this.renewTimer !== undefined) clearTimeout(this.renewTimer);
    this.renewTimer = undefined;
    this.shown = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const result = await this.route(request);
      send(response, result.status ?? 200, result.body);
    } catch (error) {
      const apiError = error instanceof ApiError
        ? error
        : error instanceof AssignmentError
          ? new ApiError(error.code === "assignment-replayed" ? 409 : error.code === "assignment-binding-mismatch" ? 403 : 422, error.code, error.message)
          : isSandboxRefusal(error)
            ? new ApiError(500, error.reason, error.message)
            : new ApiError(500, "internal-error", `The sandbox could not answer this request: ${describe(error)}`);
      if (apiError.status >= 500) this.log("error", apiError.message, { reason: apiError.code });
      send(response, apiError.status, { error: { code: apiError.code, message: apiError.message } });
    }
  }

  private async route(request: IncomingMessage): Promise<{ status?: number; body: unknown }> {
    const url = new URL(request.url ?? "/", "https://sandbox.invalid");
    const method = request.method ?? "GET";
    const routes: Record<string, Record<string, () => Promise<{ status?: number; body: unknown }>>> = {
      "/v1/pair": {
        GET: async () => ({ body: this.hello() }),
        POST: async () => this.pair(request, await readJson(request)),
      },
      "/v1/status": { GET: async () => ({ body: this.host.status() }) },
      "/v1/health": { GET: async () => ({ body: this.host.healthSnapshot() }) },
      "/v1/runs": { GET: async () => ({ body: this.runs(url) }) },
      "/v1/audit": { GET: async () => ({ body: this.audit(url) }) },
      "/v1/assignments": { PUT: async () => ({ body: this.host.applyAssignment(await readJson(request)) }) },
      "/v1/pairing": { DELETE: async () => ({ body: await this.unpair() }) },
    };
    const path = routes[url.pathname];
    if (!path) throw new ApiError(404, "not-found", `${url.pathname} is not a route of the sandbox API.`);
    const handler = path[method];
    if (!handler) throw new ApiError(405, "method-not-allowed", `${method} is not allowed on ${url.pathname}; use ${Object.keys(path).join(" or ")}.`);

    const isPairPost = method === "POST" && url.pathname === "/v1/pair";
    const pairing = this.host.currentPairing;
    if (!isPairPost) {
      if (pairing) {
        const certificate = peerCertificate(request);
        if (!certificate || !matchesTlsSpkiPin(certificate, pairing.desktopTlsSpkiSha256)) {
          throw new ApiError(401, "client-not-paired", "This client is not the desktop this sandbox is paired with. Pair it, or use the desktop that paired.");
        }
        // Unpairing stays possible, so a changed binding can be recovered.
        if (this.host.bindingChanged && url.pathname !== "/v1/pairing") {
          throw new ApiError(409, "pairing-binding-changed", "The sandbox config now names another organization or tenant than the one this desktop paired with. Unpair, then pair again.");
        }
      } else if (url.pathname !== "/v1/pair") {
        throw new ApiError(409, "not-paired", "This sandbox is not paired. Pair a desktop with the code the sandbox shows.");
      }
    }
    return handler();
  }

  private hello(): unknown {
    if (this.host.currentPairing) throw alreadyPaired();
    const shown = this.shown;
    if (!shown) throw new ApiError(503, "pairing-code-not-ready", "The sandbox is making a new pairing code. Try again in a few seconds.");
    const config = this.host.sandboxConfig;
    return {
      pairingId: shown.pairingId,
      sandboxId: config.sandbox.id,
      sandboxName: config.sandbox.name,
      sandboxPublicKey: exportDevicePublicKey(this.host.identity.publicKey),
      tlsSpkiSha256: this.tlsPin,
      expiresAt: new Date(shown.expiresAt).toISOString(),
    };
  }

  private async pair(request: IncomingMessage, body: unknown): Promise<{ status?: number; body: unknown }> {
    if (this.host.currentPairing) throw alreadyPaired();
    const certificate = peerCertificate(request);
    if (!certificate) {
      throw new ApiError(400, "client-certificate-missing", "Pairing needs the desktop's client certificate on the connection; the sandbox pins it.");
    }
    const shown = this.shown;
    if (!shown) throw new ApiError(503, "pairing-code-not-ready", "The sandbox is making a new pairing code. Try again in a few seconds.");
    const offer = objectBody(body);
    if (offer.pairingId !== shown.pairingId) {
      throw new ApiError(409, "pairing-code-renewed", "The sandbox shows a new pairing code. Read the new code, then pair again.");
    }
    const result = shown.session.verifyDesktopProof(
      { organizationId: offer.organizationId as string, tenantId: offer.tenantId as string, desktopPublicKey: offer.desktopPublicKey as string },
      offer.proof,
    );
    if (!result.ok) {
      this.log("warn", "A pairing attempt was refused.", { reason: result.failure, remaining: result.remaining });
      if (result.failure === "code-expired" || result.failure === "code-attempts-exhausted") void this.showCode();
      const status = result.failure === "code-attempts-exhausted" ? 429 : result.failure === "code-expired" ? 410 : result.failure === "transcript-invalid" ? 400 : result.failure === "code-used" ? 409 : 403;
      throw new ApiError(status, result.failure, result.detail);
    }
    const config = this.host.sandboxConfig;
    const record: PairingRecord = {
      pairingId: shown.pairingId,
      sandboxId: config.sandbox.id,
      sandboxName: config.sandbox.name,
      organizationId: config.organizationId,
      tenantId: config.tenantId,
      sandboxPublicKey: result.fields.sandboxPublicKey,
      tlsSpkiSha256: this.tlsPin,
      desktopPublicKey: result.fields.desktopPublicKey,
      createdAt: this.now().toISOString(),
    };
    const signed = signPairingRecord(record, this.host.identity.privateKey);
    const sandboxProof = shown.session.sandboxProof();
    this.host.completePairing({ ...signed, desktopTlsSpkiSha256: tlsSpkiSha256(certificate) });
    this.stopCode();
    const audit = this.host.auditLog();
    return { status: 201, body: { sandboxProof, pairing: signed, startCheckpoint: this.checkpoint(audit, oldestKeptPosition(audit)) } };
  }

  private runs(url: URL): unknown {
    const after = queryInteger(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = queryInteger(url, "limit", 1, MAX_RUNS_LIMIT, DEFAULT_RUNS_LIMIT);
    return this.host.runsAfter(after, limit);
  }

  /** Rows after `after` and a checkpoint signed at the batch's last row, or at `after` for an empty batch. */
  private audit(url: URL): unknown {
    const after = queryInteger(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = queryInteger(url, "limit", 1, MAX_AUDIT_LIMIT, DEFAULT_AUDIT_LIMIT);
    const audit = this.host.auditLog();
    const rows = audit.readRange(after, limit);
    const last = rows[rows.length - 1];
    const position = last ? { seq: last.seq, sha256: last.sha256 } : positionAt(audit, after);
    if (!position) {
      throw new ApiError(409, "audit-position-unknown", `The sandbox's audit log does not hold entry ${after}: it is past the newest entry or was removed by retention. Start again from the start checkpoint of the pairing.`);
    }
    return { rows, checkpoint: this.checkpoint(audit, position) };
  }

  private checkpoint(audit: AuditLogStore, position: AuditLogPosition): SignedAuditCheckpoint {
    const pairing = this.host.currentPairing;
    if (!pairing) throw new ApiError(409, "not-paired", "This sandbox is not paired.");
    const first = audit.readRange(0, 1)[0];
    const rowCount = first ? Math.max(0, position.seq - first.seq + 1) : 0;
    return signAuditCheckpoint(
      { pairingId: pairing.record.pairingId, sandboxId: pairing.record.sandboxId, seq: position.seq, sha256: position.sha256, rowCount, at: this.now().toISOString() },
      this.host.identity.privateKey,
    );
  }

  private async unpair(): Promise<unknown> {
    const removed = this.host.unpair();
    await this.showCode();
    return { removed };
  }
}

function alreadyPaired(): ApiError {
  return new ApiError(409, "already-paired", "This sandbox is paired with a desktop already. Unpair it from that desktop, or run openadminos-sandbox --unpair on the sandbox, then pair again.");
}

function peerCertificate(request: IncomingMessage): X509Certificate | undefined {
  const socket = request.socket as TLSSocket;
  return socket.getPeerX509Certificate?.() ?? undefined;
}

/** The position the oldest kept row is chained to: where a new reader starts. */
export function oldestKeptPosition(audit: AuditLogStore): AuditLogPosition {
  const first = audit.readRange(0, 1)[0];
  return first ? { seq: first.seq - 1, sha256: first.previous_sha256 } : audit.tip();
}

/** The hash at `seq`, when the log still holds that position. */
function positionAt(audit: AuditLogStore, seq: number): AuditLogPosition | undefined {
  const first = audit.readRange(0, 1)[0];
  if (!first) {
    const tip = audit.tip();
    return tip.seq === seq ? tip : undefined;
  }
  if (seq === first.seq - 1) return { seq, sha256: first.previous_sha256 };
  if (seq === 0) return first.seq === 1 ? { seq: 0, sha256: AUDIT_CHAIN_START_HASH } : undefined;
  const row = audit.readRange(seq - 1, 1)[0];
  return row && row.seq === seq ? { seq, sha256: row.sha256 } : undefined;
}

function queryInteger(url: URL, name: string, min: number, max: number, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,16}$/.test(raw)) throw new ApiError(400, "query-invalid", `${name} must be a whole number.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new ApiError(400, "query-invalid", `${name} must be at least ${min}.`);
  // Limits are capped rather than refused, so a client asking for more gets the most allowed.
  return Math.min(value, max);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(type)) {
    throw new ApiError(415, "content-type-invalid", "Send the request body as application/json.");
  }
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, "body-too-large", `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "body-too-large", `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "body-invalid", "The request body is not valid JSON.");
  }
}

function objectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "body-invalid", "The request body must be a JSON object.");
  return body as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}
