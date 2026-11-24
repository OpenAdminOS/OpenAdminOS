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

export function cacheBrowserErrorCopy(error: unknown): AppErrorCopy {
  const reason = userFacingErrorReason(error instanceof Error ? error.message : undefined);
  const connections = { label: "Open connections", kind: "navigate" } as const;
  if (reason?.includes("Select the connected organization")) {
    return { what: "Select or connect an organization to browse its cache.", action: connections };
  }
  if (reason?.includes("organization is disconnecting or is not ready")) {
    return { what: "The organization is disconnecting or is not ready. Select a connected organization.", action: connections };
  }
  if (reason?.includes("Invalid cache ")) {
    return { what: "This cache request is invalid. Return to Data to browse again.", action: { label: "Return to Data", kind: "navigate" } };
  }
  if (reason?.includes("Unknown cache resource")) {
    return { what: "This cache resource is unavailable. Return to Data to choose another resource.", action: { label: "Return to Data", kind: "navigate" } };
  }
  return { what: "Local storage could not return the cached rows. Try reading them again.", action: { label: "Retry", kind: "retry" } };
}
