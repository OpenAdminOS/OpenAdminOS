import type { DetectedEntraTier, GraphHttpMethod } from "./index.js";

export type GraphAccessCause = "missing-consent" | "missing-licence" | "missing-role" | "unknown";

/** Safe to persist or send to the renderer. Never contains an access token. */
export interface GraphAccessDenial {
  cause: GraphAccessCause;
  title: string;
  message: string;
  recovery: string;
  missingScopes: string[];
  requiredLicence?: string;
  /**
   * Set on every denial classified since only Graph errors are classified.
   * A stored denial without it predates that check and is trusted only when
   * its error text comes from Graph (see storedGraphAccessDenial).
   */
  source?: "microsoft-graph";
}

export interface GraphAccessContext {
  path?: string | undefined;
  method?: GraphHttpMethod | undefined;
  label?: string | undefined;
  /** Alternatives accepted by this endpoint, not the scopes requested at sign-in. */
  requiredScopes?: readonly string[] | undefined;
  /** Actual MSAL result scopes or the access token's scp claim. Undefined means unknown. */
  grantedScopes?: readonly string[] | undefined;
  entraTier?: DetectedEntraTier | undefined;
  intuneLicensed?: boolean | undefined;
  errorCode?: string | undefined;
  /** Graph's own error message, kept for diagnosis. */
  graphMessage?: string | undefined;
}

function normalizeScope(scope: string): string {
  return scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase();
}

function scopeIsGranted(scope: string, granted: Set<string>): boolean {
  const required = normalizeScope(scope);
  if (granted.has(required)) return true;
  if (granted.has(required.replace(".read.", ".readwrite."))) return true;
  if (required === "user.readbasic.all" && (granted.has("user.read.all") || granted.has("user.readwrite.all"))) return true;
  // Documented broader alternatives used by the bundled read cache.
  if (["user.readbasic.all", "user.read.all", "group.read.all", "groupmember.read.all", "application.read.all", "domain.read.all", "administrativeunit.read.all"].includes(required)) {
    if (granted.has("directory.read.all") || granted.has("directory.readwrite.all")) return true;
  }
  if (required === "groupmember.read.all" && (granted.has("group.read.all") || granted.has("group.readwrite.all"))) return true;
  if (required.startsWith("policy.read.") && granted.has("policy.read.all")) return true;
  return false;
}

function licenceForEndpoint(path: string): "p1" | "p2" | undefined {
  if (/^\/auditlogs\/signins(?:\/|$)/i.test(path)) return "p1";
  if (/^\/identityProtection\/(riskyUsers|riskDetections)(?:\/|$)/i.test(path)) return "p2";
  return undefined;
}

function roleRecovery(path: string, method: GraphHttpMethod): string {
  if (method !== "GET") {
    return /^\/(deviceManagement|deviceAppManagement)(?:\/|$)/i.test(path)
      ? "Ask an Intune Administrator to assign or activate an Intune role with permission for this action and the required scope tags, then retry."
      : "Ask a role administrator to assign or activate an Entra role with permission for this action, then retry.";
  }
  if (/^\/(deviceManagement|deviceAppManagement)(?:\/|$)/i.test(path)) {
    return "Use Global Reader for broad read access, or ask an Intune Administrator to assign or activate an Intune Read Only Operator role with the required scope tags, then retry.";
  }
  if (/^\/(auditLogs|identityProtection|security)(?:\/|$)/i.test(path)) {
    return "Ask a role administrator to assign or activate Security Reader or Global Reader with access to this resource, then retry. Defender resources can also require a Defender role assignment.";
  }
  if (/^\/identity\/conditionalAccess(?:\/|$)/i.test(path)) {
    return "Ask a role administrator to assign or activate Global Reader, Security Reader, or Conditional Access Administrator, then retry.";
  }
  return "Ask a role administrator to assign or activate Global Reader or an Entra role with read access to this resource, then retry.";
}

function graphSaidSuffix(message: string | undefined): string {
  const trimmed = message?.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return ` Graph said: "${trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed}"`;
}

/** Classifies an observed 403 only. It never probes access or changes authentication. */
export function classifyGraphAccessDenied(context: GraphAccessContext = {}): GraphAccessDenial {
  return { ...classifyCause(context), source: "microsoft-graph" };
}

