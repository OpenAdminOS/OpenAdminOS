import { isIP } from "node:net";
import type { TenantValueIndex } from "./tenant-value-index.js";
import {
  DATA_CLASSES_BY_SENSITIVITY,
  maxDataClass,
  type DataClassCounts,
  type DataClass,
} from "@openadminos/agent-sdk";
import {
  GRAPH_DEVICE_NAME_FIELDS, GRAPH_FIELD_CLASSES, GRAPH_LEGACY_ENDPOINT_SECURITY_FIELDS, GRAPH_ROUTE_ALIASES, graphSecurityMaskRole,
  GRAPH_SECURITY_RESOURCES, GRAPH_TEXT_FIELDS, type SecurityMaskRole,
} from "./graph-field-classes.js";

export { GRAPH_FIELD_CLASSES_VERSION } from "./graph-field-classes.js";
export { ClassificationWorkerRetiredError, releaseClassificationIdentityShard, retireClassificationWorker, shutdownClassificationWorker } from "./classification-worker-client.js";
export { CLASSIFICATION_TTL_MS, ClassificationLedger, clearTenantClassificationLedgers, currentClassificationLedger, classificationDiagnostics, collectClassifiedValues, registerClassifiedValues, registerGraphTenantData, registerRenderedFragment, registerTenantData, registerTransientTenantData, withTransientClassificationScope, withClassificationScope, withRequestClassification } from "./request-classification.js";
export type { ClassifiedValues, ClassificationSpan, RequestClassification, RequestClassificationEvent, TemplateInterpolation } from "./request-classification.js";

export { ClassificationSlice, classifyCacheRows, yieldClassificationTurn } from "./classification-worker-client.js";
export {
  addCacheIdentity, addUserFirstName, describeCacheRow, INCOMPLETE_CACHE_CLASSIFICATION, MAX_READ_SIDECAR_UNITS,
  prepareCacheClassification, cacheClassificationFields, decodeCacheIdentityBatch, decodeCacheRowClassification, type CacheClassificationResult,
} from "./cache-classification.js";
export { collectTenantValues } from "./tenant-values.js";

export interface DataClassification {
  /** Original JSON Pointers. A truncated classification can cover the rest of a subtree. */
  classes: Readonly<Record<string, DataClass>>;
  counts: DataClassCounts;
  securityMaskRoles: Readonly<Record<string, SecurityMaskRole>>;
  budgetExhausted: boolean;
  /** The rest of the traversal starting at this pointer has the conservative class. */
  remainder?: { from: string; kind: DataClass };
}

export interface ClassificationOptions {
  graphPath?: string;
  publicReference?: boolean;
  identityIndex?: {
    matches(text: string): boolean;
    spans?(text: string): Iterable<{ start: number; end: number }>;
    isComplete?(): boolean;
    /** Immutable resource snapshots with normalized entries for the request worker. */
    workerShards?(): Iterable<TenantValueIndex>;
  };
  /** A host-side work limit. Each field and each scanned code unit costs one unit. */
  workBudget?: number;
}

// Shared with the existing MCP egress guard. Keep its original detection semantics.
export const PRIVATE_PATTERN = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:sk-proj-|bearer\s)/i;

const CREDENTIAL_PATTERNS = [
  /\b\d{6}(?:-\d{6}){7}\b/g,
  /\b[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}\b/gi,
  /\b(?:sk-(?:proj-)?|sk-ant-api\d{2}-|github_pat_|gh[opsuhr]_|xox[abprs]-|xapp-|npm_|vercel_)[a-z0-9_-]{16,}/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /\bsk-proj-/gi,
];

