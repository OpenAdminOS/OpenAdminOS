import { isIP } from "node:net";
import {
  DATA_CLASSES_BY_SENSITIVITY,
  type ClassifiedCounts,
  type DataClass,
} from "@openadminos/agent-sdk";
import { GRAPH_FIELD_CLASSES } from "./graph-field-classes.js";

export interface DataClassification {
  /** JSON Pointers into the classified value. The empty pointer denotes the root. */
  classes: Readonly<Record<string, DataClass>>;
  /** Each scalar, null or empty container contributes one count. */
  counts: ClassifiedCounts;
}

export interface ClassificationOptions {
  graphPath?: string;
  publicReference?: boolean;
  /** Match values already known to the active organization using its local index. */
  identityIndex?: { matches(text: string): boolean };
}

export interface ClassifiedSource {
  source: string;
  classification: DataClassification;
}

export interface PromptClassification {
  fenced: readonly ClassifiedSource[];
  /** Source reads can contain fields which projections or transformations omit. */
  reads: readonly { source: string; counts: ClassifiedCounts }[];
}

// A symbol stays with host option copies and is omitted by JSON serialization.
const PROMPT_CLASSIFICATION = Symbol("promptClassification");
type ClassifiedPromptOptions = { [PROMPT_CLASSIFICATION]?: PromptClassification };

// TODO(ugur): Should the host classification sidecar use these names when provider routing consumes it?
export function withPromptClassification<T extends object>(options: T, classification: PromptClassification): T {
  return Object.assign(options, { [PROMPT_CLASSIFICATION]: classification });
}

export function getPromptClassification(options: object): PromptClassification | undefined {
  return (options as ClassifiedPromptOptions)[PROMPT_CLASSIFICATION];
}

// Shared with the existing MCP egress guard. Keep its original detection semantics.
export const PRIVATE_PATTERN = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:sk-proj-|bearer\s)/i;

