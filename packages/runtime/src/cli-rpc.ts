import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { cliFailure, spawnProvider, terminateCli } from "./cli-provider.js";

export type RpcObject = Record<string, unknown>;
export function rpcObject(value: unknown): RpcObject { return value && typeof value === "object" && !Array.isArray(value) ? value as RpcObject : {}; }

/** Copilot's documented SDK transport: JSON-RPC 2.0 with Content-Length framing. */
export class CliRpc {
  private child: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: RpcObject) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stopped = false;
  private readonly exited: Promise<void>;
  onEvent: (method: string, params: RpcObject) => void = () => {};
  onError: (error: Error) => void = () => {};
  constructor(binary: string, env: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawnProvider(binary, ["--headless", "--stdio", "--no-auto-update", "--log-level", "none", "--disable-builtin-mcps", "--no-custom-instructions", "--no-remote-export"], env, cwd);
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stdout.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 2_000_000) { this.fail(new Error("Copilot exceeded its protocol output limit.")); return; }
      try {
        while (true) {
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd < 0) break;
          const size = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())?.[1]);
          if (!Number.isSafeInteger(size) || size <= 0 || size > 1_000_000) throw new Error("Copilot returned an invalid protocol frame.");
          if (this.buffer.length < headerEnd + 4 + size) break;
          const message = rpcObject(JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + size).toString()));
          this.buffer = this.buffer.subarray(headerEnd + 4 + size);
          if (typeof message.method === "string") {
            if (message.id !== undefined) {
              // No remote tool, hook, or user-input request is approved by a provider adapter.
              this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "OpenAdminOS provider does not permit this operation." } });
            } else this.onEvent(message.method, rpcObject(message.params));
          } else if (typeof message.id === "number") {
            const request = this.pending.get(message.id);
            if (!request) continue;
            clearTimeout(request.timer); this.pending.delete(message.id);
            if (message.error) request.reject(cliFailure("GitHub Copilot", String(rpcObject(message.error).message ?? "")));
            else request.resolve(rpcObject(message.result));
          }
        }
      } catch (e) { this.fail(e instanceof Error ? e : new Error("Invalid Copilot response.")); }
    });
    // Never accumulate or expose raw CLI logs. Errors returned over RPC are classified above.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.fail(new Error("Copilot connection closed. Test the provider in Settings.")));
    this.child.on("error", () => this.fail(new Error("Copilot could not start. Check its executable and test again.")));
    this.child.on("close", () => { if (!this.stopped) this.fail(new Error("Copilot exited before finishing. Test the provider in Settings.")); });
  }
  request(method: string, params: RpcObject = {}, timeoutMs = 15_000): Promise<RpcObject> {
    if (this.stopped) return Promise.reject(new Error("Copilot connection closed."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Copilot did not respond in time. Test the provider in Settings.")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  private write(message: RpcObject) {
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
  private fail(error: Error) { if (this.stopped) return; this.onError(error); this.close(error); }
  async dispose() { this.close(); await this.exited; }
  close(error = new Error("Copilot connection closed.")) {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); terminateCli(this.child);
  }
}