function classifyCause(context: GraphAccessContext): GraphAccessDenial {
  const path = (context.path ?? "").split("?")[0]!;
  const target = context.label ?? (path ? `${context.method ?? "GET"} ${path}` : "this resource");
  const prefix = `Microsoft Graph denied access to ${target} (HTTP 403).`;
  const graphSaid = graphSaidSuffix(context.graphMessage);
  const scopes = [...new Set(context.requiredScopes ?? [])];
  const premiumCode = context.errorCode?.toLowerCase() === "authentication_requestfromnonpremiumtenantorb2ctenant";
  const requiredTier = licenceForEndpoint(path);
  const insufficientTier = requiredTier && context.entraTier && context.entraTier !== "unknown"
    && (context.entraTier === "free" || (requiredTier === "p2" && context.entraTier === "p1"));
  const missingIntune = context.intuneLicensed === false && /^\/(deviceManagement|deviceAppManagement)(?:\/|$)/i.test(path);
  if (premiumCode || insufficientTier || missingIntune) {
    const requiredLicence = missingIntune ? "Microsoft Intune" : requiredTier === "p2" ? "Microsoft Entra ID P2" : "Microsoft Entra ID P1 or P2";
    return {
      cause: "missing-licence",
      title: "Tenant licence required",
      message: `${prefix} This endpoint requires ${requiredLicence}.${premiumCode ? " Graph reports a non-premium or Azure AD B2C tenant." : " The detected tenant licence does not include it."}${graphSaid}`,
      recovery: `Ask your licensing administrator to enable ${requiredLicence} for a supported workforce tenant, then retry.`,
      missingScopes: [],
      requiredLicence,
    };
  }
  // Claims challenges are a separate policy gate, even when scopes are present.
  if (context.errorCode?.toLowerCase() !== "insufficient_claims" && scopes.length > 0 && context.grantedScopes !== undefined) {
    const granted = new Set(context.grantedScopes.map(normalizeScope));
    if (!scopes.some(scope => scopeIsGranted(scope, granted))) {
      return {
        cause: "missing-consent",
        title: "Graph consent required",
        message: `${prefix} The access token does not include ${scopes.join(" or ")}.${graphSaid}`,
        recovery: `Reconnect this tenant to grant ${scopes.join(" or ")}, or forward the required scopes to an administrator who can grant consent, then retry.`,
        missingScopes: scopes,
      };
    }
    return {
      cause: "missing-role",
      title: "Role access required",
      message: `${prefix} The required delegated scope is granted, but your account does not have access to this resource.${graphSaid}`,
      recovery: roleRecovery(path, context.method ?? "GET"),
      missingScopes: [],
    };
  }
  return {
    cause: "unknown",
    title: "Graph access cause unverified",
    message: `${prefix} OpenAdminOS cannot determine the cause. Possible causes include missing consent, a missing or inactive role, a missing licence, or a tenant access policy.${graphSaid}`,
    recovery: "Ask an administrator to check the token's granted scopes, your active Entra or Intune role, the endpoint's licence requirements, and tenant access policies, then retry.",
    missingScopes: [],
  };
}

export function graphAccessDenialText(denial: GraphAccessDenial): string {
  return `${denial.message} ${denial.recovery}`;
}

export class GraphAccessDeniedError extends Error {
  readonly accessDenial: GraphAccessDenial;
  constructor(readonly accessContext: GraphAccessContext) {
    const denial = classifyGraphAccessDenied(accessContext);
    super(graphAccessDenialText(denial));
    this.name = "GraphAccessDeniedError";
    this.accessDenial = denial;
  }
}

/**
 * New failures are classified from typed errors only: a GraphAccessDeniedError
 * thrown by the runtime Graph adapter, or a Teams or Outlook connector error for
 * a Graph 403, also when an agent's error carries it as its `cause`. Text is
 * read only for records stored by earlier versions, which kept the message and
 * not the error (see graphAccessDenialFromStoredText).
 */
const GRAPH_CONNECTOR_IDS = new Set(["teams", "outlook"]);

function isGraphConnectorDenial(error: Error): boolean {
  const connector = error as Error & { connectorId?: unknown; statusCode?: unknown };
  if (typeof connector.connectorId !== "string" || !GRAPH_CONNECTOR_IDS.has(connector.connectorId)) return false;
  return connector.name === "ConnectorScopeError" || (connector.name === "ConnectorRemoteError" && connector.statusCode === 403);
}

function typedGraphDenial(error: unknown): GraphAccessDeniedError | Error | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth += 1) {
    if (current instanceof GraphAccessDeniedError || isGraphConnectorDenial(current)) return current;
  }
  return undefined;
}

/** Classifies a failure as a Graph denial only when a Graph client raised it. */
export function graphAccessDenialFromError(error: unknown, context: GraphAccessContext = {}): GraphAccessDenial | undefined {
  const denied = typedGraphDenial(error);
  if (!denied) return undefined;
  const overrides: GraphAccessContext = Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
  return classifyGraphAccessDenied(denied instanceof GraphAccessDeniedError ? { ...denied.accessContext, ...overrides } : overrides);
}

/** Graph hosts of the national clouds the runtime adapter can call. */
const GRAPH_HOSTS = new Set(["graph.microsoft.com", "graph.microsoft.us", "dod-graph.microsoft.us", "microsoftgraph.chinacloudapi.cn"]);

