import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable, Transform, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from "node:zlib";

/**
 * A fetch for model servers on this device that never goes through a proxy.
 *
 * Electron's global fetch, and Node's global HTTP agents, send requests to
 * an environment proxy when NODE_USE_ENV_PROXY (or --use-env-proxy) is set,
 * and a loopback address missing from NO_PROXY would then reach the proxy,
 * question included. This connects with a fresh agent per request, which
 * reads no proxy setting. A redirect is never followed: a 3xx is returned
 * as it came. Bodies are strings only, which is all retrieval sends. As with
 * fetch, a gzip, deflate (zlib-wrapped or raw) or br body is decoded, and a connection idle for
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
      // A budget that runs out while the body is read or decoded ends it with the budget's reason, as fetch does.
      // The body is the decoder when there is one, so the listener stays until the decoded body is done.
      let reading: Readable = response;
      const signal = init.signal;
      const stop = () => {
        const reason = signal?.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError");
        reading.destroy(reason);
        response.destroy(reason);
      };
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
      const release = () => signal?.removeEventListener("abort", stop);
      answer(response, method).then(
        ({ stream, status, headers: responseHeaders }) => {
          reading = stream ?? response;
          reading.once("close", release);
          if (reading.destroyed) release();
          return new Response(stream ? (Readable.toWeb(stream) as ReadableStream<Uint8Array>) : null, { status, headers: responseHeaders });
        },
      ).then(resolve, (error: unknown) => {
        // Also a Response that could not be built: the request fails instead of staying pending.
        release();
        response.destroy();
        reject(error);
      });
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

/** The response's status, headers and body stream, decoded when it came compressed. */
async function answer(response: IncomingMessage, method: string): Promise<{ stream: Readable | undefined; status: number; headers: Headers }> {
  const status = response.statusCode ?? 0;
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else if (value !== undefined) headers.set(name, value);
  }
  if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
    response.resume();
    return { stream: undefined, status, headers };
  }
  const encoding = (response.headers["content-encoding"] ?? "").trim().toLowerCase();
  let decoder: Transform | undefined;
  if (encoding === "gzip" || encoding === "x-gzip") decoder = createGunzip();
  else if (encoding === "br") decoder = createBrotliDecompress();
  else if (encoding === "deflate") {
    // Meant to be zlib-wrapped, but some servers send it raw; fetch takes both, so the first byte picks, as fetch does.
    const first = await peekFirstByte(response);
    // An empty body was read to its end by the peek, so it is answered as empty rather than wrapped.
    if (first === undefined) return { stream: undefined, status, headers };
    decoder = (first & 0x0f) === 0x08 ? createInflate() : createInflateRaw();
  }
  if (!decoder) return { stream: response, status, headers };
  // The decoded body has another length and no encoding, as fetch reports it.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return { stream: pipeline(response, decoder, () => undefined), status, headers };
}

/** The body's first byte, left in the stream; undefined for an empty body. */
function peekFirstByte(stream: Readable): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      stream.off("readable", onReadable);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
      finish();
    };
    const onReadable = () => {
      const chunk = stream.read(1) as Buffer | null;
      if (chunk === null) return;
      settle(() => {
        stream.unshift(chunk);
        resolve(chunk[0]);
      });
    };
    const onEnd = () => settle(() => resolve(undefined));
    const onError = (error: Error) => settle(() => reject(error));
    const onClose = () => settle(() => reject(stream.errored ?? new Error("The model server closed the connection before its answer.")));
    stream.on("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

/** The transport retrieval uses; tests replace `fetch` or shorten the idle limit here rather than globally. */
export const loopbackTransport: { fetch: typeof fetch; idleTimeoutMs: number } = { fetch: directFetch as typeof fetch, idleTimeoutMs: 300_000 };
