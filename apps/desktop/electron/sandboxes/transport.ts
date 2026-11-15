// The desktop's connection to a sandbox: TLS 1.3 only, with the desktop's
// client certificate, to a private address only. Trust is the sandbox's
// SPKI pin alone, never a certificate authority: the pin is checked right
// after the handshake, before a byte of the request is sent.

import { request as httpRequest } from "node:http";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import { formatSandboxAddress, isPrivateAddress, tlsSpkiSha256, type SandboxAddress } from "@openadminos/pairing";

/** A whole request, from connecting to the last byte of the reply. */
const REQUEST_TIMEOUT_MS = 20_000;
/** A page of 100 run records with their logs fits well within this. */
const MAX_REPLY_BYTES = 16 * 1024 * 1024;

export interface ClientCredentials {
  keyPem: string;
  certificatePem: string;
}

export interface SandboxRequest {
  address: SandboxAddress;
  /** Left out for the pairing probe, which the sandbox answers without a client certificate. */
  credentials?: ClientCredentials;
  /** Aborts the request, for example when the organization is disconnected. */
  signal?: AbortSignal;
  /** Called with the pin of the key the sandbox presented; false stops before anything is sent. */
  acceptPin(pin: string): boolean;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}

export interface SandboxReply {
  status: number;
  body: unknown;
  /** The SPKI pin of the sandbox's TLS key. */
  pin: string;
}

export type SandboxTransport = (request: SandboxRequest) => Promise<SandboxReply>;

export type SandboxTransportFailure = "address-not-private" | "unreachable" | "tls-pin-mismatch" | "reply-invalid" | "aborted";

export class SandboxTransportError extends Error {
  constructor(readonly code: SandboxTransportFailure, message: string, readonly pin?: string) {
    super(message);
    this.name = "SandboxTransportError";
  }
}

/** One request on its own connection. */
export const tlsSandboxTransport: SandboxTransport = (request) => {
  const { address } = request;
  const where = formatSandboxAddress(address);
  if (!isPrivateAddress(address.host)) {
    return Promise.reject(new SandboxTransportError("address-not-private", `${where} is not a private address. A sandbox is reached only on loopback, a private network, link-local, a tailnet or fd00::/8.`));
  }
  const aborted = () => new SandboxTransportError("aborted", `The request to the sandbox at ${where} was stopped.`);
  if (request.signal?.aborted) return Promise.reject(aborted());
  return new Promise<SandboxReply>((resolve, reject) => {
    let settled = false;
    let socket: TLSSocket | undefined;
    const onAbort = () => finish(aborted());
    const finish = (error: Error | undefined, reply?: SandboxReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      socket?.destroy();
      if (error) reject(error);
      else resolve(reply!);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      finish(new SandboxTransportError("unreachable", `The sandbox at ${where} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Check that it runs and that this device can reach it.`));
    }, REQUEST_TIMEOUT_MS);

    socket = tlsConnect({
      host: address.host,
      port: address.port,
      ...(request.credentials ? { key: request.credentials.keyPem, cert: request.credentials.certificatePem } : {}),
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      // The sandbox's certificate is self-signed; the pin decides, below.
      rejectUnauthorized: false,
    });
    socket.once("error", (error) => {
      finish(new SandboxTransportError("unreachable", `The sandbox at ${where} could not be reached: ${error.message}. Check that it runs and that this device can reach it.`));
    });
    socket.once("secureConnect", () => {
      const certificate = socket!.getPeerX509Certificate();
      const pin = certificate ? tlsSpkiSha256(certificate) : "";
      if (!pin || !request.acceptPin(pin)) {
        finish(new SandboxTransportError("tls-pin-mismatch", `The sandbox at ${where} presented a TLS key this desktop does not expect.`, pin));
        return;
      }
      const text = request.body === undefined ? undefined : JSON.stringify(request.body);
      const outgoing = httpRequest(
        {
          method: request.method,
          path: request.path,
          createConnection: () => socket!,
          headers: {
            host: where,
            accept: "application/json",
            ...(text === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(text) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_REPLY_BYTES) {
              finish(new SandboxTransportError("reply-invalid", `The sandbox at ${where} sent a reply larger than ${MAX_REPLY_BYTES} bytes.`));
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", (error) => finish(new SandboxTransportError("unreachable", `The connection to the sandbox at ${where} broke: ${error.message}.`)));
          response.once("end", () => {
            let body: unknown;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              finish(new SandboxTransportError("reply-invalid", `The sandbox at ${where} sent a reply that is not JSON.`));
              return;
            }
            finish(undefined, { status: response.statusCode ?? 0, body, pin });
          });
        },
      );
      outgoing.once("error", (error) => finish(new SandboxTransportError("unreachable", `The request to the sandbox at ${where} failed: ${error.message}.`)));
      if (text !== undefined) outgoing.write(text);
      outgoing.end();
    });
  });
};
