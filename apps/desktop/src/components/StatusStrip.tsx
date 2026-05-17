import { Link } from "react-router";
import { useAppState } from "../state";
import { IconCloud, IconHardDrive, IconShield } from "./icons";

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
        <span className="inline-flex items-center gap-1.5">
          {activeTenant ? (
            <IconCloud size={10} className="text-[var(--color-info)]" />
          ) : (
            <IconHardDrive size={10} className="text-[var(--color-success)]" />
          )}
          <span className="text-[var(--color-text-soft)]">
            {activeTenant
              ? `tenant: ${activeTenant.displayName}`
              : "synthetic mode"}
          </span>
        </span>

        <span className="opacity-40">·</span>

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

        <span className="opacity-40">·</span>

        <span className="inline-flex items-center gap-1.5">
          <IconShield
            size={10}
            className={
              state.realWritesEnabled
                ? "text-[var(--color-warning)]"
                : "text-[var(--color-text-muted)]"
            }
          />
          <span className="text-[var(--color-text-soft)]">
            real writes {state.realWritesEnabled ? "on" : "off"}
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
          v0.1.4 · local-first
        </span>
      </div>
    </footer>
  );
}
