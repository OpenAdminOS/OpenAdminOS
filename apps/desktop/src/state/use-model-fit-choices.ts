import { useEffect, useState } from "react";
import { modelFitChoices, modelFitContextKey, modelFitLocalCandidates } from "../shared/model-fit";
import type { ModelFitIssue, ProviderId } from "../shared/openAdminOS";

type ChoiceInput = Omit<Parameters<typeof modelFitChoices>[0], "issue" | "contextWindows"> & { issue: ModelFitIssue | undefined };

export function useModelFitChoices({ issue, ...input }: ChoiceInput) {
  const candidates = issue?.reason === "context-too-small" && issue.neededTokens !== undefined
    ? modelFitLocalCandidates(issue, input.providers, input.managedPolicy)
    : [];
  // Provider lists can refresh while the notice is open. Keep the lookup keyed to
  // the offer and its actual candidates so an equivalent list does not restart it.
  const lookup = candidates.length > 0 ? JSON.stringify({
    offer: issue?.offerId,
    models: candidates.map(({ providerId, model }) => [providerId, model]),
  }) : undefined;
  const [checked, setChecked] = useState<{ lookup: string; windows: ReadonlyMap<string, number> }>();
  useEffect(() => {
    if (!lookup) return;
    const bridge = window.openAdminOS;
    if (!bridge?.getModelFitContextWindow) return;
    const { models } = JSON.parse(lookup) as { models: Array<[ProviderId, string]> };
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
