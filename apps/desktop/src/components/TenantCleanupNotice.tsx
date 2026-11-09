import { useState } from "react";

import { Button } from "./Button";
import { IconWarning } from "./icons";
import { useToast } from "./Toast";
import { ORGANIZATION_COPY, userFacingErrorReason } from "../copy";
import { useAppState } from "../state";

/**
 * Disconnected organizations whose cleanup on this device has not finished,
 * with Retry cleanup. Shown on Connections and in the connect flow, where
 * the same organization cannot be connected again until cleanup finishes.
 */
export function TenantCleanupNotice({ className = "" }: { className?: string }) {
  const { state, retryTenantCleanup } = useAppState();
  const toast = useToast();
  const [retrying, setRetrying] = useState<string | null>(null);
  const cleanups = state.tenantCleanups ?? [];
  if (cleanups.length === 0) return null;
  return (
    <section
      aria-labelledby="tenant-cleanup-heading"
      className={`rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 ring-1 ring-[var(--color-warning)]/30 ${className}`}
    >
      <h2 id="tenant-cleanup-heading" className="flex items-center gap-2 text-base font-medium text-[var(--color-warning)]">
        <IconWarning size={14} /> {ORGANIZATION_COPY.cleanupHeading}
      </h2>
      <ul className="mt-2 space-y-3">
        {cleanups.map((cleanup) => (
          <li key={cleanup.tenantId} className="flex flex-wrap items-start justify-between gap-3">
            <p className="min-w-[240px] flex-1 text-sm leading-relaxed text-[var(--color-text-soft)]">
              {ORGANIZATION_COPY.cleanupBody(cleanup.displayName, cleanup.error)}
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={retrying !== null}
              aria-label={`${ORGANIZATION_COPY.retryCleanup}, ${cleanup.displayName}`}
              onClick={() => {
                setRetrying(cleanup.tenantId);
                void retryTenantCleanup(cleanup.tenantId)
                  .then((pending) => {
                    if (pending) toast.warning(ORGANIZATION_COPY.cleanupStillPending(cleanup.displayName, pending.error));
                    else toast.success(ORGANIZATION_COPY.cleanupFinished(cleanup.displayName));
                  })
                  .catch((caught) =>
                    toast.error(
                      ORGANIZATION_COPY.cleanupStillPending(
                        cleanup.displayName,
                        userFacingErrorReason(caught instanceof Error ? caught.message : String(caught)) ?? undefined,
                      ),
                    ),
                  )
                  .finally(() => setRetrying(null));
              }}
            >
              {retrying === cleanup.tenantId ? ORGANIZATION_COPY.retryingCleanup : ORGANIZATION_COPY.retryCleanup}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
