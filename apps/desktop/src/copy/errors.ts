export type AppErrorActionKind = "retry" | "navigate" | "external" | "instruction";

export interface AppErrorCopy {
  what: string;
  why?: string;
  action: {
    label: string;
    kind: AppErrorActionKind;
  };
}

export function userFacingErrorReason(reason?: string): string | undefined {
  const normalized = reason?.trim();
  if (!normalized || normalized.length > 240) return undefined;
  if (/\r|\n|\tat\s|\bat\s+\S+\s*\(|(?:[A-Za-z]:\\|\/home\/|\/Users\/|node:)/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function chatErrorCopy(reason?: string): AppErrorCopy {
  const why = userFacingErrorReason(reason);
  return {
    what: "The answer could not be completed.",
    ...(why ? { why } : {}),
    action: { label: "Retry", kind: "retry" },
  };
}

export function settingsErrorCopy(reason?: string): AppErrorCopy {
  const why = userFacingErrorReason(reason);
  return {
    what: "Settings could not be loaded.",
    ...(why ? { why } : {}),
    action: { label: "Try again", kind: "retry" },
  };
}

export function bridgeErrorCopy(): AppErrorCopy {
  return {
    what: "The desktop bridge is unavailable.",
    why: "This renderer cannot access tenant authentication, local storage, or agent runs.",
    action: { label: "Reload", kind: "retry" },
  };
}
