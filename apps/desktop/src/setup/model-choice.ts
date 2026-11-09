import { MODEL_CHOICE_COPY, PROVIDER_TOOL_NAMES, promptsGoTo } from "../copy";
import type { ModelScanOutcome, ModelScanProbe, ProviderId, ProviderSummary } from "../shared/openAdminOS";

/**
 * The one choice of what answers in Chat (mockup 32, section B), shared by
 * the first-launch scan and the in-Chat model choice so both show the same
 * rows the same way: models on this device first, then signed-in tools,
 * each hosted row saying where prompts go.
 */

/** What the primary button does for the chosen row. */
export type ChoiceAction =
  /** A ready model: select it if needed, then open Chat. */
  | "open"
  /** Installed but not running: start it, then open Chat once it answers. */
  | "start"
  /** A signed-in hosted tool: select it, then open Chat. */
  | "use"
  /** Ollama without a model: set up OpenAdmin 8B. */
  | "get-model"
  /** LM Studio without a loaded model: scan again after loading one. */
  | "rescan";

export interface ChoiceOption {
  providerId: ProviderId;
  name: string;
  where: "local" | "hosted";
  /** "On this device. ..." for local rows; "Prompts go to ..." for hosted rows. */
  whereLine: string;
  /** Short state on the right: "Not running", "Signed in", "No model yet". */
  state: string;
  action: ChoiceAction;
  /** The model Chat answers with, when known. */
  model?: string;
  /** The row's check did not finish: it cannot be chosen until a Retry succeeds. */
  unavailable?: boolean;
}

const LOCAL_ORDER: readonly ProviderId[] = ["ollama", "lm-studio", "apple-foundation"];
const HOSTED_ORDER: readonly ProviderId[] = ["anthropic", "openai", "copilot", "gemini", "azure-openai"];
const order = (id: ProviderId) => {
  const local = LOCAL_ORDER.indexOf(id);
  if (local >= 0) return local;
  const hosted = HOSTED_ORDER.indexOf(id);
  return hosted >= 0 ? LOCAL_ORDER.length + hosted : 99;
};

export function isOpenAdmin8B(model: string | undefined): boolean {
  return Boolean(model && /(^|\/)openadmin-8b(:|$)/.test(model));
}

/** "OpenAdmin 8B" for the OpenAdmin model, the model name otherwise. */
export function modelDisplayName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return isOpenAdmin8B(model) ? "OpenAdmin 8B" : model;
}

export function toolName(id: ProviderId, fallback: string): string {
  return PROVIDER_TOOL_NAMES[id] ?? fallback;
}

/** The scan's found rows as choices. Not-found rows and refused off-device endpoints are not choices. */
export function optionsFromProbes(
  probes: readonly ModelScanProbe[],
  outcome: ModelScanOutcome | undefined,
): ChoiceOption[] {
  const chosenModel = outcome && "model" in outcome ? outcome.model : undefined;
  const options: ChoiceOption[] = [];
  for (const probe of probes) {
    if (probe.state === "checking" || probe.state === "not-found" || probe.notContacted) continue;
    const name = toolName(probe.providerId, probe.name);
    if (probe.state === "could-not-check") {
      options.push({
        providerId: probe.providerId,
        name,
        where: probe.where,
        whereLine: probe.facts[0] ?? MODEL_CHOICE_COPY.couldNotCheckLine(name),
        state: MODEL_CHOICE_COPY.couldNotCheck,
        action: probe.where === "local" ? "start" : "use",
        unavailable: true,
      });
      continue;
    }
    if (probe.where === "local") {
      const model = outcome && "providerId" in outcome && outcome.providerId === probe.providerId && chosenModel ? chosenModel : probe.models.find(isOpenAdmin8B) ?? probe.models[0];
      if (probe.ready) {
        options.push({ providerId: probe.providerId, name, where: "local", whereLine: MODEL_CHOICE_COPY.localReady(modelDisplayName(model)), state: MODEL_CHOICE_COPY.ready, action: "open", ...(model ? { model } : {}) });
      } else if (probe.summary === "Installed, not running") {
        options.push({ providerId: probe.providerId, name, where: "local", whereLine: MODEL_CHOICE_COPY.localStart(probe.providerId), state: MODEL_CHOICE_COPY.notRunning, action: "start" });
      } else {
        // Running without a model it can answer with.
        options.push({
          providerId: probe.providerId,
          name,
          where: "local",
          whereLine: probe.providerId === "ollama" ? MODEL_CHOICE_COPY.localGetModel : MODEL_CHOICE_COPY.localLoadModel,
          state: MODEL_CHOICE_COPY.noModel,
          action: probe.providerId === "ollama" ? "get-model" : "rescan",
        });
      }
      continue;
    }
    options.push({
      providerId: probe.providerId,
      name,
      where: "hosted",
      whereLine: promptsGoTo({ id: probe.providerId, name }),
      state: probe.ready ? MODEL_CHOICE_COPY.signedIn : probe.summary === "Installed, not signed in" ? MODEL_CHOICE_COPY.notSignedIn : MODEL_CHOICE_COPY.installed,
      action: "use",
    });
  }
  return options.sort((a, b) => order(a.providerId) - order(b.providerId));
}