// Separators are normalized by the parser. Key matching is anchored so metadata such as
// preSharedKeyIsSet and token lifetimes do not become credentials.
const CREDENTIAL_FIELD = /^(?:password|laps(?:password)?|passwordbase64|deviceaccountpassword|clientsecret(?:hint)?|secrettext|secret|accesstoken|refreshtoken|idtoken|apikey|privatekey|presharedkey|sharedsecret|(?:bitlocker|filevault)?recoverykey|(?:autopilot)?productkey|activationlockbypasscode|connectionstring|accountkey|sastoken|temporaryaccesspass|certificatepassword)$/i;
// These Graph shapes retain their meaning when evidence nests the original response.
const CREDENTIAL_SHAPE = /\/(?:passwordcredentials\/\[\]\/(?:hint|secrettext)|keycredentials\/\[\]\/key)$/;
const CREDENTIAL_AUDIT_VALUE = /^(?:oldValue|newValue)$/i;
const IDENTIFIER = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b/gi;
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const IP_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b|(?<![\da-f:])[\da-f:]*:[\da-f:]+(?![\da-f:])/gi;
const PHONE_NUMBER = /(?<!\w)(?:\+[1-9]\d{0,2}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/g;
const MAC_ADDRESS = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi;
const SECURITY_IDENTITY_KEYS = /^(?:user|group|(?:(?:include|exclude|target)?(?:users?|groups?|principals?)ids?|(?:include|exclude|target)(?:users|groups))|userprincipalname|userdisplayname|principaldisplayname|principal)$/i;
const SECURITY_ODATA_TYPE = /^(?:.*(?:endpointsecurity|securitybaseline|defender|firewall|diskencryption|attacksurfacereduction|antivirus|authenticationmethod|conditionalaccess|namedlocation|roleassignment|roledefinition|rolesetting|crosstenantaccess).*|(?:windows(?:10|81)|macos)endpointprotectionconfiguration|bitlockerencryptionpolicy)$/i;
const SECURITY_ENDPOINT_SETTING_ID = /(?:^|[_./:-])(?:bitlocker|filevault2?|deviceguard|dmaguard|systemguard|localpoliciessecurityoptions)(?:$|[_./:-])/i;
const SETTINGS_PATH = /^(?:\/devicemanagement\/(?:configurationpolicies|intents|grouppolicyconfigurations)$)|\/(?:settings|definitionvalues|presentationvalues)$/;
const SECRET_SETTING_TYPE = /(?:secret|password)(?:setting|presentation|value)|(?:setting|presentation|value)password$/i;
const SECRET_SETTING_ID = /(?:^|[_/.:-])(?:password|presharedkey|privatekey|sharedsecret|accountkey|certificatepassword|sastoken|connectionstring)(?:$|[_/.:-])/i;
const SETTING_VALUE_KEYS = /^(?:value|values|valuejson|stringvalue|settingvalue|settingvalues|secretsettingvalue|secretsettingvalues|encryptedvalue|defaultvalue)$/i;

export interface TextSpan {
  start: number;
  end: number;
}

function isCredentialField(key: string): boolean {
  return CREDENTIAL_FIELD.test(key.replace(/[ _-]/g, ""));
}

/** Parse a bounded label and consume whitespace once before reading a value. */
export function* labeledCredentials(text: string): Iterable<TextSpan> {
  if (!text.includes(":") && !text.includes("=")) return;
  const separators = /[:=]/g;
  for (let separator; (separator = separators.exec(text)); ) {
    const { index } = separator;
    let end = index;
    while (end > 0 && /\s/.test(text[end - 1]!)) end--;
    if (text[end - 1] === '"' || text[end - 1] === "'") end--;
    if (text[end - 1] === "\\") end--;
    let start = end;
    // Match field names with a bounded number of internal spaces or separators.
    const label = text.slice(Math.max(0, end - 64), end);
    const tokens = label.match(/[\w -]+$/)?.[0].trim() ?? "";
    start -= tokens.length;
    let suffix = tokens;
    while (suffix && !isCredentialField(suffix)) {
      const space = suffix.indexOf(" ");
      if (space < 0) break;
      start += space + 1;
      suffix = suffix.slice(space + 1).trimStart();
    }
    if (!isCredentialField(suffix) || /[\w-]/.test(text[start - 1] ?? "")) continue;
    let first = index + 1;
    while (first < text.length && /\s/.test(text[first]!)) first++;
    const escapedQuote = text.startsWith('\\"', first);
    if (escapedQuote) first++;
    const quote = text[first] === '"' || text[first] === "'" ? text[first++] : undefined;
    let last = first;
    while (last < text.length && (quote
      ? text[last] !== quote && text[last] !== "\n" && !(escapedQuote && text.startsWith('\\"', last))
      : !/[\s,}\]"'[\{]/.test(text[last]!) &&
        (text[last] !== ";" || suffix.replace(/[ _-]/g, "").toLowerCase() === "connectionstring"))) last++;
    separators.lastIndex = Math.max(separators.lastIndex, last);
    if (last === first || (quote && !text.slice(first, last).trim()) || (!quote && /^(?:null|true|false|undefined)$/i.test(text.slice(first, last)))) continue;
    yield { start: first, end: last };
  }
}

