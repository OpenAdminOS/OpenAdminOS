import {
  GRAPH_CACHE_RESOURCE_KINDS,
  type GraphCacheResourceKind,
  type ModelFitIssue,
  type ProviderId,
} from "../shared/openAdminOS";

const STORAGE_KEY = "openadminos:pending-intent:v1";
const MAX_AGE_MS = 30 * 60 * 1000;

export type PendingIntent =
  | {
      kind: "chat-send";
      conversationId: string | null;
      returnTo: string;
      createdAt: string;
    }
  | {
      kind: "agent-run";
      slug: string;
      retryOfRunId?: string;
      dryRun?: boolean;
      runForRealOfRunId?: string;
      tenantId?: string;
      providerId?: ProviderId;
      model?: string;
      /** Run with <provider> after a model fit failure: the review keeps its reason and its organization pin. */
      modelFit?: ModelFitIssue;
      /** Run again of a model fit rerun keeps its safeguards through setup. */
      safeguards?: { onDevice: boolean };
      returnTo: string;
      createdAt: string;
    }
  | {
      kind: "view-changes";
      returnTo: string;
      createdAt: string;
    }
  | {
      kind: "refresh-cache";
      resourceKind?: GraphCacheResourceKind;
      returnTo: string;
      createdAt: string;
    }
  | {
      kind: "scheduled-batch";
      mode: "due" | "all";
      returnTo: string;
      createdAt: string;
    };

export function readPendingIntent(now = Date.now()): PendingIntent | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isPendingIntent(parsed) || isExpired(parsed, now)) {
      clearPendingIntent();
      return null;
    }
    return parsed;
  } catch {
    clearPendingIntent();
    return null;
  }
}

export function writePendingIntent(intent: PendingIntent): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // Session persistence is best effort. The in-memory setup flow stays usable.
  }
}

export function clearPendingIntent(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing else to clear when session storage is unavailable.
  }
}

type PendingIntentInput<T = PendingIntent> = T extends PendingIntent
  ? Omit<T, "createdAt">
  : never;

export function createPendingIntent(
  input: PendingIntentInput,
  now = new Date(),
): PendingIntent {
  return {
    ...input,
    createdAt: now.toISOString(),
  } as PendingIntent;
}

function isPendingIntent(value: unknown): value is PendingIntent {
  if (!isRecord(value)) return false;
  if (!isLocalRoute(value.returnTo) || !isIsoDate(value.createdAt)) return false;

  switch (value.kind) {
    case "chat-send":
      return (
        (value.conversationId === null || isBoundedString(value.conversationId, 256)) &&
        onlyKnownKeys(value, ["kind", "conversationId", "returnTo", "createdAt"])
      );
    case "agent-run":
      return (
        isBoundedString(value.slug, 160) &&
        (value.tenantId === undefined || isBoundedString(value.tenantId, 256)) &&
        (value.providerId === undefined || isProviderId(value.providerId)) &&
        (value.model === undefined || isBoundedString(value.model, 256)) &&
        (value.dryRun === undefined || typeof value.dryRun === "boolean") &&
        (value.runForRealOfRunId === undefined || isBoundedString(value.runForRealOfRunId, 256)) &&
        (value.retryOfRunId === undefined || isBoundedString(value.retryOfRunId, 256)) &&
        (value.modelFit === undefined || isModelFitIssue(value.modelFit)) &&
        (value.safeguards === undefined || (isRecord(value.safeguards) && typeof value.safeguards.onDevice === "boolean" && onlyKnownKeys(value.safeguards, ["onDevice"]))) &&
        onlyKnownKeys(value, [
          "kind",
          "slug",
          "tenantId",
          "providerId",
          "model",
          "modelFit",
          "safeguards",
          "retryOfRunId",
          "dryRun",
          "runForRealOfRunId",
          "returnTo",
          "createdAt",
        ])
      );
    case "view-changes":
      return onlyKnownKeys(value, ["kind", "returnTo", "createdAt"]);
    case "refresh-cache":
      return (
        (value.resourceKind === undefined || isGraphCacheResourceKind(value.resourceKind)) &&
        onlyKnownKeys(value, ["kind", "resourceKind", "returnTo", "createdAt"])
      );
    case "scheduled-batch":
      return (
        (value.mode === "due" || value.mode === "all") &&
        onlyKnownKeys(value, ["kind", "mode", "returnTo", "createdAt"])
      );
    default:
      return false;
  }
}

function isModelFitIssue(value: unknown): value is ModelFitIssue {
  if (!isRecord(value)) return false;
  const count = (entry: unknown) => entry === undefined || (typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0);
  return (
    (value.reason === "context-too-small" || value.reason === "repeated-failure" || value.reason === "thinking-only") &&
    isProviderId(value.providerId) &&
    (value.model === undefined || isBoundedString(value.model, 256)) &&
    count(value.neededTokens) &&
    count(value.limitTokens) &&
    (value.limitIsModelMax === undefined || value.limitIsModelMax === true) &&
    (value.limitIsMemory === undefined || value.limitIsMemory === true) &&
    onlyKnownKeys(value, ["reason", "providerId", "model", "neededTokens", "limitTokens", "limitIsModelMax", "limitIsMemory"])
  );
}

function isExpired(intent: PendingIntent, now: number): boolean {
  const createdAt = Date.parse(intent.createdAt);
  return !Number.isFinite(createdAt) || createdAt > now + 60_000 || now - createdAt > MAX_AGE_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    value === "ollama" ||
    value === "apple-foundation" ||
    value === "lm-studio" ||
    value === "lemonade" ||
    value === "anthropic" ||
    value === "openai" ||
    value === "copilot" ||
    value === "gemini" ||
    value === "azure-openai"
  );
}

function isGraphCacheResourceKind(value: unknown): value is GraphCacheResourceKind {
  return (
    typeof value === "string" &&
    (GRAPH_CACHE_RESOURCE_KINDS as readonly string[]).includes(value)
  );
}

function isLocalRoute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    value.length <= 512
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function onlyKnownKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
