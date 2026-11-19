import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/**
 * A fetch for model servers on this device that never goes through a proxy.
 *
 * Electron's global fetch, and Node's global HTTP agents, send requests to
 * an environment proxy when NODE_USE_ENV_PROXY (or --use-env-proxy) is set,
 * and a loopback address missing from NO_PROXY would then reach the proxy,
 * question included. This connects with a fresh agent per request, which
 * reads no proxy setting. A redirect is never followed: a 3xx is returned
 * as it came. Bodies are strings only, which is all retrieval sends. As with
 * fetch, a gzip, deflate or br body is decoded, and a connection idle for
 * `loopbackTransport.idleTimeoutMs` (5 minutes, fetch's own headers and body
 * timeouts) fails with a TimeoutError, before the headers or while the body
 * is read.
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
  const idleMs = loopbackTransport.idleTimeoutMs;
  return new Promise<Response>((resolve, reject) => {
    let answered: Readable | undefined;
    const request = send(url, { method, headers, agent, signal: init.signal ?? undefined }, (response) => {
      answered = response;
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
      const encoding = (response.headers["content-encoding"] ?? "").trim().toLowerCase();
      const decoder = encoding === "gzip" || encoding === "x-gzip"
        ? createGunzip()
        : encoding === "deflate"
          ? createInflate()
          : encoding === "br"
            ? createBrotliDecompress()
            : undefined;
      let stream: Readable = response;
      if (decoder && !withoutBody) {
        // The decoded body has another length and no encoding, as fetch reports it.
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
        stream = pipeline(response, decoder, () => undefined);
      }
      try {
        resolve(new Response(withoutBody ? null : (Readable.toWeb(stream) as ReadableStream<Uint8Array>), { status, headers: responseHeaders }));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    // Idle before the headers fails the request; idle while the body is read fails the read.
    request.setTimeout(idleMs, () => {
      const reason = new DOMException(`The model server sent nothing for ${idleMs / 1000} seconds.`, "TimeoutError");
      if (answered) answered.destroy(reason);
      request.destroy(reason);
    });
    request.on("error", reject);
    request.end(body);
  });
}

/** The transport retrieval uses; tests replace `fetch` or shorten the idle limit here rather than globally. */
export const loopbackTransport: { fetch: typeof fetch; idleTimeoutMs: number } = { fetch: directFetch as typeof fetch, idleTimeoutMs: 300_000 };
