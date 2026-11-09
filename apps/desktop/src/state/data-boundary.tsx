import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { NOVA_VOICE_PROVIDER, deriveTrustCopy, providerDataLocation, providerDataLocationDetail } from "../copy";
import { resolveProviderDefaultModel, type AppState } from "../shared/openAdminOS";
import { useAppState } from "./AppStateContext";
import { PILOT_COPY } from "../shared/pilot-mode";

export type DataBoundary =
  | {
      kind: "none";
      label: "No model";
      model?: undefined;
      tooltip: string;
      isVoiceHosted: false;
    }
  | {
      kind: "local";
      label: string;
      model?: string;
      /** Status strip segment naming the MCP hosts that receive tool queries. */
      toolHosts?: string;
      /** Composer sentence naming every MCP host. */
      toolHostsNote?: string;
      tooltip: string;
      isVoiceHosted: false;
    }
  | {
      kind: "hosted";
      label: string;
      model?: string;
      toolHosts?: string;
      toolHostsNote?: string;
      tooltip: string;
      isVoiceHosted: boolean;
      /** The provider that receives hosted voice audio, when voice is on. */
      voiceProvider?: string;
      /** Where hosted voice sends audio, from the shared location function. */
      voiceLocation?: string;
    };

interface DataBoundaryContextValue {
  boundary: DataBoundary;
  setVoiceHosted: Dispatch<SetStateAction<boolean>>;
}

/**
 * Hosts of the installed, enabled MCP servers that Chat queries can reach.
 * None when the model is too small for tool use: it is never offered the
 * tools, so it never sends a query to them.
 */
export function chatToolHosts(state: Pick<AppState, "mcpServers" | "chatToolUse">): string[] {
  if (state.chatToolUse?.available === false) return [];
  // A server missing one of its offered tools is skipped by Chat, so it receives nothing.
  // Two servers on one host are one destination.
  return [
    ...new Set(
      (state.mcpServers ?? [])
        .filter((server) => server.installed && server.enabled && !server.missingTools?.length)
        .map((server) => server.host),
    ),
  ];
}

/**
 * The status strip's boundary for an app state: the one place that decides
 * what the strip says about the model and where prompts go. The reach map
 * on Connections is tested against it.
 */
export function deriveDataBoundary(state: AppState, voiceHosted = false): DataBoundary {
  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const provider = state.providers.find((entry) => entry.id === state.activeProviderId);
  const model = resolveProviderDefaultModel(
    provider,
    state.activeModelByProviderId,
  ).model;

  if (voiceHosted) {
    // Hosted voice names its own destination, says whether tenant data is
    // in scope, and keeps a local chat model honest.
    const location = providerDataLocation(NOVA_VOICE_PROVIDER);
    const detail = providerDataLocationDetail(NOVA_VOICE_PROVIDER);
    const chatLocal = provider?.isLocal === true;
    return {
      kind: "hosted",
      label: "Voice · OpenAI",
      model: "GPT-Live-1",
      voiceProvider: NOVA_VOICE_PROVIDER.name,
      voiceLocation: location,
      tooltip: `${novaVoiceSentence(location, Boolean(activeTenant), chatLocal ? provider?.name : undefined)}${detail ? ` ${detail}` : ""}`,
      isVoiceHosted: true,
    };
  }

  // Pilot mode never sends anything to a model: Chat answers are prepared
  // and pilot agents use prepared text, whatever provider is configured.
  if (activeTenant?.kind === "sample") {
    return {
      kind: "local",
      label: PILOT_COPY.boundaryLabel,
      tooltip: PILOT_COPY.boundaryTooltip,
      isVoiceHosted: false,
    };
  }

  if (!provider || !["connected", "available"].includes(provider.status)) {
    const trust = deriveTrustCopy({
      scope: { tenantNames: activeTenant ? [activeTenant.displayName] : [] },
    });
    return {
      kind: "none",
      label: "No model",
      tooltip: trust.confirmBody,
      isVoiceHosted: false,
    };
  }

  const trust = deriveTrustCopy({
    provider,
    ...(model ? { model } : {}),
    scope: { tenantNames: activeTenant ? [activeTenant.displayName] : [] },
    toolHosts: chatToolHosts(state),
  });
  const toolHosts = trust.toolHosts ? { toolHosts: trust.toolHosts.strip, toolHostsNote: trust.toolHosts.composer } : {};
  const toolDetail = trust.toolHosts ? ` ${trust.toolHosts.detail}` : "";
  if (provider.isLocal) {
    return {
      kind: "local",
      label: `Local · ${provider.name}`,
      ...(model ? { model } : {}),
      ...toolHosts,
      tooltip: `${provider.name}${model ? ` using ${model}` : ""}. ${trust.storage}${toolDetail}`,
      isVoiceHosted: false,
    };
  }
  return {
    kind: "hosted",
    label: `Hosted · ${providerDataLocation(provider)}`,
    ...(model ? { model } : {}),
    ...toolHosts,
    tooltip: `${trust.boundary ?? trust.strip}${toolDetail}`,
    isVoiceHosted: false,
  };
}

const DataBoundaryContext = createContext<DataBoundaryContextValue | undefined>(undefined);

export function DataBoundaryProvider({ children }: { children: ReactNode }) {
  const { state } = useAppState();
  const [voiceHosted, setVoiceHosted] = useState(false);

  const boundary = useMemo<DataBoundary>(() => deriveDataBoundary(state, voiceHosted), [state, voiceHosted]);

  const value = useMemo(
    () => ({ boundary, setVoiceHosted }),
    [boundary],
  );
  return <DataBoundaryContext.Provider value={value}>{children}</DataBoundaryContext.Provider>;
}

export function useDataBoundary(): DataBoundaryContextValue {
  const value = useContext(DataBoundaryContext);
  if (!value) throw new Error("useDataBoundary must be used within DataBoundaryProvider.");
  return value;
}

export function useDataBoundaryOptional(): DataBoundaryContextValue | undefined {
  return useContext(DataBoundaryContext);
}

/**
 * What hosted Nova voice sends, as the strip tooltip and the composer say
 * it: audio, shared context and its web searches, tenant data only with an
 * organization, and a local chat model that stays on this device.
 */
export function novaVoiceSentence(location: string, hasOrganization: boolean, localChatModel?: string): string {
  const what = hasOrganization
    ? "Nova voice is active: audio, shared context with tenant data, and its web searches go to"
    : "Nova voice is active: audio, shared context and its web searches go to";
  const tenant = hasOrganization ? "" : " No organization is active, so no tenant data is included.";
  const local = localChatModel ? ` The chat model, ${localChatModel}, stays on this device.` : "";
  return `${what} ${location}.${tenant}${local}`;
}
