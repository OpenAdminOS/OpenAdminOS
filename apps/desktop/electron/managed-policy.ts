import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import {
  MANAGED_POLICY_KEYS,
  MANAGED_POLICY_SETTING_KEYS,
  MANAGED_POLICY_VERSION,
  type ManagedPolicyAppRegistration,
  type ManagedPolicyIssue,
  type ManagedPolicyScope,
  type ManagedPolicySettingKey,
  type ManagedPolicyStatus,
  type ManagedPolicyValues,
  type ProviderId,
} from "@openadminos/agent-sdk";

/**
 * Reads the IT policy file (managed configuration) from its documented
 * path per OS. The machine file needs administrator rights to write and
 * wins over the user file, key by key. Every problem is reported with the
 * file, the line and the reason; an invalid key is not applied and the
 * rest of the file still is. The schema in `schemas/policy.schema.json`
 * describes the same format for editors and validators.
 */

/** Larger files are refused: a policy is a few lines of JSON. */
export const MANAGED_POLICY_MAX_BYTES = 64 * 1024;
const MODEL_MAX_LENGTH = 200;
const LABEL_MAX_LENGTH = 80;
const CLIENT_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DIRECTORY_PATTERN = /^[0-9a-zA-Z.-]{1,100}$/;

export interface ManagedPolicyPath {
  scope: ManagedPolicyScope;
  path: string;
}

export interface ManagedPolicyPathOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

/** The machine path first, then the user path. */
export function managedPolicyPaths({ platform, env, home }: ManagedPolicyPathOptions): ManagedPolicyPath[] {
  if (platform === "win32") {
    const programData = env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData";
    const appData = env.APPDATA || win32.join(home, "AppData", "Roaming");
    return [
      { scope: "machine", path: win32.join(programData, "OpenAdminOS", "policy.json") },
      { scope: "user", path: win32.join(appData, "OpenAdminOS", "policy.json") },
    ];
  }
  if (platform === "darwin") {
    return [
      { scope: "machine", path: "/Library/Application Support/OpenAdminOS/policy.json" },
      { scope: "user", path: posix.join(home, "Library", "Application Support", "OpenAdminOS", "policy.json") },
    ];
  }
  return [
    { scope: "machine", path: "/etc/openadminos/policy.json" },
    { scope: "user", path: posix.join(home, ".config", "openadminos", "policy.json") },
  ];
}

// ---------------------------------------------------------------------------
// JSON with positions. JSON.parse does not say where a value is, and its
// syntax messages differ between Node versions; the policy errors must
// name the line, so the file is parsed here.
// ---------------------------------------------------------------------------

export interface JsonPosition {
  line: number;
  column: number;
}

export type JsonNode =
  | ({ kind: "object"; entries: JsonEntry[] } & JsonPosition)
  | ({ kind: "array"; items: JsonNode[] } & JsonPosition)
  | ({ kind: "string"; value: string } & JsonPosition)
  | ({ kind: "number"; value: number } & JsonPosition)
  | ({ kind: "boolean"; value: boolean } & JsonPosition)
  | ({ kind: "null" } & JsonPosition);

export interface JsonEntry {
  key: string;
  keyPosition: JsonPosition;
  value: JsonNode;
}

export class JsonSyntaxError extends Error {
  constructor(message: string, readonly position: JsonPosition) {
    super(message);
    this.name = "JsonSyntaxError";
  }
}

const MAX_DEPTH = 32;

