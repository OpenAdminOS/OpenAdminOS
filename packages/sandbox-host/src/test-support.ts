import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSelfSignedCertificate } from "@openadminos/runtime/testing";
import type { AgentTemplate } from "@openadminos/agent-sdk";
import {
  parseAgentTemplate,
  loadAgentManifestPreview,
  findRegistryAgentById,
  type ApplicationToken,
  type ApplicationTokenProvider,
  type ApplicationTokenProviderOptions,
} from "@openadminos/runtime";

import { manifestSha256 } from "./agents.js";

export const TENANT = "11111111-1111-1111-1111-111111111111";
export const CLIENT = "22222222-2222-2222-2222-222222222222";
const DAY = 86_400_000;

export function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "oaos-sandbox-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writePrivate(path: string, content: string, mode = 0o600): string {
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

export function bundledHash(id: string): string {
  const agent = findRegistryAgentById(id);
  if (!agent) throw new Error(`no bundled agent ${id}`);
  const preview = loadAgentManifestPreview(agent);
  if (!preview) throw new Error(`no manifest for ${id}`);
  return manifestSha256(preview.sourceText);
}

export function writeCertificate(dir: string, name: string, notBefore: Date, notAfter: Date): { certificatePath: string; privateKeyPath: string } {
  const { certificatePem, privateKeyPem } = createSelfSignedCertificate({ notBefore, notAfter });
  return {
    certificatePath: writePrivate(join(dir, `${name}.crt`), certificatePem, 0o644),
    privateKeyPath: writePrivate(join(dir, `${name}.key`), privateKeyPem),
  };
}

export function validCertificate(dir: string, name = "sandbox") {
  return writeCertificate(dir, name, new Date(Date.now() - DAY), new Date(Date.now() + 365 * DAY));
}

/** Writes a config file and returns its path. */
export function writeConfig(dir: string, overrides: Record<string, unknown> = {}): string {
  const config = {
    version: 1,
    sandbox: { id: "mini-pc", name: "Office mini PC" },
    organizationId: "org-1",
    tenantId: TENANT,
    clientId: CLIENT,
    certificates: [validCertificate(dir)],
    model: { provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "llama3.1:8b" },
    dataDir: join(dir, "data"),
    agents: [{ id: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 3600 }],
    ...overrides,
  };
  return writePrivate(join(dir, "sandbox.json"), JSON.stringify(config, null, 2));
}

export function fakeAccessToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.sig`;
}

export function appClaims(roles: string[] | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { idtyp: "app", tid: TENANT, appid: CLIENT, aud: "https://graph.microsoft.com", ...(roles ? { roles } : {}), ...extra };
}

export function tokenFor(claims: Record<string, unknown>): ApplicationToken {
  const roles = Array.isArray(claims.roles) ? (claims.roles as string[]) : [];
  return { accessToken: fakeAccessToken(claims), roles, claims, expiresOn: new Date(Date.now() + 3_600_000) };
}

/** A token provider factory that yields the given claims and runs the host's checks. */
export function fakeTokenProviders(claims: Record<string, unknown>, counter: { acquired: number } = { acquired: 0 }) {
  return (options: ApplicationTokenProviderOptions): ApplicationTokenProvider => {
    let current: ApplicationToken | undefined;
    const acquire = async () => {
      counter.acquired += 1;
      const token = tokenFor(claims);
      await options.onAcquired?.(token);
      current = token;
      return token;
    };
    const provider = (async () => {
      const token = current ?? (await acquire());
      return { accessToken: token.accessToken, scopes: token.roles };
    }) as ApplicationTokenProvider;
    provider.acquire = acquire;
    return provider;
  };
}

/** Ollama answering for llama3.1:8b on this machine. */
export function ollamaFetch(options: { models?: Array<Record<string, unknown>>; show?: Record<string, unknown> } = {}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/tags")) return Response.json({ models: options.models ?? [{ name: "llama3.1:8b", model: "llama3.1:8b", digest: "sha256:abc" }] });
    if (url.endsWith("/api/show")) return Response.json(options.show ?? { details: {} });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export function bundledManifest(id: string): AgentTemplate {
  const agent = findRegistryAgentById(id);
  const preview = agent ? loadAgentManifestPreview(agent) : undefined;
  if (!preview) throw new Error(`no manifest for ${id}`);
  return parseAgentTemplate(preview.sourceText);
}
