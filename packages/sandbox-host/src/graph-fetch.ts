import { createHash, randomUUID } from "node:crypto";

import type { GraphRequestAuditSink } from "@openadminos/runtime";

import { describe } from "./files.js";
import { SandboxRefusal } from "./refusal.js";

export const GRAPH_ORIGIN = "https://graph.microsoft.com";

export interface SandboxGraphFetchOptions {
  base?: typeof fetch;
  sink: GraphRequestAuditSink;
  /**
   * Called when the sandbox refuses a request or cannot audit one. The
   * host stops the run with this reason, so the adapter does not retry.
   */
  onStop(refusal: SandboxRefusal): void;
  /** Called with the status of every response, for the run's failure reason. */
  onStatus?(status: number): void;
}

/**
 * The only path from a sandbox run to Microsoft Graph. Every request is
 * recorded in the audit log before it is sent, with the path and a digest
 * of the query, never a body. It refuses, before sending: any origin but
 * https://graph.microsoft.com (the bearer token goes nowhere else, and a
 * nextLink to another host is refused here), any method but GET, `$batch`
 * and `/me`. Redirects fail instead of being followed.
 */
export function sandboxGraphFetch(options: SandboxGraphFetchOptions): typeof fetch {
  const base = options.base ?? fetch;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let url: URL | undefined;
    try {
      url = new URL(href);
    } catch {
      url = undefined;
    }
    const attemptId = randomUUID();
    const versioned = url ? /^\/(?:v1\.0|beta)(\/.*)?$/.exec(url.pathname) : null;
    const path = url
      ? (url.origin === GRAPH_ORIGIN && versioned ? versioned[1] ?? "/" : `${url.origin}${url.pathname}`)
      : "(unreadable URL)";
    const query = url?.search.replace(/^\?/, "") ?? "";
    const refusal = refusalFor(url, method, versioned !== null, path, query);

    try {
      await options.sink.attempted({
        attemptId,
        method,
        path,
        ...(query ? { queryDigest: createHash("sha256").update(query).digest("hex") } : {}),
      });
    } catch (cause) {
      const stop = new SandboxRefusal(
        "audit-failed",
        `${method} ${path} was not sent: the audit log could not record it. ${describe(cause)} Check free disk space and permissions of the sandbox data folder, then run again.`,
        { cause },
      );
      options.onStop(stop);
      throw stop;
    }
    const startedAt = Date.now();
    const record = async (result: { outcome: "ok" | "failed" | "refused"; status?: number; requestId?: string; reason?: string }) => {
      try {
        await options.sink.result({ attemptId, method, path, ...result, durationMs: Date.now() - startedAt });
      } catch (cause) {
        options.onStop(new SandboxRefusal(
          "audit-failed",
          `The audit log could not record the result of ${method} ${path}. ${describe(cause)} The run was stopped. Check free disk space and permissions of the sandbox data folder.`,
          { cause },
        ));
      }
    };

    if (refusal) {
      await record({ outcome: "refused", reason: refusal.reason });
      options.onStop(refusal);
      throw refusal;
    }

    let response: Response;
    try {
      response = await base(input, { ...init, method, redirect: "error" });
    } catch (error) {
      await record({ outcome: "failed", reason: init?.signal?.aborted ? "cancelled" : "network-error" });
      throw error;
    }
    const requestId = response.headers.get("request-id") ?? response.headers.get("client-request-id") ?? undefined;
    await record({ outcome: response.ok ? "ok" : "failed", status: response.status, ...(requestId ? { requestId } : {}) });
    options.onStatus?.(response.status);
    return response;
  }) as typeof fetch;
}

function refusalFor(url: URL | undefined, method: string, versioned: boolean, path: string, query: string): SandboxRefusal | undefined {
  if (!url || url.origin !== GRAPH_ORIGIN) {
    return new SandboxRefusal("graph-request-refused", `A request to ${url?.origin ?? "an unreadable URL"} was refused before it was sent. A sandbox run talks only to ${GRAPH_ORIGIN}.`);
  }
  if (url.username || url.password) {
    return new SandboxRefusal("graph-request-refused", "A Graph request with credentials in its URL was refused before it was sent.");
  }
  if (!versioned) {
    return new SandboxRefusal("graph-request-refused", `A request to ${url.pathname} was refused before it was sent: it names no Graph version.`);
  }
  if (method !== "GET") {
    return new SandboxRefusal("graph-request-refused", `${method} ${path} was refused before it was sent. A sandbox only reads; every change is confirmed and applied on the desktop.`);
  }
  if (/\$batch/i.test(path) || /\$batch/i.test(query)) {
    return new SandboxRefusal("graph-request-refused", `${path} was refused before it was sent: a sandbox does not send $batch requests.`);
  }
  if (/^\/me(?:[/(]|$)/i.test(path)) {
    return new SandboxRefusal("graph-request-refused", `${path} was refused before it was sent: an app-only identity has no signed-in user.`);
  }
  return undefined;
}
