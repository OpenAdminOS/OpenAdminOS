import { useEffect, useState } from "react";
import { modelFitChoices, modelFitContextKey, modelFitLocalCandidates } from "../shared/model-fit";
import type { ModelFitIssue, ProviderId } from "../shared/openAdminOS";

type ChoiceInput = Omit<Parameters<typeof modelFitChoices>[0], "issue" | "contextWindows"> & { issue: ModelFitIssue | undefined };

export function useModelFitChoices({ issue, ...input }: ChoiceInput) {
  const candidates = issue?.reason === "context-too-small" && issue.neededTokens !== undefined
    ? modelFitLocalCandidates(issue, input.providers, input.managedPolicy)
    : [];
  // Ready local server details include their endpoint. Invalidate the lookup
  // when a server moves, even if it reports the same model names.
  const providerDetails = new Map(input.providers.map((provider) => [provider.id, provider.detail]));
  // Equivalent provider lists can refresh while the notice is open.
  // Keep the key tied to the offer, candidates and their server details.
  const lookup = candidates.length > 0 ? JSON.stringify({
    offer: issue?.offerId,
    models: candidates.map(({ providerId, model }) => [providerId, model, providerDetails.get(providerId)]),
  }) : undefined;
  const [checked, setChecked] = useState<{ lookup: string; windows: ReadonlyMap<string, number> }>();
  useEffect(() => {
    if (!lookup) return;
    const bridge = window.openAdminOS;
    if (!bridge?.getModelFitContextWindow) return;
    const { models } = JSON.parse(lookup) as { models: Array<[ProviderId, string, string | null]> };
    let cancelled = false;
    void Promise.all(models.map(async ([providerId, model]) => {
      const window = await bridge.getModelFitContextWindow?.(providerId, model).catch(() => undefined);
      return [modelFitContextKey(providerId, model), window] as const;
    })).then((windows) => {
      if (cancelled) return;
      setChecked({ lookup, windows: new Map(windows.filter((entry): entry is readonly [string, number] => entry[1] !== undefined)) });
    });
    return () => { cancelled = true; };
  }, [lookup]);

  const contextWindows = checked && checked.lookup === lookup ? checked.windows : undefined;
  const choices = issue ? modelFitChoices({ ...input, issue, contextWindows }) : undefined;
  return { choices, checkingLocalContext: lookup !== undefined && checked?.lookup !== lookup && Boolean(window.openAdminOS?.getModelFitContextWindow) };
}
