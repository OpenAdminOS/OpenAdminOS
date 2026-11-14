import { useEffect, useState } from "react";

import type { EnterpriseStatus } from "@openadminos/agent-sdk";

import { IconCloud } from "./icons";
import { Tooltip } from "./ui";

/**
 * Says in the status strip when optional team features are on. Renders
 * nothing without a valid licence, which is every build from the public
 * repository.
 */
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

  if (!status.active) return null;
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
