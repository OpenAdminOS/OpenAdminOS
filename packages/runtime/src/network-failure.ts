export type NetworkFailureKind = "dns" | "refused" | "timeout" | "reset" | "unreachable" | "certificate" | "proxy-auth" | "proxy" | "tls" | "blocked-port" | "offline";

const CODES: ReadonlyArray<[NetworkFailureKind, RegExp]> = [
  ["dns", /^(ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/],
  ["timeout", /^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/],
  ["reset", /^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/],
  ["unreachable", /^(ENETUNREACH|EHOSTUNREACH|ENETDOWN|EADDRNOTAVAIL)$/],
  ["proxy", /^(UND_ERR_PROXY|UND_ERR_PRX_|ERR_PROXY|ERR_TUNNEL)/],
  ["tls", /^(ERR_SSL_|ERR_TLS_(?!CERT))/],
  ["certificate", /^(CERT_|UNABLE_TO_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT)/],
];

/** Patterns for errors that arrive as text: Ollama's Go errors, MSAL and Chromium net errors. */
const REQUEST_SETUP_TEXT: ReadonlyArray<[NetworkFailureKind, RegExp]> = [
  ["blocked-port", /\bbad port\b|ERR_UNSAFE_PORT/i],
  ["proxy-auth", /\bHTTP\s+407\b|proxy authentication required|proxy response.*\b407\b/i],
  ["proxy", /proxy response|proxy (?:server|connection|tunnel|connect)|ERR_TUNNEL_CONNECTION_FAILED/i],
];

const TEXT: ReadonlyArray<[NetworkFailureKind, RegExp]> = [
  ["offline", /ERR_INTERNET_DISCONNECTED/],
  ["dns", /no such host|ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_NAME_NOT_RESOLVED|name not resolved/i],
  ["timeout", /AbortError|i\/o timeout|context deadline exceeded|handshake timeout|timed out|ETIMEDOUT|ERR_TIMED_OUT|TimeoutError|aborted due to timeout/i],
  ["certificate", /x509|certificate|self[- ]signed|unable to verify|CERT_/i],
  ["tls", /\b(?:TLS|SSL)\b.*(?:handshake|alert|wrong version)|wrong version number/i],
  ["reset", /connection reset|ECONNRESET|socket hang up|other side closed|ERR_CONNECTION_RESET/i],
  ["unreachable", /network is unreachable|no route to host|ENETUNREACH|EHOSTUNREACH|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE/i],
  ["refused", /connection refused|ECONNREFUSED|ERR_CONNECTION_REFUSED/i],
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
  const { message, name, cause, status, errors } = error as {
    message?: unknown;
    name?: unknown;
    cause?: unknown;
    status?: unknown;
    errors?: unknown;
  };
  return [
    typeof name === "string" ? name : "",
    typeof message === "string" ? message : "",
    status === 407 ? "HTTP 407" : "",
    textOf(cause, depth + 1),
    ...(Array.isArray(errors) ? errors.map((entry) => textOf(entry, depth + 1)) : []),
  ].join(" ");
}

/** The kind of network failure, or undefined when the error is not one (an HTTP error, a bad response). */
export function classifyNetworkFailure(error: unknown, isLocal = false): NetworkFailureKind | undefined {
  const text = textOf(error);
  // An explicit proxy or blocked-port error explains any socket cause underneath it.
  for (const [kind, pattern] of REQUEST_SETUP_TEXT) if (pattern.test(text)) return kind;
  const codes = codesOf(error);
  // A dual-stack localhost check can refuse one address while the other address family is unavailable.
  if (isLocal && codes.includes("ECONNREFUSED") &&
    codes.every((code) => /^(ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL)$/.test(code))) return "refused";
  for (const code of codes) {
    for (const [kind, pattern] of CODES) if (pattern.test(code)) return kind;
  }
  if (codes.includes("ECONNREFUSED")) return "refused";
  for (const [kind, pattern] of TEXT) if (pattern.test(text)) return kind;
  return undefined;
}