export function parseJsonDocument(text: string): JsonNode {
  let index = 0;
  let line = 1;
  let lineStart = 0;
  const position = (): JsonPosition => ({ line, column: index - lineStart + 1 });
  const fail = (message: string, at: JsonPosition = position()): never => {
    throw new JsonSyntaxError(message, at);
  };
  const describe = (char: string | undefined): string =>
    char === undefined ? "the end of the file" : char === "\n" ? "a line break" : `\`${char}\``;

  const skipWhitespace = () => {
    for (;;) {
      const char = text[index];
      if (char === "\n") {
        index += 1;
        line += 1;
        lineStart = index;
      } else if (char === " " || char === "\t" || char === "\r") {
        index += 1;
      } else if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
        fail("Comments are not allowed in JSON. Remove the comment.");
      } else {
        return;
      }
    }
  };

  const parseString = (): string => {
    const start = position();
    index += 1;
    let result = "";
    for (;;) {
      const char = text[index];
      if (char === undefined || char === "\n") fail("This string is not closed. Add the closing `\"`.", start);
      if (char === "\"") {
        index += 1;
        return result;
      }
      if (char === "\\") {
        const escape = text[index + 1];
        const simple: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (escape !== undefined && simple[escape] !== undefined) {
          result += simple[escape];
          index += 2;
          continue;
        }
        if (escape === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
          result += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
          index += 6;
          continue;
        }
        fail("This string has an invalid escape. Use `\\\\` for a backslash, as in Windows paths.");
      }
      if (char < " ") fail("Control characters are not allowed in a string.");
      result += char;
      index += 1;
    }
  };

  const parseValue = (depth: number): JsonNode => {
    if (depth > MAX_DEPTH) fail("The file is nested too deeply.");
    skipWhitespace();
    const start = position();
    const char = text[index];
    if (char === "{") {
      index += 1;
      const entries: JsonEntry[] = [];
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return { kind: "object", entries, ...start };
      }
      for (;;) {
        skipWhitespace();
        if (text[index] !== "\"") {
          fail(text[index] === "}" ? "Remove the comma before `}`." : `Expected a key in double quotes, found ${describe(text[index])}.`);
        }
        const keyPosition = position();
        const key = parseString();
        skipWhitespace();
        if (text[index] !== ":") fail(`Expected \`:\` after "${key}", found ${describe(text[index])}.`);
        index += 1;
        const value = parseValue(depth + 1);
        entries.push({ key, keyPosition, value });
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "}") {
          index += 1;
          return { kind: "object", entries, ...start };
        }
        fail(`Expected \`,\` or \`}\`, found ${describe(text[index])}.`);
      }
    }
    if (char === "[") {
      index += 1;
      const items: JsonNode[] = [];
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return { kind: "array", items, ...start };
      }
      for (;;) {
        skipWhitespace();
        if (text[index] === "]") fail("Remove the comma before `]`.");
        items.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "]") {
          index += 1;
          return { kind: "array", items, ...start };
        }
        fail(`Expected \`,\` or \`]\`, found ${describe(text[index])}.`);
      }
    }
    if (char === "\"") return { kind: "string", value: parseString(), ...start };
    const literal = /^(true|false|null)\b/.exec(text.slice(index, index + 6));
    if (literal) {
      index += literal[1]!.length;
      if (literal[1] === "null") return { kind: "null", ...start };
      return { kind: "boolean", value: literal[1] === "true", ...start };
    }
    const number = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (number && number[0].length > 0) {
      index += number[0].length;
      return { kind: "number", value: Number(number[0]), ...start };
    }
    if (char === "'") return fail("Use double quotes. JSON does not accept single quotes.");
    return fail(`Expected a value, found ${describe(char)}.`);
  };

  const root = parseValue(0);
  skipWhitespace();
  if (index < text.length) fail(`Unexpected ${describe(text[index])} after the end of the policy.`);
  return root;
}

/** Text of a policy file: UTF-8 with or without a byte order mark, or UTF-16 as Windows PowerShell 5 writes it. */
export function decodePolicyText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// One file, validated key by key.
// ---------------------------------------------------------------------------

export interface ManagedPolicyCatalog {
  providerIds: readonly ProviderId[];
  publicReferenceIds: readonly string[];
}

export interface ParsedPolicyFile {
  scope: ManagedPolicyScope;
  path: string;
  values: ManagedPolicyValues;
  /** Valid setting keys this file sets. */
  keys: ManagedPolicySettingKey[];
  /** The file's own `lock` list, or undefined when it has none (or an invalid one). */
  lock?: ManagedPolicySettingKey[];
  /** Where each top-level key starts, for problems found after the merge. */
  keyPositions: Partial<Record<string, JsonPosition>>;
  issues: ManagedPolicyIssue[];
}

