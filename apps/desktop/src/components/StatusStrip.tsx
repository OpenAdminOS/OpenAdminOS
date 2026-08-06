import { Link } from "react-router";
import { useAppState } from "../state";
import { resolveProviderDefaultModel } from "../shared/openAdminOS";
import { IconCloud, IconHardDrive } from "./icons";
import { deriveTrustCopy } from "../copy";
import { TruncatedText } from "./TruncatedText";

export function StatusStrip() {
  const { state } = useAppState();
  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const activeModel = resolveProviderDefaultModel(
    activeProvider,
    state.activeModelByProviderId,
  ).model;
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const runningCount = state.runs.filter(
    (run) =>
      run.status === "queued" ||
      run.status === "running" ||
      run.status === "awaiting-confirmation",
  ).length;
  const trustCopy = deriveTrustCopy({
    provider: activeProvider,
    ...(activeModel ? { model: activeModel } : {}),
    scope: { tenantNames: activeTenant ? [activeTenant.displayName] : [] },
  });

  return (
    <footer
      aria-label="Current tenant, provider, and data boundary"
      className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-[var(--color-border-soft)] bg-[var(--color-bg)] px-4 py-1.5 font-mono text-[11px] text-[var(--color-text-muted)] min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex min-w-0 items-center gap-1.5">
            <IconCloud size={10} className="text-[var(--color-info)]" />
            <span className="shrink-0 text-[var(--color-text-muted)]">tenant:</span>
            <TruncatedText
              value={activeTenant?.displayName ?? "No active tenant"}
              className={activeTenant ? "text-[var(--color-text-soft)]" : "text-[var(--color-warning)]"}
            />
            {activeTenant?.entraTier && activeTenant.entraTier !== "unknown" && (
              <span
                className="ml-0.5 rounded px-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]"
                title="Detected from /subscribedSkus — used to badge incompatible agents."
              >
                {activeTenant.entraTier === "free"
                  ? "Entra Free"
                  : `Entra ${activeTenant.entraTier.toUpperCase()}`}
              </span>
            )}
          </span>
      </div>

      <span className="hidden min-w-0 items-center gap-1.5 min-[1100px]:inline-flex">
          <IconHardDrive
            size={10}
            className={
              activeProvider?.status === "connected"
                ? "text-[var(--color-success)]"
                : "text-[var(--color-warning)]"
            }
          />
          <TruncatedText
            value={`${activeProvider?.name ?? "No provider"}${activeModel ? ` · ${activeModel}` : ""}`}
            className="text-[var(--color-text-soft)]"
          />
        </span>

      <div className="flex min-w-0 items-center justify-end gap-3">
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
        <TruncatedText
          value={trustCopy.strip}
          className={trustCopy.isLocal ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}
        />
      </div>
    </footer>
  );
}
