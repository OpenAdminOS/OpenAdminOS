import type { ReactNode } from "react";

import { useSetupFlow } from "../setup/SetupFlowContext";
import { PILOT_COPY } from "../shared/pilot-mode";
import type { TenantRecord } from "../shared/openAdminOS";
import { useAppState } from "../state";
import { Button } from "./Button";
import { IconLock } from "./icons";

/** The active tenant when it is the built-in pilot tenant. */
export function usePilotTenant(): TenantRecord | undefined {
  const { state } = useAppState();
  const active = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  return active?.kind === "sample" ? active : undefined;
}

export function usePilotMode(): boolean {
  return usePilotTenant() !== undefined;
}

/** Slim banner across the top of the main content area while pilot mode is active. */
export function PilotBanner() {
  const pilot = usePilotMode();
  const { openSetup } = useSetupFlow();
  if (!pilot) return null;
  return (
    <div
      role="region"
      aria-label={PILOT_COPY.modeName}
      className="app-pilot-banner flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-[var(--color-border-soft)] bg-[var(--color-info-soft)] px-4 py-1.5 text-sm text-[var(--color-text)]"
    >
      <span className="min-w-0">{PILOT_COPY.banner}</span>
      <Button size="sm" variant="secondary" onClick={openSetup}>
        {PILOT_COPY.connectAction}
      </Button>
    </div>
  );
}

/** Designed page for a production-only feature reached directly in pilot mode. */
export function PilotProductionPage({
  feature,
  plural = false,
}: {
  feature: string;
  plural?: boolean;
}) {
  const { openSetup } = useSetupFlow();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-12">
      <section
        aria-labelledby="pilot-production-heading"
        className="w-full max-w-[460px] rounded-2xl bg-[var(--color-surface)] p-6 text-center ring-1 ring-[var(--color-border-soft)]"
      >
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
          <IconLock size={16} />
        </div>
        <h1
          id="pilot-production-heading"
          className="mt-4 font-serif text-lg font-medium text-[var(--color-text)]"
        >
          {feature}
        </h1>
        <p className="mx-auto mt-2 max-w-[360px] text-base leading-6 text-[var(--color-text-muted)]">
          {PILOT_COPY.featureInProduction(feature, plural)}
        </p>
        <Button className="mt-5" variant="primary" onClick={openSetup}>
          {PILOT_COPY.connectAction}
        </Button>
      </section>
    </div>
  );
}

/** Renders the production-only page in pilot mode, the feature otherwise. */
export function PilotProductionOnly({
  feature,
  plural = false,
  children,
}: {
  feature: string;
  plural?: boolean;
  children: ReactNode;
}) {
  const pilot = usePilotMode();
  return pilot ? <PilotProductionPage feature={feature} plural={plural} /> : <>{children}</>;
}