const KNOWN_KEYS: ReadonlySet<string> = new Set(MANAGED_POLICY_KEYS);
const SETTING_KEYS: ReadonlySet<string> = new Set(MANAGED_POLICY_SETTING_KEYS);

function kindName(node: JsonNode): string {
  return node.kind === "object" ? "an object" : node.kind === "array" ? "a list" : node.kind === "null" ? "null" : `a ${node.kind}`;
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

export function parsePolicyFile(
  scope: ManagedPolicyScope,
  path: string,
  text: string,
  catalog: ManagedPolicyCatalog,
): ParsedPolicyFile {
  const result: ParsedPolicyFile = { scope, path, values: {}, keys: [], keyPositions: {}, issues: [] };
  const issue = (message: string, at?: JsonPosition, key?: string) => {
    result.issues.push({ scope, path, ...(at ? { line: at.line, column: at.column } : {}), ...(key ? { key } : {}), message });
  };
  if (text.trim().length === 0) {
    issue("The file is empty. Remove it, or add a JSON object such as { \"allowedProviders\": [\"ollama\"] }.");
    return result;
  }
  let root: JsonNode;
  try {
    root = parseJsonDocument(text);
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      issue(`The file is not valid JSON. ${error.message} No setting from this file is applied.`, error.position);
      return result;
    }
    throw error;
  }
  if (root.kind !== "object") {
    issue(`The policy must be a JSON object in { }, not ${kindName(root)}. No setting from this file is applied.`, root);
    return result;
  }

  const seen = new Map<string, JsonEntry>();
  for (const entry of root.entries) {
    if (seen.has(entry.key)) {
      issue(`"${entry.key}" appears more than once. Only the last one is used; remove the others.`, entry.keyPosition, entry.key);
    }
    seen.set(entry.key, entry);
  }

  for (const [key, entry] of seen) {
    result.keyPositions[key] = entry.keyPosition;
    const node = entry.value;
    const at = entry.keyPosition;
    if (!KNOWN_KEYS.has(key)) {
      const lower = key.toLowerCase();
      const suggestion = MANAGED_POLICY_KEYS.find((known) => known.toLowerCase() === lower);
      issue(
        suggestion
          ? `"${key}" is not a policy key. Keys are case-sensitive: use "${suggestion}".`
          : `"${key}" is not a policy key, so it is not applied. Keys this version reads: ${quoteList(MANAGED_POLICY_KEYS.filter((known) => known !== "$schema"))}.`,
        at,
        key,
      );
      continue;
    }
    switch (key) {
      case "$schema":
        if (node.kind !== "string") issue(`"$schema" must be a string, not ${kindName(node)}.`, node, key);
        break;
      case "version":
        if (node.kind !== "number" || node.value !== MANAGED_POLICY_VERSION) {
          issue(
            `"version" must be ${MANAGED_POLICY_VERSION}, the policy format this app reads. The other keys are still read as version ${MANAGED_POLICY_VERSION}.`,
            node,
            key,
          );
        }
        break;
      case "allowedProviders":
      case "allowedPublicReferences": {
        if (node.kind !== "array") {
          issue(`"${key}" must be a list of ids in [ ], not ${kindName(node)}. It is not applied.`, node, key);
          break;
        }
        const known = key === "allowedProviders" ? catalog.providerIds : catalog.publicReferenceIds;
        const what = key === "allowedProviders" ? "provider" : "public reference";
        const ids: string[] = [];
        for (const item of node.items) {
          if (item.kind !== "string") {
            issue(`"${key}" lists ${kindName(item)}. Every entry must be a ${what} id in double quotes; this entry is ignored.`, item, key);
            continue;
          }
          if (!known.includes(item.value)) {
            issue(`"${key}" lists "${item.value}", which is not a ${what} id. This entry is ignored. Ids: ${quoteList(known)}.`, item, key);
            continue;
          }
          if (!ids.includes(item.value)) ids.push(item.value);
        }
        // Entries that are not valid are dropped, never the restriction: a typo allows less, not more.
        if (key === "allowedProviders") result.values.allowedProviders = ids as ProviderId[];
        else result.values.allowedPublicReferences = ids;
        result.keys.push(key);
        break;
      }
      case "defaultProvider":
        if (node.kind !== "string" || !catalog.providerIds.includes(node.value as ProviderId)) {
          issue(
            node.kind === "string"
              ? `"defaultProvider" is "${node.value}", which is not a provider id. It is not applied. Ids: ${quoteList(catalog.providerIds)}.`
              : `"defaultProvider" must be a provider id in double quotes, not ${kindName(node)}. It is not applied.`,
            node,
            key,
          );
          break;
        }
        result.values.defaultProvider = node.value as ProviderId;
        result.keys.push(key);
        break;
      case "defaultModel":
        if (node.kind !== "string" || node.value.trim().length === 0 || node.value.trim().length > MODEL_MAX_LENGTH) {
          issue(`"defaultModel" must be a model name in double quotes, at most ${MODEL_MAX_LENGTH} characters. It is not applied.`, node, key);
          break;
        }
        result.values.defaultModel = node.value.trim();
        result.keys.push(key);
        break;
      case "skipFirstRunScan":
        if (node.kind !== "boolean") {
          issue(`"skipFirstRunScan" must be true or false without quotes, not ${kindName(node)}. It is not applied.`, node, key);
          break;
        }
        result.values.skipFirstRunScan = node.value;
        result.keys.push(key);
        break;
      case "appRegistration": {
        const registration = parseRegistration(node, (message, position) => issue(message, position, key));
        if (registration) {
          result.values.appRegistration = registration;
          result.keys.push(key);
        }
        break;
      }
      case "lock": {
        if (node.kind !== "array") {
          issue(`"lock" must be a list of setting keys in [ ], not ${kindName(node)}. Every key this file sets is locked instead.`, node, key);
          break;
        }
        const lock: ManagedPolicySettingKey[] = [];
        for (const item of node.items) {
          if (item.kind !== "string" || !SETTING_KEYS.has(item.value)) {
            issue(
              `"lock" lists ${item.kind === "string" ? `"${item.value}"` : kindName(item)}, which is not a setting key. This entry is ignored. Setting keys: ${quoteList(MANAGED_POLICY_SETTING_KEYS)}.`,
              item,
              key,
            );
            continue;
          }
          if (!lock.includes(item.value as ManagedPolicySettingKey)) lock.push(item.value as ManagedPolicySettingKey);
        }
        result.lock = lock;
        break;
      }
    }
  }
  return result;
}

