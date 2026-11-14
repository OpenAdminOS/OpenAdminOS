import { useEffect, useState } from "react";

import type { EnterpriseStatus } from "@openadminos/agent-sdk";

import { IconWarning, IconCloud } from "./icons";
import { Tooltip } from "./ui";

/**
 * Says in the status strip when optional team features are on. Without a
 * licence, which is every build from the public repository, it renders
 * nothing. When a licence was refused or the module failed, it shows a
 * small "Team features off" entry whose tooltip says why and what fixes it.
 */
export const ENTERPRISE_PROBLEM_LABEL = "Team features off";

export function EnterpriseStatusChip() {
  const [status, setStatus] = useState<EnterpriseStatus>({ active: false });

  useEffect(() => {
    const bridge = window.openAdminOS;
    if (!bridge?.getEnterpriseStatus) return;
    let current = true;
    const refresh = () => {
      bridge.getEnterpriseStatus?.().then(
        (next) => {
          if (current) setStatus(next);
        },
        (error: unknown) => {
          console.error("[enterprise] the team features status could not be read", error);
        },
      );
    };
    refresh();
    const unsubscribe = bridge.onEnterpriseStatusChanged?.(refresh);
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, []);

  if (!status.active) {
    if (!status.problem) return null;
    return (
      <Tooltip content={status.problem.message} side="bottom">
        <span
          role="status"
          aria-label={`${ENTERPRISE_PROBLEM_LABEL} · ${status.problem.message}`}
          data-reason={status.problem.reason}
          tabIndex={0}
          className="app-region-no-drag flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-xs text-[var(--color-warning)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        >
          <IconWarning size={11} className="shrink-0" />
          <span className="whitespace-nowrap">{ENTERPRISE_PROBLEM_LABEL}</span>
        </span>
      </Tooltip>
    );
  }
  const chip = (
    <span
      role="status"
      aria-label={status.detail ? `${status.label} · ${status.detail}` : status.label}
      tabIndex={0}
      className="app-region-no-drag flex h-8 min-w-0 max-w-[320px] items-center gap-1.5 rounded-[8px] bg-[var(--color-warning-soft)] px-2 text-xs text-[var(--color-warning)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
    >
      <IconCloud size={11} className="shrink-0" />
      <span className="truncate">{status.label}</span>
    </span>
  );
  return status.detail ? <Tooltip content={status.detail} side="bottom">{chip}</Tooltip> : chip;
}
