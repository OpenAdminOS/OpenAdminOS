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

/** Old string-only errors remain unknown until evidence is available. */
export function graphAccessDenialFromError(error: unknown, context: GraphAccessContext = {}): GraphAccessDenial | undefined {
  if (error instanceof GraphAccessDeniedError) {
    const overrides: GraphAccessContext = Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
    return classifyGraphAccessDenied({ ...error.accessContext, ...overrides });
  }
  const raw = error instanceof Error ? error.message : String(error);
  if (!/\b403\b|\bforbidden\b|Authentication_RequestFromNonPremiumTenantOrB2CTenant/i.test(raw)) return undefined;
  const errorCode = raw.match(/"code"\s*:\s*"([^"]+)"/)?.[1]
    ?? (raw.includes("Authentication_RequestFromNonPremiumTenantOrB2CTenant") ? "Authentication_RequestFromNonPremiumTenantOrB2CTenant" : undefined);
  return classifyGraphAccessDenied({ ...context, errorCode: context.errorCode ?? errorCode });
}