function parseRegistration(
  node: JsonNode,
  issue: (message: string, position: JsonPosition) => void,
): ManagedPolicyAppRegistration | undefined {
  if (node.kind !== "object") {
    issue(`"appRegistration" must be an object such as { "clientId": "..." }, not ${kindName(node)}. It is not applied.`, node);
    return undefined;
  }
  const fields = new Map(node.entries.map((entry) => [entry.key, entry]));
  let valid = true;
  for (const entry of node.entries) {
    if (!["clientId", "tenantId", "label"].includes(entry.key)) {
      issue(`"appRegistration" has "${entry.key}", which it does not read. Use "clientId", "tenantId" and "label".`, entry.keyPosition);
    }
  }
  const clientId = fields.get("clientId")?.value;
  if (!clientId) {
    issue("\"appRegistration\" needs \"clientId\", the Application (client) ID of your Entra app registration. It is not applied.", node);
    return undefined;
  }
  if (clientId.kind !== "string" || !CLIENT_ID_PATTERN.test(clientId.value.trim())) {
    issue("\"appRegistration.clientId\" must be the Application (client) ID GUID from Entra. It is not applied.", clientId);
    valid = false;
  }
  const tenantId = fields.get("tenantId")?.value;
  if (tenantId && (tenantId.kind !== "string" || !DIRECTORY_PATTERN.test(tenantId.value.trim()))) {
    issue("\"appRegistration.tenantId\" must be a Directory (tenant) ID or a verified domain such as contoso.onmicrosoft.com. The registration is not applied.", tenantId);
    valid = false;
  }
  const label = fields.get("label")?.value;
  if (label && (label.kind !== "string" || label.value.trim().length === 0 || label.value.trim().length > LABEL_MAX_LENGTH)) {
    issue(`"appRegistration.label" must be text of at most ${LABEL_MAX_LENGTH} characters. The registration is not applied.`, label);
    valid = false;
  }
  if (!valid || clientId.kind !== "string") return undefined;
  return {
    clientId: clientId.value.trim().toLowerCase(),
    ...(tenantId?.kind === "string" ? { tenantId: tenantId.value.trim() } : {}),
    ...(label?.kind === "string" ? { label: label.value.trim() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Both files merged: the machine file wins, key by key.
// ---------------------------------------------------------------------------

export interface ManagedPolicyFileRead {
  scope: ManagedPolicyScope;
  path: string;
  /** Undefined when no file exists at the path. */
  parsed?: ParsedPolicyFile;
  /** A file that exists but could not be read. */
  readIssue?: ManagedPolicyIssue;
}

export function mergeManagedPolicy(reads: readonly ManagedPolicyFileRead[]): ManagedPolicyStatus | undefined {
  if (!reads.some((read) => read.parsed || read.readIssue)) return undefined;
  const ordered = [...reads].sort((left, right) => (left.scope === right.scope ? 0 : left.scope === "machine" ? -1 : 1));
  const values: ManagedPolicyValues = {};
  const sources: ManagedPolicyStatus["sources"] = {};
  const locked: ManagedPolicySettingKey[] = [];
  const issues: ManagedPolicyIssue[] = [];
  const winner = new Map<ManagedPolicySettingKey, ParsedPolicyFile>();
  for (const read of ordered) {
    if (read.readIssue) issues.push(read.readIssue);
    if (!read.parsed) continue;
    issues.push(...read.parsed.issues);
    for (const key of read.parsed.keys) {
      if (winner.has(key)) continue;
      winner.set(key, read.parsed);
      (values as Record<string, unknown>)[key] = read.parsed.values[key];
      sources[key] = read.scope;
      // No `lock` list locks every key the file sets.
      if ((read.parsed.lock ?? read.parsed.keys).includes(key)) locked.push(key);
    }
  }
  const drop = (key: ManagedPolicySettingKey, message: string) => {
    const file = winner.get(key)!;
    const at = file.keyPositions[key];
    issues.push({ scope: file.scope, path: file.path, ...(at ? { line: at.line, column: at.column } : {}), key, message });
    delete values[key];
    delete sources[key];
    const index = locked.indexOf(key);
    if (index >= 0) locked.splice(index, 1);
  };
  if (values.defaultProvider && values.allowedProviders && !values.allowedProviders.includes(values.defaultProvider)) {
    drop("defaultProvider", `"defaultProvider" is "${values.defaultProvider}", which "allowedProviders" does not allow. It is not applied.`);
  }
  if (values.defaultModel && !values.defaultProvider) {
    drop("defaultModel", "\"defaultModel\" needs a valid \"defaultProvider\" to say which provider the model belongs to. It is not applied.");
  }
  const order = (key: ManagedPolicySettingKey) => MANAGED_POLICY_SETTING_KEYS.indexOf(key);
  return {
    files: ordered.map((read) => ({ scope: read.scope, path: read.path, found: Boolean(read.parsed || read.readIssue) })),
    values,
    sources,
    locked: locked.sort((left, right) => order(left) - order(right)),
    issues,
  };
}

export interface LoadManagedPolicyOptions extends ManagedPolicyCatalog {
  paths: readonly ManagedPolicyPath[];
  read?: (path: string) => Promise<Uint8Array>;
}

export async function loadManagedPolicy(options: LoadManagedPolicyOptions): Promise<ManagedPolicyStatus | undefined> {
  const read = options.read ?? ((path: string) => readFile(path));
  const reads: ManagedPolicyFileRead[] = [];
  for (const { scope, path } of options.paths) {
    let bytes: Uint8Array;
    try {
      bytes = await read(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        reads.push({ scope, path });
        continue;
      }
      const reason =
        code === "EACCES" || code === "EPERM"
          ? "OpenAdminOS has no permission to read it. Make it readable for every user (for example 644 on macOS and Linux)."
          : code === "EISDIR"
            ? "The path is a folder, not a file."
            : `It could not be read (${code ?? "unknown error"}).`;
      reads.push({ scope, path, readIssue: { scope, path, message: `${reason} No setting from this file is applied.` } });
      continue;
    }
    if (bytes.byteLength > MANAGED_POLICY_MAX_BYTES) {
      reads.push({
        scope,
        path,
        readIssue: { scope, path, message: `The file is larger than ${MANAGED_POLICY_MAX_BYTES / 1024} KB, so it is not read. No setting from this file is applied.` },
      });
      continue;
    }
    reads.push({ scope, path, parsed: parsePolicyFile(scope, path, decodePolicyText(bytes), options) });
  }
  return mergeManagedPolicy(reads);
}

/** The paths this build reads. Unpackaged builds may point them elsewhere for development and tests. */
export function resolveManagedPolicyPaths(input: { packaged: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string }): ManagedPolicyPath[] {
  const env = input.env ?? process.env;
  const paths = managedPolicyPaths({ platform: input.platform ?? process.platform, env, home: input.home ?? homedir() });
  if (input.packaged) return paths;
  return paths.map((entry) => {
    const override = entry.scope === "machine" ? env.OPENADMINOS_POLICY_MACHINE_PATH : env.OPENADMINOS_POLICY_USER_PATH;
    return override ? { ...entry, path: override } : entry;
  });
}

// ---------------------------------------------------------------------------
// Fingerprints, so a change between launches is recorded once.
// ---------------------------------------------------------------------------

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Changes when a value, its source file or its lock changes. */
export function managedPolicyFingerprint(status: ManagedPolicyStatus): string | undefined {
  const keys = MANAGED_POLICY_SETTING_KEYS.filter((key) => status.values[key] !== undefined);
  if (keys.length === 0) return undefined;
  return digest(keys.map((key) => [key, status.values[key], status.sources[key], status.locked.includes(key)]));
}

/** Changes when the reported problems change. */
export function managedPolicyIssuesFingerprint(status: ManagedPolicyStatus): string | undefined {
  if (status.issues.length === 0) return undefined;
  return digest(status.issues.map((entry) => [entry.path, entry.line, entry.column, entry.message]));
}

/** One line per problem, as Settings and the audit log show it. */
export function describeManagedPolicyIssue(entry: ManagedPolicyIssue): string {
  return `${entry.path}${entry.line ? `, line ${entry.line}` : ""}: ${entry.message}`;
}

/** A request the IT policy file does not allow. Raised in the main process, whatever the renderer shows. */
export class ManagedPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedPolicyError";
  }
}

export function providerNotAllowedMessage(providerName: string): string {
  return `Your IT department does not allow ${providerName} on this device. The policy file sets which providers you can use.`;
}

export function providerLockedMessage(providerName: string): string {
  return `Your IT department set ${providerName} as the provider on this device. It cannot be changed in the app.`;
}

export function modelLockedMessage(model: string, providerName: string): string {
  return `Your IT department set ${model} as the ${providerName} model on this device. It cannot be changed in the app.`;
}

export function publicReferenceNotAllowedMessage(name: string): string {
  return `Your IT department does not allow ${name} on this device. Nothing was sent.`;
}

export function registrationLockedMessage(label: string): string {
  return `Your IT department set the app registration ${label} for sign-in on this device. Sign in with it, or ask IT to change the policy.`;
}