function graphHostAfter(raw: string, prefix: RegExp): boolean {
  const url = raw.match(prefix)?.[1];
  if (!url) return false;
  try {
    return GRAPH_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Stored text that OpenAdminOS's own Graph code wrote, matched from the start
 * of the message: the runtime adapter ("Graph responded with HTTP 403 for
 * https://graph.microsoft.com/...", with the host checked exactly), the
 * connectors ("Microsoft Graph rejected the request (HTTP 403)."), the licence
 * check ("Microsoft Graph answered /subscribedSkus with HTTP 403."), and stored
 * denial text ("Microsoft Graph denied access to ... (HTTP 403)."). A real Graph
 * 403 body ({"error":{"code":"Forbidden"|"accessDenied",...}}) does not name
 * Graph, so text elsewhere in a message, such as a provider's response body,
 * never counts.
 */
const ADAPTER_403 = /^Graph responded with HTTP 403 for (\S+?):?(?:\s|$)/;
const ADAPTER_ANY = /^Graph (?:responded with HTTP \d+|request failed \(|request timed out after \d+ms:) ?(?:for )?(\S+?)[):]?(?:\s|$)/;
const OWN_DENIAL_403 = /^(?:Microsoft Graph denied access to [^\n]*?\(HTTP 403\)|Microsoft Graph rejected the (?:\w+ )?request \(HTTP 403\)|Microsoft Graph answered \S+ with HTTP 403\b)/;
const OWN_GRAPH_TEXT = /^(?:Microsoft Graph (?:denied|rejected|answered|responded)\b|Graph rejected the access token \(HTTP 401\)|(?:Teams|Outlook) Graph request failed\b)/;

/**
 * A sandboxed script agent's failure as earlier versions stored it: the
 * script's stderr, where a Node stack preamble (file and line, source line,
 * caret) can come before the thrown error's header. Only a header for a
 * brokered Graph request ("Error: graph.request: ...") is unwrapped; text
 * further down, such as a provider body that quotes a Graph error, is not.
 */
const SCRIPT_AGENT_FAILURE = /^MXC script agent "[^"\n]*" failed: /;
const ERROR_HEADER = /^[A-Za-z]*Error: /;

function unwrapScriptAgentGraphError(raw: string): string {
  const prefix = raw.match(SCRIPT_AGENT_FAILURE)?.[0];
  if (!prefix) return raw;
  const lines = raw.slice(prefix.length).split("\n");
  const headerAt = lines.findIndex((line) => ERROR_HEADER.test(line));
  if (headerAt < 0) return raw;
  const thrown = [lines[headerAt]!.replace(ERROR_HEADER, ""), ...lines.slice(headerAt + 1)].join("\n");
  return thrown.startsWith("graph.request: ") ? thrown.slice("graph.request: ".length) : raw;
}

/**
 * Wrappers the app puts in front of a Graph error when a write run stops
 * before apply: a failed check of the reviewed plan or proposal, and a failed
 * replan. The Graph error follows them unchanged.
 */
const APP_FAILURE_WRAPPERS = [
  /^The (?:plan|proposal) could not be checked against the tenant before applying, so nothing was applied\. /,
  /^Nothing was applied: /,
];

function storedText(error: unknown): string {
  let raw = (error instanceof Error ? error.message : String(error ?? "")).trimStart();
  for (const wrapper of APP_FAILURE_WRAPPERS) raw = raw.replace(wrapper, "");
  return unwrapScriptAgentGraphError(raw);
}

/** True when a stored error message was written by OpenAdminOS's Graph code. */
function storedTextComesFromGraph(raw: string): boolean {
  return OWN_GRAPH_TEXT.test(raw) || graphHostAfter(raw, ADAPTER_ANY);
}

/**
 * True when the error came from a Microsoft Graph call: a typed Graph error, or
 * a stored message written by OpenAdminOS's own Graph code. A 403 from a local
 * model server, a vendor API, or an MCP server is not a Graph error.
 */
export function errorComesFromGraph(error: unknown): boolean {
  return typedGraphDenial(error) !== undefined || storedTextComesFromGraph(storedText(error));
}

/**
 * For records stored by earlier versions, which kept the error message only.
 * New failures are classified with graphAccessDenialFromError.
 */
export function graphAccessDenialFromStoredText(text: string | undefined, context: GraphAccessContext = {}): GraphAccessDenial | undefined {
  const raw = storedText(text);
  if (!OWN_DENIAL_403.test(raw) && !graphHostAfter(raw, ADAPTER_403)) return undefined;
  const errorCode = raw.match(/"code"\s*:\s*"([^"]+)"/)?.[1]
    ?? (raw.includes("Authentication_RequestFromNonPremiumTenantOrB2CTenant") ? "Authentication_RequestFromNonPremiumTenantOrB2CTenant" : undefined);
  return classifyGraphAccessDenied({ ...context, errorCode: context.errorCode ?? errorCode });
}

/**
 * A stored denial to show for a run or cache error. Denials stored by earlier
 * versions could come from a 403 of any service; those are kept only when the
 * stored error text is a Graph 403 that Graph code wrote.
 */
export function storedGraphAccessDenial(denial: GraphAccessDenial | undefined, error: unknown): GraphAccessDenial | undefined {
  if (!denial) return undefined;
  if (denial.source === "microsoft-graph" || typedGraphDenial(error)) return denial;
  return graphAccessDenialFromStoredText(storedText(error)) ? denial : undefined;
}
