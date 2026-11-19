import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/**
 * A fetch for model servers on this device that never goes through a proxy.
 *
 * Electron's global fetch, and Node's global HTTP agents, send requests to
 * an environment proxy when NODE_USE_ENV_PROXY (or --use-env-proxy) is set,
 * and a loopback address missing from NO_PROXY would then reach the proxy,
 * question included. This connects with a fresh agent per request, which
 * reads no proxy setting. A redirect is never followed: a 3xx is returned
 * as it came. Bodies are strings only, which is all retrieval sends.
 */
export function directFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
    return Promise.reject(new TypeError("directFetch sends string bodies only."));
  }
  const body = init.body ?? undefined;
  const headers: Record<string, string> = Object.fromEntries(new Headers(init.headers).entries());
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  const secure = url.protocol === "https:";
  const send = secure ? httpsRequest : httpRequest;
  const agent = secure ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false });
  const method = init.method ?? "GET";
  return new Promise<Response>((resolve, reject) => {
    const request = send(url, { method, headers, agent, signal: init.signal ?? undefined }, (response) => {
      const status = response.statusCode ?? 0;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry);
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      // A budget that runs out while the body is read ends it with the budget's reason, as fetch does.
      const signal = init.signal;
      if (signal) {
        const stop = () => response.destroy(signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError"));
        if (signal.aborted) stop();
        else {
          signal.addEventListener("abort", stop, { once: true });
          response.once("close", () => signal.removeEventListener("abort", stop));
        }
      }
      const withoutBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
      if (withoutBody) response.resume();
      try {
        resolve(new Response(withoutBody ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), { status, headers: responseHeaders }));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.on("error", reject);
    request.end(body);
  });
}

/** The transport retrieval uses; tests replace `fetch` here rather than the global one. */
export const loopbackTransport: { fetch: typeof fetch } = { fetch: directFetch as typeof fetch };