const ENCODED_LIMIT = 32_768;

function* pemSpans(text: string): Iterable<TextSpan> {
  if (!text.includes("-----")) return;
  let pending: (TextSpan & { label: string }) | undefined;
  for (const marker of text.matchAll(/-----(BEGIN|END) ([A-Z0-9 ]{1,80})-----/gi)) {
    const label = marker[2]!.toLowerCase();
    const end = marker.index + marker[0].length;
    if (marker[1]!.toUpperCase() === "BEGIN") {
      if (pending) yield { start: pending.start, end: pending.end };
      pending = { start: marker.index, end, label };
    } else if (pending?.label === label) {
      yield { start: pending.start, end };
      pending = undefined;
    }
  }
  if (pending) yield { start: pending.start, end: pending.end };
}

function* credentialSpans(text: string, decode = true): IterableIterator<TextSpan> {
  for (const pattern of CREDENTIAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) yield { start: match.index, end: match.index + match[0].length };
  }
  yield* pemSpans(text);
  yield* labeledCredentials(text);
  if (text.includes(".")) {
    // A compact JWT can use different whitespace and property order in its header.
    for (const match of text.matchAll(/(?<![\w-])([\w-]{8,2048})\.[\w-]+\.([\w-]*)(?![\w-])/g)) {
      try {
        const header: unknown = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
        if (header && typeof header === "object" && "alg" in header && typeof header.alg === "string" && (match[2] || header.alg === "none")) {
          yield { start: match.index, end: match.index + match[0].length };
        }
      } catch { /* Ordinary dotted strings are common. */ }
    }
  }
  if (!decode) return;
  if (text.includes("%")) {
    // Decode at most one layer and keep offsets in the original text.
    for (const match of text.matchAll(/[^\s"'<>]{1,32768}/g)) {
      if (!/%[0-9a-f]{2}/i.test(match[0])) continue;
      try {
        const decoded = decodeURIComponent(match[0]);
        if (!credentialSpans(decoded, false).next().done || hasWrappedPem(decoded)) {
          yield { start: match.index, end: match.index + match[0].length };
        }
      } catch { /* Invalid percent escapes do not change the original text. */ }
    }
  }
  // PEM begins with five ASCII hyphens, whose base64 prefix is stable.
  for (const match of text.matchAll(/(?<![\w+/])LS0tLS1[A-Za-z0-9+/_=-]{8,32761}/g)) {
    if (hasWrappedPem(match[0])) yield { start: match.index, end: match.index + match[0].length };
  }
}

function hasWrappedPem(text: string): boolean {
  return text.length <= ENCODED_LIMIT && text.startsWith("LS0tLS1") &&
    /^-----BEGIN [A-Z0-9 ]{1,80}-----/i.test(Buffer.from(text, "base64").toString("utf8"));
}

const ENCODED_UPN = /(?<![\w.+%-])[\w.+-]+(?:%[0-9a-f]{2}[\w.+-]*)*%40[\w.-]+(?:\.|%2e)[a-z]{2,}\b/gi;
const SERIAL = /\b(?:serial(?:[ _-]*number)?[ :=]+)([a-z0-9-]{6,40})\b/gi;

function* identifierSpans(text: string, kind: DataClass, allowGenericIdentifiers = true): Iterable<TextSpan & { kind: DataClass; source: string }> {
  const security = kind === "security";
  const patterns: ReadonlyArray<readonly [RegExp, DataClass, string]> = [
    [IDENTIFIER, "identity", "identifier"], [EMAIL, "identity", "email"],
    [ENCODED_UPN, "identity", "encoded-upn"], [PHONE_NUMBER, "identity", "phone"],
    [MAC_ADDRESS, "device", "mac"], [IP_ADDRESS, "device", "ip"],
    [SERIAL, "device", "serial"],
  ];
  for (const [pattern, defaultKind, source] of patterns) {
    if ((!allowGenericIdentifiers || security) && source === "identifier" || source === "email" && !text.includes("@") ||
        source === "encoded-upn" && !text.includes("%40") ||
        source === "ip" && !text.includes(":") && !text.includes(".")) continue;
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[0];
      const end = match.index + match[0].length;
      if (source === "ip" && (!isIP(value) || /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(value))) continue;
      if (source === "serial" && !/\d/.test(value)) continue;
      const kind = source === "ip" && !security && !isPrivateIp(value) ? "identity" : defaultKind;
      yield { start: end - value.length, end, kind, source: `detector:${source}` };
    }
  }
}

