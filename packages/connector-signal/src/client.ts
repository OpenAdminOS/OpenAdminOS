import { spawn } from "node:child_process";

import {
  ConnectorNotConfiguredError,
  ConnectorRemoteError,
  type ConnectorRecovery,
} from "@openadminos/agent-sdk";

import { SIGNAL_CONNECTOR_ID } from "./descriptor.js";

export interface SignalClient {
  healthCheck(): Promise<void>;
  sendMessage(input: { to: string; text: string }): Promise<{ timestamp?: number }>;
}

export interface CreateSignalClientOptions {
  account: string;
  httpUrl?: string;
  cliPath?: string;
  configPath?: string;
  fetchImpl?: typeof fetch;
  runProcess?: ProcessRunner;
  timeoutMs?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<ProcessResult>;

export function createSignalClient(options: CreateSignalClientOptions): SignalClient {
  if (!options.account.trim()) {
    throw new ConnectorNotConfiguredError("Signal connector requires an account.", {
      connectorId: SIGNAL_CONNECTOR_ID,
    });
  }
  if (options.httpUrl?.trim()) {
    return createSignalRestClient(options);
  }
  return createSignalCliClient(options);
}

function createSignalRestClient(options: CreateSignalClientOptions): SignalClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = trimSlash(options.httpUrl ?? "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async healthCheck(): Promise<void> {
      const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/v1/about`, {
        method: "GET",
      }, timeoutMs);
      if (!response.ok) {
        throwSignalRemoteError(
          `Signal REST bridge health check failed with HTTP ${response.status}.`,
          response.status >= 500 ? "retry" : "fatal",
          response.status,
        );
      }
    },
    async sendMessage(input): Promise<{ timestamp?: number }> {
      const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/v2/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: input.text,
          number: options.account,
          recipients: [input.to],
        }),
      }, timeoutMs);
      if (!response.ok) {
        throwSignalRemoteError(
          `Signal REST bridge send failed with HTTP ${response.status}: ${await response.text().catch(() => "")}`,
          response.status >= 500 ? "retry" : "fatal",
          response.status,
        );
      }
      const payload = (await response.json().catch(() => ({}))) as { timestamp?: unknown };
      const timestamp = parseTimestamp(payload.timestamp);
      return timestamp === undefined ? {} : { timestamp };
    },
  };
}

function createSignalCliClient(options: CreateSignalClientOptions): SignalClient {
  const run = options.runProcess ?? runProcess;
  const cliPath = options.cliPath?.trim() || "signal-cli";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseArgs = options.configPath?.trim()
    ? ["--config", options.configPath.trim()]
    : [];
  return {
    async healthCheck(): Promise<void> {
      const result = await run(cliPath, ["--version"], { timeoutMs });
      if (result.exitCode !== 0) {
        throwSignalRemoteError(
          `signal-cli health check failed: ${result.stderr || result.stdout}`,
          "fatal",
        );
      }
    },
    async sendMessage(input): Promise<{ timestamp?: number }> {
      const result = await run(
        cliPath,
        [...baseArgs, "-a", options.account, "send", "-m", input.text, input.to],
        { timeoutMs },
      );
      if (result.exitCode !== 0) {
        throwSignalRemoteError(
          `signal-cli send failed: ${result.stderr || result.stdout}`,
          "retry",
        );
      }
      const timestamp = parseFirstTimestamp(result.stdout);
      return timestamp === undefined ? {} : { timestamp };
    },
  };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (cause) {
    throw new ConnectorRemoteError(
      `Signal REST bridge request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        connectorId: SIGNAL_CONNECTOR_ID,
        capabilityId: "send-message",
        recovery: "retry",
        cause,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function runProcess(
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new ConnectorRemoteError(
          `signal-cli timed out after ${options.timeoutMs}ms.`,
          {
            connectorId: SIGNAL_CONNECTOR_ID,
            capabilityId: "send-message",
            recovery: "retry",
          },
        ),
      );
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
  });
}

function throwSignalRemoteError(
  message: string,
  recovery: ConnectorRecovery,
  statusCode?: number,
): never {
  throw new ConnectorRemoteError(message, {
    connectorId: SIGNAL_CONNECTOR_ID,
    capabilityId: "send-message",
    recovery: recovery === "retry" ? "retry" : "fatal",
    ...(statusCode !== undefined ? { statusCode } : {}),
  });
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseFirstTimestamp(value: string): number | undefined {
  const match = value.match(/\b\d{10,}\b/);
  return match?.[0] ? parseTimestamp(match[0]) : undefined;
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
