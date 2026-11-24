import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import type { ModelFitIssue } from "../shared/openAdminOS";
import { makeMockBridge, mockProviders } from "../test/test-utils";
import { useModelFitChoices } from "./use-model-fit-choices";

it("rechecks a model's context window when its provider endpoint changes", async () => {
  const getModelFitContextWindow = vi.fn()
    .mockResolvedValueOnce(65536)
    .mockResolvedValueOnce(16384);
  window.openAdminOS = makeMockBridge({ getModelFitContextWindow });
  const issue: ModelFitIssue = {
    reason: "context-too-small",
    providerId: "ollama",
    model: "openadmin-8b",
    neededTokens: 32000,
  };
  const providers = (port: number) => mockProviders
    .filter((provider) => provider.id === "ollama")
    .map((provider) => ({
      ...provider,
      detail: `Running on http://127.0.0.1:${port}`,
      models: ["gpt-oss:20b"],
    }));

  const { result, rerender } = renderHook(
    ({ port }) => useModelFitChoices({ issue, providers: providers(port) }),
    { initialProps: { port: 11434 } },
  );
  await waitFor(() => expect(result.current.choices?.local[0]?.contextWindow).toBe(65536));
  rerender({ port: 11434 });
  expect(getModelFitContextWindow).toHaveBeenCalledTimes(1);

  rerender({ port: 11435 });
  expect(result.current.choices?.local).toEqual([]);
  expect(result.current.checkingLocalContext).toBe(true);
  await waitFor(() => expect(result.current.checkingLocalContext).toBe(false));
  expect(getModelFitContextWindow.mock.calls).toEqual([
    ["ollama", "gpt-oss:20b"],
    ["ollama", "gpt-oss:20b"],
  ]);
  expect(result.current.choices?.local).toEqual([]);
});
