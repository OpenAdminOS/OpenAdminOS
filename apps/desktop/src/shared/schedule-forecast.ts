import type { ProviderSummary, RunRecord } from "@openadminos/agent-sdk";

export const FORECAST_HISTORY_LIMIT = 20;
const MONTH_SECONDS = 30 * 24 * 60 * 60;

export interface ForecastRange {
  median: number;
  p90: number;
  samples: number;
}

export function forecastScheduleUsage(input: {
  intervalSeconds: number;
  agentSlug: string;
  provider: ProviderSummary | undefined;
  model: string | undefined;
  tenantId: string | undefined;
  runs: RunRecord[];
}) {
  const { intervalSeconds, agentSlug, provider, model, tenantId, runs } = input;
  const runsPerMonth = Number.isFinite(intervalSeconds) && intervalSeconds > 0
    ? MONTH_SECONDS / intervalSeconds : 0;
  const completed = model && provider && tenantId ? runs
    .filter((run) => run.agentSlug === agentSlug && run.tenantId === tenantId &&
      run.status === "completed" && run.providerId === provider.id && run.model === model)
    .sort((a, b) => Date.parse(b.finishedAt ?? b.queuedAt) - Date.parse(a.finishedAt ?? a.queuedAt))
    .slice(0, FORECAST_HISTORY_LIMIT) : [];
  const usage = completed.flatMap((run) => run.usage && !run.usage.mixedModels &&
    run.usage.providerId === provider?.id && run.usage.model === model ? [run.usage] : []);
  const range = (field: "totalTokens" | "costUsd"): ForecastRange | undefined => {
    const values = usage.flatMap((item) => {
      const value = item[field];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [value] : [];
    }).sort((a, b) => a - b);
    return values.length ? {
      median: percentile(values, 0.5) * runsPerMonth,
      p90: percentile(values, 0.9) * runsPerMonth,
      samples: values.length,
    } : undefined;
  };
  return { runsPerMonth, completedRuns: completed.length, tokens: range("totalTokens"), costUsd: range("costUsd") };
}

function percentile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  return sorted[lower]! + (sorted[Math.ceil(position)]! - sorted[lower]!) * (position - lower);
}

export function scheduleBillingMessage(provider: ProviderSummary | undefined): string {
  if (!provider) return "Choose a provider in Settings to see an estimate.";
  if (provider.isLocal) return "Runs on this device. No API charges.";
  if (["openai", "anthropic", "copilot", "gemini"].includes(provider.id)) {
    return "Usage counts against your subscription limits. CLI account billing may apply.";
  }
  if (provider.id === "azure-openai") {
    // TODO(ugur): Should admins be able to enter their own per-1M-token prices?
    return `Billed by ${provider.name} per token. Check your ${provider.name} pricing.`;
  }
  return "Runs on the configured external server. Check that server's billing.";
}

export function formatForecastRange(range: ForecastRange, currency = false): string {
  const format = (value: number) => currency
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)
    : Math.round(value).toLocaleString();
  return `${format(range.median)} to ${format(range.p90)}`;
}
