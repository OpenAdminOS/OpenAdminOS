/**
 * Proxy and offline failures, named honestly (hard constraint 4: no silent
 * failures). Every message says which host could not be reached and why,
 * whether a proxy was in the path, and the one step that fixes it.
 *
 * OpenAdminOS's own requests (Microsoft sign-in, the Marketplace) connect
 * directly: the main process configures no proxy. The device's system
 * proxy, when Electron can read it, is named so an admin behind one knows
 * the request did not use it. Ollama downloads models itself and uses the
 * proxy set in its own environment. A runtime on this device is reached
 * over loopback, where no proxy is involved.
 */

import { classifyNetworkFailure, type NetworkFailureKind } from "@openadminos/runtime";

export { classifyNetworkFailure, type NetworkFailureKind };

/** Electron's `session.resolveProxy` result: "DIRECT", or "PROXY host:port; DIRECT" and similar. */
export type ProxyResolver = (url: string) => Promise<string>;

/** How the request travelled: OpenAdminOS directly, Ollama's own download, or loopback on this device. */
export type NetworkPath = "app" | "ollama" | "loopback";

const REASONS: Readonly<Record<NetworkFailureKind, string>> = {
  dns: "its name did not resolve",
  refused: "the connection was refused",
  timeout: "it did not answer in time",
  reset: "the connection was closed before it answered",
  unreachable: "the network route to it is unavailable",
  certificate: "its certificate was not trusted, which a proxy that inspects HTTPS can cause",
  "proxy-auth": "a proxy asked for credentials",
  offline: "this device is offline",
  "blocked-port": "the request uses a blocked port",
  proxy: "a proxy connection failed",
  tls: "the TLS connection failed",
};

/** "proxy.contoso.com:8080" from an Electron proxy string, or undefined for a direct connection. */
export function systemProxyFrom(resolved: string | undefined): string | undefined {
  if (!resolved) return undefined;
  const first = resolved.split(";").map((entry) => entry.trim()).find((entry) => entry && entry.toUpperCase() !== "DIRECT");
  if (!first) return undefined;
  const [, server] = first.split(/\s+/, 2);
  return server || first;
}

export interface NetworkFailureInput {
  /** What failed, as the admin knows it: "Microsoft sign-in", "The Marketplace". */
  what: string;
  /** The address that could not be reached. */
  url: string;
  error: unknown;
  path?: NetworkPath;
  resolveProxy?: ProxyResolver;
  /** The step that fixes it for a loopback runtime, for example "Start it yourself with `ollama serve`, then scan again." */
  loopbackRecovery?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The full message for a network failure, or undefined when the error is
 * not a network failure and the caller keeps its own message.
 */
export async function describeNetworkFailure(input: NetworkFailureInput): Promise<string | undefined> {
  const kind = classifyNetworkFailure(input.error);
  if (!kind) return undefined;
  const host = hostOf(input.url);
  const path = input.path ?? "app";
  const reached = `${input.what} could not reach ${host}: ${REASONS[kind]}.`;
  if (path === "loopback") {
    return `${reached} It runs on this device, so no proxy is involved. ${input.loopbackRecovery ?? "Start it, then try again."}`;
  }
  if (path === "ollama") {
    const recovery =
      kind === "certificate"
        ? "Add your proxy's root certificate to the system trust store and restart Ollama, then try again."
        : "If this device reaches the internet through a proxy, set HTTPS_PROXY where Ollama runs and restart it. Otherwise check the network connection, then try again.";
    return `${reached} Ollama downloads it itself and uses the proxy set in its own environment (HTTPS_PROXY), not this device's proxy setting. ${recovery}`;
  }
  let systemProxy: string | undefined;
  let proxyKnown = false;
  if (input.resolveProxy) {
    try {
      systemProxy = systemProxyFrom(await input.resolveProxy(input.url));
      proxyKnown = true;
    } catch {
      proxyKnown = false;
    }
  }
  const proxyLine = systemProxy
    ? `This device has a system proxy (${systemProxy}); OpenAdminOS connects directly and did not use it.`
    : proxyKnown
      ? "No system proxy is set, and OpenAdminOS connected directly."
      : "OpenAdminOS connected directly, without a proxy.";
  const recovery =
    kind === "certificate"
      ? `Add your proxy's root certificate to this device's trust store, or ask your network team to let ${host} through without inspection, then try again.`
      : kind === "proxy-auth" || systemProxy
        ? `Ask your network team to allow direct HTTPS access to ${host}, then try again.`
        : kind === "offline"
          ? "Connect to a network, then try again."
          : "Check the network connection, VPN and DNS, then try again.";
  return `${reached} ${proxyLine} ${recovery}`;
}

/** A request stopped by its own timer reports an AbortError; for the admin it did not answer in time. */
export function timeoutWhenAborted(error: unknown): unknown {
  return error instanceof Error && error.name === "AbortError" ? Object.assign(new Error("The request timed out."), { code: "ETIMEDOUT", cause: error }) : error;
}