/**
 * The same choices from the provider list, for Chat's model choice. A
 * runtime that is not installed is offered as OpenAdmin 8B on Ollama.
 */
export function optionsFromProviders(providers: readonly ProviderSummary[]): ChoiceOption[] {
  const options: ChoiceOption[] = [];
  for (const provider of providers) {
    const name = toolName(provider.id, provider.name);
    const ready = provider.status === "connected" || (provider.id === "azure-openai" && provider.status === "available");
    if (provider.isLocal) {
      if (ready) {
        const model = provider.defaultModel ?? provider.models[0];
        options.push({ providerId: provider.id, name, where: "local", whereLine: MODEL_CHOICE_COPY.localReady(modelDisplayName(model)), state: MODEL_CHOICE_COPY.ready, action: "open", ...(model ? { model } : {}) });
      } else if (provider.installed && (provider.id === "ollama" || provider.id === "lm-studio")) {
        options.push({ providerId: provider.id, name, where: "local", whereLine: MODEL_CHOICE_COPY.localStart(provider.id), state: MODEL_CHOICE_COPY.notRunning, action: "start" });
      } else if (provider.id === "ollama") {
        options.push({ providerId: "ollama", name, where: "local", whereLine: MODEL_CHOICE_COPY.localGetModel, state: provider.status === "error" ? MODEL_CHOICE_COPY.noModel : MODEL_CHOICE_COPY.notInstalled, action: "get-model" });
      }
      continue;
    }
    const signedIn = provider.status === "connected" || provider.cli?.state === "ready";
    if (!signedIn && !(provider.id === "azure-openai" && ready)) continue;
    options.push({
      providerId: provider.id,
      name,
      where: "hosted",
      whereLine: promptsGoTo({ id: provider.id, name }),
      state: provider.id === "azure-openai" ? MODEL_CHOICE_COPY.configured : MODEL_CHOICE_COPY.signedIn,
      action: "use",
    });
  }
  return options.sort((a, b) => order(a.providerId) - order(b.providerId));
}

/**
 * The row selected when the choice opens: the first model on this device
 * that can answer or be started, then one that needs a model. A hosted
 * tool is never preselected; it takes one explicit choice.
 */
export function preselect(options: readonly ChoiceOption[]): ProviderId | null {
  const local = options.filter((option) => option.where === "local" && !option.unavailable);
  return (
    local.find((option) => option.action === "open" || option.action === "start") ??
    local[0]
  )?.providerId ?? null;
}

/** The primary button's label follows the chosen row. */
export function actionLabel(option: ChoiceOption | undefined, activeProviderId?: ProviderId, place: "scan" | "chat" = "scan"): string {
  if (!option) return MODEL_CHOICE_COPY.chooseModel;
  switch (option.action) {
    case "open":
      return option.providerId === activeProviderId && place === "scan" ? MODEL_CHOICE_COPY.openChat : MODEL_CHOICE_COPY.use(modelDisplayName(option.model) ?? option.name);
    case "start":
      // In Chat the admin is already there: the button only starts and selects it.
      return place === "chat" ? MODEL_CHOICE_COPY.start(option.name) : MODEL_CHOICE_COPY.startAndOpen(option.name);
    case "get-model":
      return MODEL_CHOICE_COPY.getOpenAdmin;
    case "rescan":
      return MODEL_CHOICE_COPY.scanAgain;
    default:
      return MODEL_CHOICE_COPY.use(option.name);
  }
}

/** The 12 px note under the primary button. */
export function actionNote(option: ChoiceOption | undefined): string | undefined {
  if (!option) return undefined;
  if (option.action === "start") return MODEL_CHOICE_COPY.keepsRunning(option.name);
  if (option.action === "use") return option.providerId === "azure-openai" ? MODEL_CHOICE_COPY.usesAzure : MODEL_CHOICE_COPY.usesSignIn(option.name);
  if (option.action === "get-model") return MODEL_CHOICE_COPY.getOpenAdminNote;
  return undefined;
}
