import {
  SPLASHTOP_API_PREFIX,
  splashtopRegion,
  type SplashtopRegion,
} from "@openadminos/agent-sdk";

/**
 * Client for the Splashtop Open API, in the main process only. The token
 * is attached to requests for the one regional host chosen at connect and
 * to nothing else: every URL is built here from that host and a path under
 * `/api/open/v1/`, ids are integers, and redirects are never followed.
 */

export type SplashtopFetch = (url: URL, init: RequestInit) => Promise<Response>;

export type SplashtopErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "not-found"
  | "bad-request"
  | "server-error"
  | "unreachable"
  | "timeout"
  | "redirect"
  | "malformed"
  | "refused";

export class SplashtopApiError extends Error {
  constructor(
    readonly code: SplashtopErrorCode,
    message: string,
    readonly options: { status?: number; retryAfterSeconds?: number; sent: boolean } = { sent: true },
  ) {
    super(message);
    this.name = "SplashtopApiError";
  }

  get status(): number | undefined {
    return this.options.status;
  }

  /** False only when the host refused the request before anything was sent. */
  get sent(): boolean {
    return this.options.sent;
  }
}

export interface SplashtopClientOptions {
  region: SplashtopRegion;
  token: string;
  fetch?: SplashtopFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type SplashtopMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface SplashtopRequest {
  method: SplashtopMethod;
  /** Starts with `/api/open/v1/`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

/** What `users/basic_info` says about the token. */
export interface SplashtopBasicInfo {
  account?: string;
  teamId: number;
  /** Keys of `data.scopes`, for example `team_computers` or `logs`. */
  tokenScopes: string[];
}

const PATH_SEGMENT = /^[a-z0-9_]+$/;
const TOKEN_FORM = /^[\x21-\x7e]{8,4096}$/;
const SUCCESS_RESULTS = new Set<unknown>([20200, "20200", "success"]);
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** A token as the admin pasted it: trimmed, without a "Bearer " prefix. */
export function normalizeSplashtopToken(raw: string): string {
  return raw.trim().replace(/^bearer\s+/i, "").trim();
}

/** Why a pasted token cannot be used, before anything is sent. */
export function splashtopTokenProblem(token: string): string | undefined {
  if (token.length === 0) return "Paste the API token from my.splashtop.com first.";
  if (!TOKEN_FORM.test(token)) {
    return "That does not look like a Splashtop API token. Copy the whole token from my.splashtop.com > Account Settings > Web API Tokens, without spaces or line breaks.";
  }
  return undefined;
}

function clean(text: string, limit = 300): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`;
}

/** Splashtop's own message from an answer, as plain text, when it gave one. */
function splashtopMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      if (typeof message === "string") parts.push(message);
      else if (message && typeof message === "object" && typeof (message as { message?: unknown }).message === "string") {
        parts.push((message as { message: string }).message);
      }
    }
  }
  const data = record.data;
  if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") parts.push((data as { error: string }).error);
  if (typeof record.error === "string") parts.push(record.error);
  const text = clean(parts.join(". "));
  return text.length > 0 ? text : undefined;
}

function retryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(3600, Math.max(1, Math.ceil((date - Date.now()) / 1000)));
  return undefined;
}

export function splashtopHttpError(host: string, status: number, body: unknown, headers: Headers): SplashtopApiError {
  const detail = splashtopMessage(body);
  const said = detail ? ` Splashtop said: ${detail}` : "";
  if (status === 401) {
    return new SplashtopApiError(
      "unauthorized",
      `Splashtop did not accept the API token (HTTP 401) at ${host}. The token may be revoked or expired, or it was created in another region: a token works only on its own region's host. Check the region, or create a new token in my.splashtop.com and use Rotate token.${said}`,
      { status, sent: true },
    );
  }
  if (status === 403) {
    return new SplashtopApiError(
      "forbidden",
      `Splashtop refused this request (HTTP 403) at ${host}. The Open API needs Splashtop Enterprise, and the token must be created by a Team Owner or Super Admin whose role covers this data.${said}`,
      { status, sent: true },
    );
  }
  if (status === 429) {
    const seconds = retryAfter(headers);
    return new SplashtopApiError(
      "rate-limited",
      `Splashtop is limiting requests from this device (HTTP 429). Wait ${seconds ? `${seconds} second${seconds === 1 ? "" : "s"}` : "a minute"}, then try again. Inventory allows 10 requests per minute.`,
      { status, sent: true, ...(seconds ? { retryAfterSeconds: seconds } : {}) },
    );
  }
  if (status === 404) {
    return new SplashtopApiError("not-found", `Splashtop at ${host} has no such item (HTTP 404). It may have been deleted or the id is wrong.${said}`, { status, sent: true });
  }
  if (status >= 400 && status < 500) {
    return new SplashtopApiError("bad-request", `Splashtop at ${host} did not accept the request (HTTP ${status}).${said || " Check the values and try again."}`, { status, sent: true });
  }
  return new SplashtopApiError("server-error", `Splashtop at ${host} answered HTTP ${status}. Try again later; if it keeps failing, check status.splashtop.com.`, { status, sent: true });
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too-large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class SplashtopApi {
  readonly host: string;
  private readonly token: string;
  private readonly fetch: SplashtopFetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: SplashtopClientOptions) {
    this.host = splashtopRegion(options.region).host;
    this.token = options.token;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /** The URL a request goes to. Throws, before anything is sent, for a path outside the Open API. */
  url(path: string, query: SplashtopRequest["query"] = {}): URL {
    if (!path.startsWith(SPLASHTOP_API_PREFIX)) {
      throw new SplashtopApiError("refused", `OpenAdminOS sends the Splashtop token only to ${SPLASHTOP_API_PREFIX} paths. Nothing was sent.`, { sent: false });
    }
    const segments = path.slice(SPLASHTOP_API_PREFIX.length).split("/");
    if (segments.some((segment) => !PATH_SEGMENT.test(segment))) {
      throw new SplashtopApiError("refused", `OpenAdminOS did not send a Splashtop request with an unexpected path. Nothing was sent.`, { sent: false });
    }
    const url = new URL(`https://${this.host}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  /** Sends one request and returns `data` of a successful answer. */
  async request(input: SplashtopRequest): Promise<unknown> {
    const url = this.url(input.path, input.query);
    input.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    // A referenced timer, cleared in finally, so a deadline is never lost on Node 22.
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetch(url, {
          method: input.method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        input.signal?.throwIfAborted();
        if (timedOut) throw this.timeoutError();
        throw new SplashtopApiError("unreachable", `Splashtop could not be reached at ${this.host}. Check the network connection or proxy, then try again.`, { sent: true });
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new SplashtopApiError(
          "redirect",
          `${this.host} answered with a redirect (HTTP ${response.status}). OpenAdminOS never follows a redirect with the Splashtop token, so nothing more was sent.`,
          { status: response.status, sent: true },
        );
      }
      let text: string;
      try {
        text = await readCapped(response, this.maxResponseBytes);
      } catch (error) {
        input.signal?.throwIfAborted();
        if (timedOut) throw this.timeoutError();
        if (error instanceof Error && error.message === "too-large") {
          throw new SplashtopApiError("malformed", `Splashtop at ${this.host} sent more data than OpenAdminOS reads in one answer. Ask for a smaller page.`, { status: response.status, sent: true });
        }
        throw new SplashtopApiError("unreachable", `The connection to Splashtop at ${this.host} broke during the answer. Try again.`, { status: response.status, sent: true });
      }
      let body: unknown;
      try {
        body = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (!response.ok) throw splashtopHttpError(this.host, response.status, body, response.headers);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new SplashtopApiError("malformed", `Splashtop at ${this.host} sent an answer OpenAdminOS could not read.`, { status: response.status, sent: true });
      }
      const record = body as Record<string, unknown>;
      if ("result" in record && !SUCCESS_RESULTS.has(record.result)) {
        const detail = splashtopMessage(record);
        throw new SplashtopApiError(
          "bad-request",
          `Splashtop at ${this.host} did not complete the request (result ${clean(String(record.result), 40)}).${detail ? ` Splashtop said: ${detail}` : ""}`,
          { status: response.status, sent: true },
        );
      }
      return record.data;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  }

  private timeoutError(): SplashtopApiError {
    const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
    return new SplashtopApiError("timeout", `Splashtop at ${this.host} did not answer within ${seconds} seconds. Try again, or ask for a smaller page.`, { sent: true });
  }

  /** The cheap read used by connect and Test: who the token belongs to and what it may reach. */
  async basicInfo(signal?: AbortSignal): Promise<SplashtopBasicInfo> {
    const data = await this.request({ method: "GET", path: `${SPLASHTOP_API_PREFIX}users/basic_info`, ...(signal ? { signal } : {}) });
    const record = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    const scopes = record.scopes && typeof record.scopes === "object" && !Array.isArray(record.scopes)
      ? (record.scopes as Record<string, unknown>)
      : {};
    let teamId: number | undefined;
    const tokenScopes: string[] = [];
    for (const [key, value] of Object.entries(scopes)) {
      if (!/^[a-z_]{1,64}$/.test(key) || !value || typeof value !== "object") continue;
      tokenScopes.push(key);
      const scope = value as Record<string, unknown>;
      const id = Number(scope.team_id ?? scope.stb_team_id);
      if (teamId === undefined && Number.isSafeInteger(id) && id > 0) teamId = id;
    }
    if (teamId === undefined) {
      throw new SplashtopApiError(
        "forbidden",
        `The token works at ${this.host}, but Splashtop did not name a team it may reach. The Open API needs Splashtop Enterprise and a token created by a Team Owner or Super Admin.`,
        { sent: true },
      );
    }
    const account = typeof record.email === "string" ? record.email : typeof record.name === "string" ? record.name : undefined;
    return { teamId, tokenScopes: tokenScopes.sort(), ...(account ? { account: clean(account, 320) } : {}) };
  }
}

/** The records of a list answer, whatever key Splashtop wraps them in. */
export function splashtopList(data: unknown): Record<string, unknown>[] {
  const pick = (value: unknown): Record<string, unknown>[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : undefined;
  const direct = pick(data);
  if (direct) return direct;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["items", "data", "computers", "servers", "users", "groups", "histories", "logs", "policies", "team_cves", "list"]) {
      const found = pick(record[key]);
      if (found) return found;
    }
  }
  return [];
}