const CREDENTIAL_PATTERNS = [
  /\b\d{6}(?:-\d{6}){7}\b/,
  /\b[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}\b/i,
  /-----BEGIN [A-Z0-9 ]+-----/i,
  /\b(?:sk-(?:proj-)?|sk-ant-api\d{2}-|github_pat_|gh[opsuhr]_|xox[abprs]-|xapp-|npm_|vercel_)[a-z0-9_-]{16,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /\bsk-proj-/i,
];

const CREDENTIAL_NAMES = [
  "password", "laps(?:[ _-]*password)?", "password[ _-]*base64", "device[ _-]*account[ _-]*password",
  "client[ _-]*secret(?:[ _-]*hint)?", "secret[ _-]*text", "secret", "access[ _-]*token", "refresh[ _-]*token",
  "id[ _-]*token", "api[ _-]*key", "private[ _-]*key", "pre[ _-]*shared[ _-]*key", "shared[ _-]*secret",
  "(?:(?:bitlocker|filevault)[ _-]*)?recovery[ _-]*key",
  "(?:autopilot[ _-]*)?product[ _-]*key", "activation[ _-]*lock[ _-]*bypass[ _-]*code",
].join("|");
const CREDENTIAL_FIELD = new RegExp(`^(?:${CREDENTIAL_NAMES})$`, "i");
const LABELED_CREDENTIAL = new RegExp(
  `\\b(?:${CREDENTIAL_NAMES})["']?\\s*[:=]\\s*["']?\\s*(?!null\\b|true\\b|false\\b|undefined\\b|["']|\\s)[^\\s,;}\\]]+`,
  "i",
);
const CREDENTIAL_AUDIT_VALUE = /^(?:oldValue|newValue)$/i;
const DESCRIPTIVE_FIELD = /description|notes?|publisher|rule|uri|url|name|comment|summary|details|reason|title|message|oldValue|newValue/i;
const IDENTIFIER_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b/i;
const EMAIL_PATTERN = /(?<![\w.+-])[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i;
const IP_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b|(?<![\da-f:])[\da-f:]*:[\da-f:]+(?![\da-f:])/gi;
const PHONE_NUMBER = /(?<!\w)(?:\+[1-9]\d{0,2}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/;
const MAC_ADDRESS = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i;
const GRAPH_ENTITY_ID = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[^/]+(?:@|%40)[^/]+)$/i;

type FieldMap = ReadonlyMap<string, DataClass>;

function pointerPart(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

const fieldMaps = new Map<string, FieldMap>();
for (const [path, groups] of Object.entries(GRAPH_FIELD_CLASSES)) {
  const fields = new Map<string, DataClass>();
  for (const kind of DATA_CLASSES_BY_SENSITIVITY) {
    for (const field of groups[kind]?.trim().split(/\s+/) ?? []) {
      const parts = field.split(/(?<!@odata)\./).map((part) => pointerPart(part).replace(/\[\]$/, "/[]"));
      const pattern = `/${parts.join("/")}`;
      if (!fields.has(pattern)) fields.set(pattern, kind);
    }
  }
  fieldMaps.set(path.toLowerCase(), fields);
}

export function hasGraphFieldClasses(graphPath: string): boolean {
  return graphFields(graphPath) !== undefined;
}

function graphFields(graphPath: string): FieldMap | undefined {
  const path = graphPath.split(/[?#]/, 1)[0]!.replace(/^\/(?:beta|v1\.0)(?=\/)/i, "")
    .replace(/\/$/, "").toLowerCase();
  const exact = fieldMaps.get(path);
  if (exact) return exact;
  const segments = path.split("/");
  if (segments.length > 3 && GRAPH_ENTITY_ID.test(segments.at(-2)!)) {
    const operation = segments.at(-1)!.split("(", 1)[0]!;
    const actionPath = [...segments.slice(0, -2), "{id}", operation].join("/");
    const action = fieldMaps.get(actionPath);
    if (action) return action;
  }
  const id = segments.pop()!;
  const parent = segments.join("/");
  if (GRAPH_ENTITY_ID.test(id) || (/^[\w.-]+\.[a-z]+$/i.test(id) && parent === "/domains")) {
    return fieldMaps.get(parent);
  }
  return undefined;
}

function higherClass(current: DataClass, candidate: DataClass): DataClass {
  return DATA_CLASSES_BY_SENSITIVITY.indexOf(candidate) < DATA_CLASSES_BY_SENSITIVITY.indexOf(current)
    ? candidate : current;
}

function isPrivateIp(value: string): boolean {
  if (isIP(value) === 4) {
    const [first, second] = value.split(".").map(Number);
    return first === 10 || (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && second === 168) || (first === 169 && second === 254);
  }
  return isIP(value) === 6 && /^(?:f[cd]|fe[89ab])/i.test(value);
}

function detectValueClass(text: string, detectIdentifiers: boolean, options: ClassificationOptions): DataClass {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text)) || LABELED_CREDENTIAL.test(text)) {
    return "credential";
  }
  if (!detectIdentifiers) return "public";
  const ips = text.match(IP_ADDRESS)?.filter((value) => isIP(value) !== 0) ?? [];
  const withoutIps = text.replace(IP_ADDRESS, (value) => isIP(value) === 0 ? value : " ");
  if (IDENTIFIER_PATTERN.test(withoutIps) || (withoutIps.includes("@") && EMAIL_PATTERN.test(withoutIps)) ||
      ips.some((value) => !isPrivateIp(value)) || PHONE_NUMBER.test(text) ||
      options.identityIndex?.matches(text)) return "identity";
  return ips.length > 0 || MAC_ADDRESS.test(text) ? "device" : "public";
}

// TODO(ugur): Should classifyData and countDataClasses stay on the runtime data-classification subpath?
/** Classify the actual response or a projected row set, using only local data. */
export function classifyData(value: unknown, options: ClassificationOptions = {}): DataClassification {
  const classes: Record<string, DataClass> = {};
  const counts = walkDataClasses(value, options, (pointer, kind) => { classes[pointer] = kind; });
  return { classes, counts };
}

/** Summarize source reads without retaining a path table for every page. */
export function countDataClasses(value: unknown, options: ClassificationOptions = {}): ClassifiedCounts {
  return walkDataClasses(value, options);
}

function walkDataClasses(
  value: unknown,
  options: ClassificationOptions,
  onField?: (pointer: string, kind: DataClass) => void,
): ClassifiedCounts {
  const fields = options.graphPath ? graphFields(options.graphPath) : undefined;
  const base = options.publicReference && options.graphPath === undefined ? "public" : "identity";
  const counts: ClassifiedCounts = {
    credential: 0, identity: 0, device: 0, activity: 0, configuration: 0, public: 0,
  };
  type PendingField = {
    value: unknown;
    pointer: string;
    pattern: string;
    key: string;
    inherited: DataClass;
    root?: boolean;
    collection?: boolean;
  };
  const pending: PendingField[] = [{ value, pointer: "", pattern: "", key: "", inherited: "public", root: true }];
  while (pending.length) {
    const field = pending.pop()!;
    const { value: child, pointer, pattern, key } = field;
    const wildcard = pattern.startsWith("/authenticationMethodConfigurations/[]/featureSettings/")
      ? pattern.replace(/(\/featureSettings)\/[^/]+/, "$1/*") : pattern;
    const mapped = fields?.get(pattern) ?? fields?.get(wildcard);
    let kind = higherClass(mapped ?? base, field.inherited);
    if (/^@odata\.(?:nextLink|deltaLink)$/i.test(key)) kind = higherClass(kind, "identity");
    if (CREDENTIAL_FIELD.test(key)) kind = "credential";
    // Public references can put private values in keys as well as values.
    const keyClass = base === "public" && key ? detectValueClass(key, true, options) : "public";
    kind = higherClass(kind, keyClass);
    const entries = child !== null && typeof child === "object" ? Object.entries(child) : [];
    if (entries.length > 0) {
      const record = child as Record<string, unknown>;
      const array = Array.isArray(child);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [prop, item] = entries[index]!;
        const part = pointerPart(prop);
        const propertyPattern = prop === "[]" ? "~2" : prop === "*" ? "~3" : part;
        const auditCredential = CREDENTIAL_AUDIT_VALUE.test(prop) &&
          typeof record.displayName === "string" && CREDENTIAL_FIELD.test(record.displayName);
        const inherited = kind === "credential" || auditCredential ? "credential" : higherClass(field.inherited, keyClass);
        pending.push({
          value: item,
          pointer: onField ? `${pointer}/${part}` : "",
          pattern: !fields || (array && (field.root || field.collection))
            ? "" : `${pattern}/${array ? "[]" : propertyPattern}`,
          key: array ? key : prop,
          inherited,
          collection: Boolean(fields && field.root && prop === "value" && Array.isArray(item)),
        });
      }
      continue;
    }
    if (typeof child === "string" && kind !== "credential") {
      const scanIdentifiers = mapped === undefined || DESCRIPTIVE_FIELD.test(key);
      kind = higherClass(kind, detectValueClass(child, scanIdentifiers, options));
    }
    onField?.(pointer, kind);
    counts[kind] += 1;
  }
  return counts;
}
