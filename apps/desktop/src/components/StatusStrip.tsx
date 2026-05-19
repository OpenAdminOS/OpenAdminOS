import { Link } from "react-router";
import { useAppState } from "../state";
import { IconCloud, IconHardDrive } from "./icons";

export function StatusStrip() {
  const { state } = useAppState();
  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const runningCount = state.runs.filter(
    (run) =>
      run.status === "queued" ||
      run.status === "running" ||
      run.status === "awaiting-confirmation",
  ).length;

  return (
    <footer className="flex shrink-0 items-center justify-between border-t border-[var(--color-border-soft)] bg-[var(--color-bg)] px-4 py-1.5 font-mono text-[10.5px] text-[var(--color-text-muted)]">
      <div className="flex items-center gap-3">
        {activeTenant && (
          <span className="inline-flex items-center gap-1.5">
            <IconCloud size={10} className="text-[var(--color-info)]" />
            <span className="text-[var(--color-text-soft)]">
              tenant: {activeTenant.displayName}
            </span>
          </span>
        )}

        {activeTenant && <span className="opacity-40">·</span>}

        <span className="inline-flex items-center gap-1.5">
          <IconHardDrive
            size={10}
            className={
              activeProvider?.status === "connected"
                ? "text-[var(--color-success)]"
                : "text-[var(--color-warning)]"
            }
          />
          <span className="text-[var(--color-text-soft)]">
            {activeProvider?.name ?? "no provider"}
            {activeProvider?.defaultModel ? ` · ${activeProvider.defaultModel}` : ""}
          </span>
        </span>
      </div>

      <div className="flex items-center gap-3">
        {runningCount > 0 && (
          <Link
            to="/activity"
            className="inline-flex items-center gap-1.5 text-[var(--color-warning)] hover:text-[var(--color-text)]"
          >
            <span className="inline-block h-1.5 w-1.5 animate-pulse-soft rounded-full bg-current" />
            <span>
              {runningCount} run{runningCount === 1 ? "" : "s"} in flight
            </span>
          </Link>
        )}
        <span className="text-[var(--color-text-faint)]">
          v0.1.5 · local-first
        </span>
      </div>
    </footer>
  );
}