export function* requestTextSpans(text: string, index?: ClassificationOptions["identityIndex"]): Iterable<TextSpan & { kind: DataClass; source: string }> {
  for (const span of credentialSpans(text)) yield { ...span, kind: "credential", source: "detector:credential" };
  yield* identifierSpans(text, "public");
  for (const span of index?.spans?.(text) ?? []) {
    const value = text.slice(span.start, span.end);
    if (!isUnlabeledScalar(value)) yield { ...span, kind: "identity", source: "detector:tenant-index" };
  }
  if (index && !index.spans) {
    for (const match of text.matchAll(/[\p{L}\p{N}_-]+/gu)) {
      if (!isUnlabeledScalar(match[0]) && index.matches(match[0])) {
        yield { start: match.index, end: match.index + match[0].length, kind: "identity", source: "detector:tenant-index" };
      }
    }
  }
}

function isUnlabeledScalar(text: string): boolean {
  return /^(?:true|false|[+-]?\p{N}{1,6})$/iu.test(text);
}

type FieldMap = ReadonlyMap<string, DataClass>;

function pointerPart(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function mappedParts(field: string): string[] {
  return field.toLowerCase().split(/(?<!@odata)\./).flatMap((part) =>
    part.endsWith("[]") ? [part.slice(0, -2), "[]"] : [part]);
}

const fieldMaps = new Map<string, FieldMap>();
for (const [path, groups] of Object.entries(GRAPH_FIELD_CLASSES)) {
  const fields = new Map<string, DataClass>();
  for (const kind of DATA_CLASSES_BY_SENSITIVITY) {
    for (const field of groups[kind]?.trim().split(/\s+/) ?? []) {
      const pattern = "/" + mappedParts(field).map(pointerPart).join("/");
      if (!fields.has(pattern)) fields.set(pattern, kind);
      if (pattern.endsWith("/[]")) {
        const container = pattern.slice(0, -3);
        if (!fields.has(container)) fields.set(container, kind);
      }
    }
  }
  fieldMaps.set(path.toLowerCase(), fields);
}
const securityPaths = new Set([...GRAPH_SECURITY_RESOURCES].map(path => path.toLowerCase()));
const routeAliases = new Map(Object.entries(GRAPH_ROUTE_ALIASES).map(([from, to]) => [from.toLowerCase(), to.toLowerCase()]));
const knownPaths = new Set([...fieldMaps.keys(), ...securityPaths, ...routeAliases.keys()]);
const canonicalRoute = (route: string) => routeAliases.get(route) ?? route;
const routeBranches = [...knownPaths].filter(path => path.includes("{id}"))
  .sort((a, b) => b.split("/").length - a.split("/").length)
  .map(path => ({ path, parts: path.split("/") }));

function graphRoute(graphPath: string): string {
  const clean = graphPath.split(/[?#]/, 1)[0]!.replace(/^\/(?:beta|v1\.0)(?=\/)/i, "").replace(/\/$/, "");
  const segments = clean.split("/").flatMap(segment => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* Keep malformed segments opaque. */ }
    const key = /^([^()]+)\((.*)\)$/.exec(decoded);
    if (!key) return [decoded.replaceAll("/", "%2f").toLowerCase()];
    return key[2] ? [key[1]!.toLowerCase(), "{id}"] : [key[1]!.toLowerCase()];
  });
  const path = segments.join("/");
  if (knownPaths.has(path)) return canonicalRoute(path);
  for (const { path: known, parts } of routeBranches) {
    if ((parts.length === segments.length || parts.length === segments.length - 1) &&
        parts.every((part, index) => part === "{id}" || part === segments[index])) return canonicalRoute(known);
  }
  segments.pop();
  const parent = segments.join("/");
  if (knownPaths.has(parent)) return canonicalRoute(parent);
  // Security settings can be reached through navigation beneath a keyed security resource.
  for (const resource of securityPaths) {
    if (path.startsWith(resource + "/")) return resource;
  }
  return path;
}

const graphSourceRoutes = new Map([
  ...Object.keys(GRAPH_FIELD_CLASSES), ...GRAPH_SECURITY_RESOURCES, ...Object.values(GRAPH_ROUTE_ALIASES),
].map(route => [route.toLowerCase(), route]));

/** Diagnostic labels may only contain static routes from the field map. */
export function graphClassificationSource(path: string): string {
  const route = graphSourceRoutes.get(graphRoute(path));
  return route ? `graph:${route}` : "graph:other";
}

export function hasGraphFieldClasses(graphPath: string): boolean {
  return knownPaths.has(graphRoute(graphPath));
}

/** A selected property can be mapped as a scalar, array, or parent of mapped fields. */
export function hasGraphFieldClass(graphPath: string, field: string): boolean {
  const route = graphRoute(graphPath);
  const pattern = "/" + mappedParts(field.replaceAll("/", ".")).map(pointerPart).join("/");
  return [...fieldMaps.get(route)?.keys() ?? []]
    .some(mapped => mapped === pattern || mapped.startsWith(pattern + "/"));
}

/** Class of a mapped Graph dimension after grouping, including detectors for the bucket spelling. */
export function classifyGraphDimension(
  graphPath: string, field: string, value: string, identityIndex?: ClassificationOptions["identityIndex"],
): { kind: DataClass; source: string; maskRole?: SecurityMaskRole } | undefined {
  const route = graphRoute(graphPath);
  const parts = mappedParts(field);
  const pattern = "/" + parts.map(pointerPart).join("/");
  if (!fieldMaps.get(route)?.has(pattern)) return undefined;
  const record = parts.reduceRight<unknown>((child, key) => ({ [key]: child }), value);
  let evidence: ReturnType<typeof classifyGraphDimension>;
  walkDataClasses(record, { graphPath, identityIndex }, (_value, kind, _pointer, _key, maskRole) => {
    evidence = { kind, source: graphClassificationSource(graphPath), ...(maskRole ? { maskRole } : {}) };
  });
  return evidence;
}

function detectValueClass(text: string, detectIdentifiers: boolean, options: ClassificationOptions, kind: DataClass): DataClass {
  if (credentialSpans(text).next().done === false) return "credential";
  if (detectIdentifiers && options.identityIndex?.matches(text)) return "identity";
  let found: DataClass = "public";
  for (const span of identifierSpans(text, kind, detectIdentifiers)) {
    found = maxDataClass(found, span.kind);
    if (found === "identity") break;
  }
  return found;
}

function isPrivateIp(value: string): boolean {
  if (isIP(value) === 4) {
    const [first, second] = value.split(".").map(Number);
    return first === 10 || (first === 172 && second! >= 16 && second! <= 31) ||
      (first === 192 && second === 168) || (first === 169 && second === 254);
  }
  return /^(?:f[cd]|fe[89ab])/i.test(value);
}

export function emptyDataClassCounts(): DataClassCounts {
  return { credential: 0, identity: 0, security: 0, device: 0, activity: 0, configuration: 0, public: 0 };
}

/** Host-only. Classifies received JSON with original JSON Pointer coordinates. */
export function classifyData(value: unknown, options: ClassificationOptions = {}): DataClassification {
  const classes: Record<string, DataClass> = {};
  const securityMaskRoles: Record<string, SecurityMaskRole> = {};
  const result = walkDataClasses(value, options, (_value, kind, pointer, _key, role) => {
    classes[pointer] = kind;
    if (role) securityMaskRoles[pointer] = role;
  });
  return { ...result, classes, securityMaskRoles };
}

function ownCaseInsensitive(record: Record<string, unknown> | undefined, key: string): unknown {
  if (!record || Array.isArray(record)) return undefined;
  if (Object.hasOwn(record, key)) return record[key];
  const normalized = key.toLowerCase();
  for (const prop in record) {
    if (prop.length === key.length && prop.toLowerCase() === normalized && Object.hasOwn(record, prop)) return record[prop];
  }
  return undefined;
}

function graphProperty(record: Record<string, unknown> | undefined, additional: Record<string, unknown> | undefined, key: string): unknown {
  return ownCaseInsensitive(record, key) ?? ownCaseInsensitive(additional, key);
}

export function walkDataClasses(
  value: unknown,
  options: ClassificationOptions,
  onField?: (value: unknown, kind: DataClass, pointer: string, key: string, maskRole?: SecurityMaskRole) => void,
): { counts: DataClassCounts; budgetExhausted: boolean; remainder?: { from: string; kind: DataClass } } {
  const route = options.graphPath ? graphRoute(options.graphPath) : "";
  const fields = fieldMaps.get(route);
  const base = options.publicReference && !route ? "public" : securityPaths.has(route) ? "security" : "identity";
  const settings = SETTINGS_PATH.test(route);
  const counts = emptyDataClassCounts();
  let budget = options.workBudget ?? 32_000_000;
  let remainder: { from: string; kind: DataClass } | undefined;
  const active = new Set<object>();
  const detections = new Map<string, DataClass>();

  function detect(text: string, allowIdentifiers: boolean, kind: DataClass): DataClass {
    if (text.length > 4096) return detectValueClass(text, allowIdentifiers, options, kind);
    const key = `${kind}:${allowIdentifiers ? "text" : "secret"}:${text}`;
    const known = detections.get(key);
    if (known) return known;
    const detected = detectValueClass(text, allowIdentifiers, options, kind);
    if (detections.size < 512) detections.set(key, detected);
    return detected;
  }

  function visit(child: unknown, pointer: string, pattern: string, key: string, inherited?: DataClass,
    root = false, collection = false, secretSetting = false): void {
    if (remainder || child === undefined || child === null) return;
    budget -= 1 + key.length + (typeof child === "string" ? child.length : 0);
    if (budget < 0 || active.size >= 128) {
      // Unvisited fields may contain credentials, regardless of the classes seen so far.
      remainder = { from: pointer, kind: "credential" };
      return;
    }
    const wildcard = pattern.startsWith("/authenticationmethodconfigurations/[]/featuresettings/")
      ? pattern.replace(/(\/featuresettings)\/[^/]+/, "$1/*") : pattern;
    const mapped = fields?.get(pattern) ?? fields?.get(wildcard) ??
      (route === "/devicemanagement/deviceconfigurations" && GRAPH_LEGACY_ENDPOINT_SECURITY_FIELDS.test(pattern) ? "security" : undefined);
    const lowerKey = key.toLowerCase();
    const array = Array.isArray(child);
    const record = child !== null && typeof child === "object" ? child as Record<string, unknown> : undefined;
    const additional = ownCaseInsensitive(record, "additionalData");
    const additionalRecord = additional && typeof additional === "object" ? additional as Record<string, unknown> : undefined;
    const type = graphProperty(record, additionalRecord, "@odata.type") ?? graphProperty(record, additionalRecord, "odataType");
    const definition = settings ? graphProperty(record, additionalRecord, "settingDefinitionId") ??
      graphProperty(record, additionalRecord, "definitionId") : undefined;
    const template = settings ? graphProperty(record, additionalRecord, "templateReference") : undefined;
    const templateFamily = template && typeof template === "object"
      ? ownCaseInsensitive(template as Record<string, unknown>, "templateFamily") : undefined;
    const shape = typeof type === "string" ? type.replace(/^#?(?:microsoft\.graph\.)?/i, "") : "";
    const identityType = /^(?:user|group)$/i.test(shape) && (base === "security" || inherited === "security");
    const securityType = SECURITY_ODATA_TYPE.test(shape) || settings && (
      typeof templateFamily === "string" && SECURITY_ODATA_TYPE.test(templateFamily) ||
      typeof definition === "string" && (SECURITY_ODATA_TYPE.test(definition) || SECURITY_ENDPOINT_SETTING_ID.test(definition))
    );
    let effective = mapped ?? inherited ?? base;
    if (inherited === "credential" || inherited === "security") effective = maxDataClass(effective, inherited);
    if (securityType) effective = maxDataClass(effective === base && !mapped && !inherited ? "security" : effective, "security");
    if (identityType || (base === "security" || effective === "security") && SECURITY_IDENTITY_KEYS.test(key)) effective = maxDataClass(effective, "identity");
    const deviceName = GRAPH_DEVICE_NAME_FIELDS.test(key) || route === "/devices" && lowerKey === "displayname";
    if (deviceName && route && !mapped && !inherited) effective = "device";
    if (isCredentialField(key) || CREDENTIAL_SHAPE.test(pattern)) effective = "credential";
    if (/^@odata\.(?:nextLink|deltaLink)$/i.test(key)) effective = maxDataClass(effective, "identity");
    const keyClass = base === "public" && key ? detect(key, true, "public") : "public";
    effective = maxDataClass(effective, keyClass);

    if (record && !active.has(record)) {
      active.add(record);
      let hasChildren = false;
      const valueState = settings ? graphProperty(record, additionalRecord, "valueState") : undefined;
      const recordSecret = secretSetting || (settings && (
        typeof type === "string" && SECRET_SETTING_TYPE.test(type) ||
        graphProperty(record, additionalRecord, "isSecret") === true ||
        typeof valueState === "string" && valueState.toLowerCase() === "encryptedvaluetoken" ||
        typeof definition === "string" && SECRET_SETTING_ID.test(definition)
      ));
      for (const prop in record) {
        if (!Object.hasOwn(record, prop)) continue;
        hasChildren = true;
        const part = pointerPart(prop);
        const normalized = pointerPart(prop.toLowerCase());
        const propertyPattern = prop === "[]" ? "~2" : prop === "*" ? "~3" : normalized;
        const transparent = !array && prop.toLowerCase() === "additionaldata";
        const item = record[prop];
        const nextCollection = !array && root && prop.toLowerCase() === "value" && Array.isArray(item) &&
          (!fields?.has("/value") || (item[0] !== null && typeof item[0] === "object"));
        const auditLabel = CREDENTIAL_AUDIT_VALUE.test(prop) ? ownCaseInsensitive(record, "displayName") : undefined;
        const auditCredential = typeof auditLabel === "string" && isCredentialField(auditLabel);
        const nextInherited = auditCredential || recordSecret && SETTING_VALUE_KEYS.test(prop) ? "credential"
          : mapped || inherited || identityType || securityType || keyClass !== "public" || effective === "credential" ||
            effective === "identity" && (base === "security" || inherited === "security") ? effective : undefined;
        visit(record[prop], onField ? `${pointer}/${part}` : "",
          array && (root || collection) ? "" : transparent ? pattern : `${pattern}/${array ? "[]" : propertyPattern}`,
          array ? key : prop, nextInherited, transparent && root, nextCollection, recordSecret);
        if (remainder) break;
      }
      active.delete(record);
      if (hasChildren) return;
    }
    if (record || (typeof child === "string" && !child.trim())) return;
    if (typeof child === "string" && effective !== "credential") {
      effective = maxDataClass(effective, detect(child, deviceName || GRAPH_TEXT_FIELDS.test(key) ||
        mapped === undefined && inherited === undefined, effective));
    }
    counts[effective]++;
    onField?.(child, effective, pointer, key, effective === "security" ? graphSecurityMaskRole(key, pattern, route, child) : undefined);
  }

  visit(value, "", "", "", undefined, true);
  return { counts, budgetExhausted: remainder !== undefined, ...(remainder ? { remainder } : {}) };
}
