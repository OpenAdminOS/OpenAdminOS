import { useMemo, useState } from "react";

import { useAppState } from "../state";
import { Button } from "./Button";
import { IconWarning } from "./icons";

const PAUSED_COPY =
  "Schedules are paused while the sample tenant is active. Switch to a connected tenant to resume.";

export function SampleSchedulesPausedNotice({ className = "" }: { className?: string }) {
  const { state, setActiveTenant } = useAppState();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sampleActive = state.tenants.some(
    (tenant) => tenant.id === state.activeTenantId && tenant.kind === "sample",
  );
  const recentTenant = useMemo(
    () =>
      state.tenants
        .filter((tenant) => tenant.kind !== "sample")
        .sort(
          (left, right) =>
            Date.parse(right.lastUsedAt ?? right.addedAt) -
            Date.parse(left.lastUsedAt ?? left.addedAt),
        )[0],
    [state.tenants],
  );

  if (!sampleActive) return null;

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--color-warning-soft)] px-3 py-2 text-sm text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25 ${className}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <IconWarning size={14} className="shrink-0" />
        <span>{PAUSED_COPY}</span>
      </span>
      {recentTenant ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={switching}
          onClick={() => {
            setSwitching(true);
            setError(null);
            void setActiveTenant(recentTenant.id)
              .catch((caught) =>
                setError(caught instanceof Error ? caught.message : String(caught)),
              )
              .finally(() => setSwitching(false));
          }}
        >
          {switching ? "Switching…" : `Switch to ${recentTenant.displayName}`}
        </Button>
      ) : null}
      {error ? <span role="alert">Could not switch tenants: {error}</span> : null}
    </div>
  );
}
