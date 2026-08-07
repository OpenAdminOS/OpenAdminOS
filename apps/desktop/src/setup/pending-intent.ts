import {
  GRAPH_CACHE_RESOURCE_KINDS,
  type GraphCacheResourceKind,
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
      tenantId?: string;
      providerId?: ProviderId;
      model?: string;
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
        onlyKnownKeys(value, [
          "kind",
          "slug",
          "tenantId",
          "providerId",
          "model",
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
    value === "anthropic" ||
    value === "openai" ||
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
