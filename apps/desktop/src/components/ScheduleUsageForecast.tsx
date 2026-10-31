import { useMemo } from "react";
import { resolveRunModel, type AgentSummary } from "../shared/openAdminOS";
import { forecastScheduleUsage, formatForecastRange, scheduleBillingMessage } from "../shared/schedule-forecast";
import { useAppState } from "../state";

export function ScheduleUsageForecast({ agent, intervalSeconds, compact = false }: {
  agent: AgentSummary;
  intervalSeconds: number;
  compact?: boolean;
}) {
  const { state } = useAppState();
  const provider = state.providers.find((item) => item.id === state.activeProviderId);
  const model = resolveRunModel({
    provider,
    preferredModel: agent.preferredModel,
    activeModelByProviderId: state.activeModelByProviderId,
  }).model;
  const forecast = useMemo(() => forecastScheduleUsage({
    intervalSeconds, agentSlug: agent.slug, provider, model,
    tenantId: state.activeTenantId, runs: state.runs,
  }), [intervalSeconds, agent.slug, provider, model, state.activeTenantId, state.runs]);
  const tokens = provider && !provider.isLocal ? forecast.tokens : undefined;
  const cost = provider?.id === "azure-openai" && !provider.isLocal ? forecast.costUsd : undefined;
  const historyMessage = !provider ? undefined : !model
    ? "Choose a model in Settings to see an estimate."
    : forecast.completedRuns === 0
      ? "No completed runs yet. Run it once to see an estimate."
      : !forecast.tokens
        ? "Completed runs have no comparable token usage. Run it again with a provider that reports tokens."
        : undefined;
  const counts = `About ${forecast.runsPerMonth.toLocaleString(undefined, { maximumFractionDigits: 1 })} runs per 30 days`;
  const tokenText = tokens ? ` · ${formatForecastRange(tokens)} tokens` : "";
  const costText = cost ? ` · ${formatForecastRange(cost, true)} reported cost estimate` : "";
  const basis = tokens
    ? `Median to p90, based on ${tokens.samples} completed ${tokens.samples === 1 ? "run" : "runs"} with ${provider?.name} / ${model}.`
    : undefined;
  const costBasis = cost ? ` Cost uses ${cost.samples} runs with provider-reported USD cost.` : "";

  if (compact) {
    return (
      <p aria-label="Schedule usage forecast" className="mt-1 break-words text-xs leading-relaxed tabular-nums text-[var(--color-text-muted)]">
        {counts}{tokenText}{costText}{tokens ? ` (median to p90, ${tokens.samples} runs)` : ""}.
        {" "}{scheduleBillingMessage(provider)} {historyMessage}{costBasis}
      </p>
    );
  }

  return (
    <div aria-label="Schedule usage forecast" aria-live="polite"
      className="space-y-1 break-words border-t border-[var(--color-border-soft)] pt-3 text-xs leading-relaxed text-[var(--color-text-muted)]">
      <p className="tabular-nums">
        <span className="font-medium text-[var(--color-text)]">Expected usage · </span>
        {counts}{tokenText}{costText}
      </p>
      <p>{scheduleBillingMessage(provider)}</p>
      {historyMessage && <p>{historyMessage}</p>}
      {(basis || cost) && <p>{basis}{costBasis}</p>}
      <p>Assumes the device is available and these provider settings stay selected. Actual usage can vary.</p>
    </div>
  );
}
