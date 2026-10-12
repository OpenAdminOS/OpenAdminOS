import { Link } from "react-router";
import { useAppState } from "../state";
import { resolveProviderDefaultModel } from "../shared/openAdminOS";
import { IconCloud, IconHardDrive } from "./icons";
import { deriveTrustCopy, SETUP_COPY } from "../copy";
import { TruncatedText } from "./TruncatedText";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { StatusDot } from "./ui";

export function StatusStrip({ voiceHosted = false }: { voiceHosted?: boolean }) {
  const { state } = useAppState();
  const { openSetup } = useSetupFlow();
  const activeProvider = state.providers.find(
    (provider) => provider.id === state.activeProviderId,
  );
  const configuredModel = resolveProviderDefaultModel(
    activeProvider,
    state.activeModelByProviderId,
  ).model;
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const runningCount = state.runs.filter(
    (run) => run.status === "queued" || run.status === "running",
  ).length;
  const boundaryProvider = voiceHosted
    ? { name: "OpenAI", isLocal: false }
    : activeProvider;
  const boundaryModel = voiceHosted ? "GPT-Live-1" : configuredModel;
  const trustCopy = deriveTrustCopy({
    provider: boundaryProvider,
    ...(boundaryModel ? { model: boundaryModel } : {}),
    scope: { tenantNames: activeTenant ? [activeTenant.displayName] : [] },
  });
  const providerLabel = voiceHosted
    ? "Nova voice · audio and shared context sent to OpenAI"
    : `${boundaryProvider?.name ?? "No provider"}${
        boundaryModel ? ` · ${boundaryModel}` : ""
      } · ${trustCopy.strip}`;

  return (
    <footer
      aria-label="Current tenant, provider, and data boundary"
      className="grid h-7 shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)_auto] items-center gap-3 overflow-hidden whitespace-nowrap border-t border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 font-mono text-xs text-[var(--color-text-muted)]"
    >
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <IconCloud size={11} className="shrink-0 text-[var(--color-info)]" />
        {activeTenant ? (
          <TruncatedText
            value={activeTenant.displayName}
            className="text-[var(--color-text-soft)]"
          />
        ) : (
          <button
            type="button"
            onClick={openSetup}
            className="min-w-0 truncate rounded-sm text-[var(--color-warning)] underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
          >
            {SETUP_COPY.statusNoTenant}
          </button>
        )}
        {activeTenant?.entraTier && activeTenant.entraTier !== "unknown" ? (
          <span
            className="shrink-0 rounded-[6px] px-1 text-xs text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]"
            title="Detected from the tenant subscription and used for agent compatibility."
          >
            {activeTenant.entraTier === "free"
              ? "Entra Free"
              : `Entra ${activeTenant.entraTier.toUpperCase()}`}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 max-w-[58vw] items-center gap-1.5 overflow-hidden">
        <IconHardDrive
          size={11}
          className={
            trustCopy.isLocal
              ? "shrink-0 text-[var(--color-success)]"
              : "shrink-0 text-[var(--color-warning)]"
          }
        />
        <TruncatedText
          value={providerLabel}
          className={
            trustCopy.isLocal
              ? "text-[var(--color-success)]"
              : "text-[var(--color-warning)]"
          }
        />
      </div>

      {runningCount > 0 ? (
        <Link
          to="/runs"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm text-[var(--color-info)] transition-colors hover:text-[var(--color-text)]"
        >
          <StatusDot tone="info" className="animate-pulse-soft" />
          <span>
            {runningCount} running
          </span>
        </Link>
      ) : null}
    </footer>
  );
}
