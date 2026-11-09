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

/** Electron's `session.resolveProxy` result: "DIRECT", or "PROXY host:port; DIRECT" and similar. */
export type ProxyResolver = (url: string) => Promise<string>;

export type NetworkFailureKind = "dns" | "refused" | "timeout" | "reset" | "unreachable" | "certificate" | "proxy-auth" | "offline";

/** How the request travelled: OpenAdminOS directly, Ollama's own download, or loopback on this device. */
export type NetworkPath = "app" | "ollama" | "loopback";

const CODES: ReadonlyArray<[NetworkFailureKind, RegExp]> = [
  ["dns", /^(ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/],
  ["refused", /^ECONNREFUSED$/],
  ["timeout", /^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/],
  ["reset", /^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/],
  ["unreachable", /^(ENETUNREACH|EHOSTUNREACH|ENETDOWN|EADDRNOTAVAIL)$/],
  ["certificate", /^(CERT_|UNABLE_TO_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT)/],
];

/** Patterns for errors that arrive as text: Ollama's Go errors, MSAL and Chromium net errors. */
const TEXT: ReadonlyArray<[NetworkFailureKind, RegExp]> = [
  ["proxy-auth", /\b407\b|proxy authentication required/i],
  ["offline", /ERR_INTERNET_DISCONNECTED/],
  ["dns", /no such host|ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_NAME_NOT_RESOLVED|name not resolved/i],
  ["refused", /connection refused|ECONNREFUSED|ERR_CONNECTION_REFUSED/i],
  ["certificate", /x509|certificate|self[- ]signed|unable to verify|CERT_/i],
  ["timeout", /i\/o timeout|context deadline exceeded|handshake timeout|timed out|ETIMEDOUT|ERR_TIMED_OUT|TimeoutError|aborted due to timeout/i],
  ["reset", /connection reset|ECONNRESET|socket hang up|other side closed|ERR_CONNECTION_RESET/i],
  ["unreachable", /network is unreachable|no route to host|ENETUNREACH|EHOSTUNREACH|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE/i],
];

function codesOf(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 4) return [];
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
  return [
    ...(typeof code === "string" ? [code] : []),
    ...codesOf(cause, depth + 1),
    ...(Array.isArray(errors) ? errors.flatMap((entry) => codesOf(entry, depth + 1)) : []),
  ];
}

function textOf(error: unknown, depth = 0): string {
  if (!error || depth > 4) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  const { message, name, cause, status } = error as { message?: unknown; name?: unknown; cause?: unknown; status?: unknown };
  return [typeof name === "string" ? name : "", typeof message === "string" ? message : "", typeof status === "number" ? String(status) : "", textOf(cause, depth + 1)].join(" ");
}

/** The kind of network failure, or undefined when the error is not one (an HTTP error, a bad response). */
export function classifyNetworkFailure(error: unknown): NetworkFailureKind | undefined {
  for (const code of codesOf(error)) {
    for (const [kind, pattern] of CODES) if (pattern.test(code)) return kind;
  }
  const text = textOf(error);
  for (const [kind, pattern] of TEXT) if (pattern.test(text)) return kind;
  return undefined;
}

const REASONS: Readonly<Record<NetworkFailureKind, string>> = {
  dns: "its name did not resolve",
  refused: "the connection was refused",
  timeout: "it did not answer in time",
  reset: "the connection was closed before it answered",
  unreachable: "the network route to it is unavailable",
  certificate: "its certificate was not trusted, which a proxy that inspects HTTPS can cause",
  "proxy-auth": "a proxy asked for credentials",
  offline: "this device is offline",
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
