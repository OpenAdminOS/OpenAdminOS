import { describe, expect, it } from "vitest";
import type { ProviderSummary, RunRecord } from "@openadminos/agent-sdk";
import { forecastScheduleUsage, scheduleBillingMessage } from "./schedule-forecast.js";

const provider: ProviderSummary = { id: "azure-openai", name: "Azure OpenAI", description: "", isLocal: false, status: "connected", models: ["deployment"] };
const run = (value: number, overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: String(value), agentSlug: "report", status: "completed", tenantId: "tenant", queuedAt: new Date(2026, 0, value).toISOString(),
  providerId: provider.id, model: "deployment", steps: [], logs: [],
  usage: { providerId: provider.id, model: "deployment", calls: 1, mixedModels: false, promptTokens: value * 8, completionTokens: value * 2, totalTokens: value * 10, costUsd: value / 100 },
  ...overrides,
});
const forecast = (runs: RunRecord[], intervalSeconds = 86400) => forecastScheduleUsage({ runs, intervalSeconds, provider, model: "deployment", agentSlug: "report", tenantId: "tenant" });

describe("schedule usage forecast", () => {
  it("converts intervals to a 30-day month and scales the interpolated median and p90", () => {
    const result = forecast([run(1), run(2), run(3), run(4)]);
    expect(result.runsPerMonth).toBe(30);
    expect(result.tokens).toEqual({ median: 750, p90: 1110, samples: 4 });
    expect(result.costUsd?.median).toBeCloseTo(0.75);
    expect(result.costUsd?.p90).toBeCloseTo(1.11);
    expect(forecast([], 900).runsPerMonth).toBe(2880);
    expect(forecast([], 3600).runsPerMonth).toBe(720);
    expect(forecast([], 45 * 86400).runsPerMonth).toBeCloseTo(2 / 3);
  });

  it("keeps run frequency with no history and rejects invalid intervals", () => {
    expect(forecast([])).toEqual({ runsPerMonth: 30, completedRuns: 0, tokens: undefined, costUsd: undefined });
    for (const interval of [0, -1, NaN, Infinity]) expect(forecast([], interval).runsPerMonth).toBe(0);
  });

  it("ignores other agents, tenants, providers, models, unfinished runs and mixed-model usage", () => {
    const result = forecast([
      run(1), run(100, { agentSlug: "other" }), run(100, { providerId: "openai" }),
      run(100, { model: "other" }), run(100, { tenantId: "other" }), run(100, { status: "failed" }),
      run(100, { usage: { ...run(100).usage!, mixedModels: true } }),
      run(100, { usage: { ...run(100).usage!, providerId: "openai" } }),
      run(100, { usage: { ...run(100).usage!, model: "other" } }),
    ]);
    expect(result.tokens).toEqual({ median: 300, p90: 300, samples: 1 });
    expect(forecastScheduleUsage({ runs: [run(1)], intervalSeconds: 86400, provider, model: "deployment", agentSlug: "report", tenantId: undefined }).tokens).toBeUndefined();
  });

  it("uses only the last 20 matching completed runs, newest completion first", () => {
    const result = forecast(Array.from({ length: 25 }, (_, index) => run(index + 1)).reverse());
    expect(result.tokens?.samples).toBe(20);
    expect(result.tokens?.median).toBe(4650);
  });

  it("does not convert missing, partial, or invalid usage into zero or invent costs", () => {
    const result = forecast([run(1, { usage: null }), run(2, { usage: { ...run(2).usage!, totalTokens: undefined, costUsd: undefined } })]);
    expect(result.completedRuns).toBe(2);
    expect(result.tokens).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
    expect(forecast([run(1, { usage: { ...run(1).usage!, totalTokens: NaN, costUsd: -1 } })]).tokens).toBeUndefined();
  });
});

describe("provider billing copy", () => {
  it("treats every isLocal provider as having no API charges", () => {
    for (const id of ["ollama", "lm-studio", "apple-foundation", "openai"] as const) {
      expect(scheduleBillingMessage({ ...provider, id, isLocal: true })).toBe("Runs on this device. No API charges.");
    }
  });
  it("distinguishes CLI subscriptions, per-token billing, and external local-server endpoints", () => {
    for (const id of ["openai", "anthropic", "copilot", "gemini"] as const) {
      expect(scheduleBillingMessage({ ...provider, id })).toContain("subscription limits");
    }
    expect(scheduleBillingMessage(provider)).toBe("Billed by Azure OpenAI per token. Check your Azure OpenAI pricing.");
    expect(scheduleBillingMessage({ ...provider, id: "ollama" })).toContain("external server");
    expect(scheduleBillingMessage(undefined)).toContain("Choose a provider in Settings");
  });
});
