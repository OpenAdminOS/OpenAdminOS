import type { LlmTokenUsage, ProviderId, RunModelUsage } from "@openadminos/agent-sdk";

const fields = ["promptTokens", "completionTokens", "totalTokens", "costUsd"] as const;

export function accumulateRunUsage(
  current: RunModelUsage | null | undefined,
  providerId: ProviderId,
  model: string | undefined,
  reported: LlmTokenUsage | undefined,
): RunModelUsage {
  const next: RunModelUsage = {
    providerId,
    model,
    calls: (current?.calls ?? 0) + 1,
    mixedModels: Boolean(current?.mixedModels || (current && (current.model !== model || current.providerId !== providerId))),
  };
  const values = { ...reported };
  if (values.totalTokens === undefined && valid(values.promptTokens) && valid(values.completionTokens)) {
    values.totalTokens = values.promptTokens + values.completionTokens;
  }
  for (const field of fields) {
    const value = values[field];
    // A missing count on any call makes that run's corresponding total unknown.
    if (valid(value) && (!current || valid(current[field]))) {
      next[field] = (current?.[field] ?? 0) + value;
    }
  }
  return next;
}

function valid(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
