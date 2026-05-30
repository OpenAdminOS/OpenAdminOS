import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface MsgraphClientOptions {
  skillDir?: string;
}

export interface EndpointPermissions {
  application?: string[];
  delegatedWork?: string[];
  delegatedPersonal?: string[];
}

export interface EndpointDoc {
  path: string;
  method: string;
  permissions?: EndpointPermissions;
  notes?: string[];
  query?: { name: string }[] | Record<string, unknown>;
}

export interface ResourceDoc {
  name: string;
  properties: string;
}

export interface OpenApiEntry {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
}

export interface SampleEntry {
  file: string;
  intent: string;
  query: string;
  product?: string;
}

interface CliEnvelope<T> {
  count?: number;
  results?: T[];
  message?: string;
}

export class MsgraphClient {
  private readonly skillDir: string;
  private readonly launcher: { command: string; args: string[] };

  constructor(options: MsgraphClientOptions = {}) {
    this.skillDir = resolveSkillDir(options.skillDir);
    this.launcher = pickLauncher(this.skillDir);
  }

  getSkillDir(): string {
    return this.skillDir;
  }

  async findEndpointDoc(path: string, method: string): Promise<EndpointDoc | undefined> {
    const envelope = await this.invoke<EndpointDoc>("api-docs-search", [
      "--endpoint",
      path,
      "--method",
      method,
      "--limit",
      "1",
    ]);
    const first = envelope.results?.[0];
    if (!first) return undefined;
    if (first.path !== path || first.method !== method) return undefined;
    return first;
  }

  async findOpenApiEntry(path: string, method: string): Promise<OpenApiEntry | undefined> {
    // The FTS tokenizer chokes on placeholder segments like `{managedDevice-id}`,
    // so build a token query from the non-placeholder segments instead.
    const query = path
      .split("/")
      .filter((segment) => segment.length > 0 && !segment.startsWith("{") && !segment.endsWith(")"))
      .join(" ");
    const envelope = await this.invoke<OpenApiEntry>("openapi-search", [
      "--query",
      query,
      "--method",
      method,
      "--limit",
      "50",
    ]);
    return envelope.results?.find(
      (entry) => entry.path === path && entry.method === method,
    );
  }

  async resolveOperation(
    path: string,
    method: string,
  ): Promise<{ doc?: EndpointDoc; openapi?: OpenApiEntry }> {
    const doc = await this.findEndpointDoc(path, method);
    const openapi = await this.findOpenApiEntry(path, method);
    const result: { doc?: EndpointDoc; openapi?: OpenApiEntry } = {};
    if (doc) result.doc = doc;
    if (openapi) result.openapi = openapi;
    return result;
  }

  async findResource(name: string): Promise<ResourceDoc | undefined> {
    const envelope = await this.invoke<ResourceDoc>("api-docs-search", [
      "--resource",
      name,
      "--limit",
      "50",
    ]);
    return envelope.results?.find((entry) => entry.name === name);
  }

  async scopeIsKnown(scope: string): Promise<boolean> {
    // FTS tokenizer drops dots, so search the scope as space-separated tokens.
    const tokenized = scope.replace(/\./g, " ");
    const envelope = await this.invoke<EndpointDoc>("api-docs-search", [
      "--query",
      tokenized,
      "--limit",
      "10",
    ]);
    if (!envelope.results || envelope.results.length === 0) return false;
    for (const result of envelope.results) {
      if (!result.permissions) continue;
      const all = [
        ...(result.permissions.application ?? []),
        ...(result.permissions.delegatedWork ?? []),
        ...(result.permissions.delegatedPersonal ?? []),
      ];
      if (all.includes(scope)) return true;
    }
    return false;
  }

  async sampleForPath(path: string, product?: string): Promise<SampleEntry | undefined> {
    const query = path
      .split("/")
      .filter((segment) => segment.length > 0 && !segment.startsWith("{") && !segment.endsWith(")"))
      .join(" ");
    const args = ["--query", query, "--limit", "10"];
    if (product) {
      args.push("--product", product);
    }
    const envelope = await this.invoke<SampleEntry>("sample-search", args);
    return envelope.results?.find((entry) => entry.query.includes(path));
  }

  private async invoke<T>(subcommand: string, args: string[]): Promise<CliEnvelope<T>> {
    const stdout = await runCli(this.launcher, [subcommand, ...args]);
    if (stdout.length === 0) {
      return {};
    }
    try {
      return JSON.parse(stdout) as CliEnvelope<T>;
    } catch (error) {
      throw new Error(
        `msgraph CLI returned non-JSON output for ${subcommand}: ${truncate(stdout, 200)}`,
        { cause: error },
      );
    }
  }
}

export function resolveSkillDir(explicit?: string): string {
  const candidates = [explicit, process.env.MSGRAPH_SKILL_DIR, defaultSkillDir()].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const candidate of candidates) {
    if (existsSync(candidate) && existsSync(join(candidate, "scripts"))) {
      return candidate;
    }
  }
  throw new Error(
    `Cannot locate msgraph skill. Set MSGRAPH_SKILL_DIR or install the skill at ${defaultSkillDir()}.`,
  );
}

function defaultSkillDir(): string {
  return join(homedir(), ".claude", "skills", "msgraph");
}

function pickLauncher(skillDir: string): { command: string; args: string[] } {
  if (platform() === "win32") {
    return { command: "powershell", args: [join(skillDir, "scripts", "run.ps1")] };
  }
  return { command: "bash", args: [join(skillDir, "scripts", "run.sh")] };
}

function runCli(
  launcher: { command: string; args: string[] },
  cliArgs: string[],
): Promise<string> {
  const timeoutMs = Number.parseInt(process.env.MSGRAPH_CLI_TIMEOUT_MS ?? "30000", 10);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(launcher.command, [...launcher.args, ...cliArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `msgraph CLI timed out after ${timeoutMs}ms (set MSGRAPH_CLI_TIMEOUT_MS to override).`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(new Error(`msgraph CLI exited with code ${code}: ${truncate(stderr, 400)}`));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
