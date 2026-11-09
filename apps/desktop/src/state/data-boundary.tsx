import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { NOTHING_LEAVES_COPY, deriveTrustCopy, providerDataLocation, providerDataLocationDetail } from "../copy";

/** Where Nova voice audio is processed: OpenAI's service, following the workspace's data residency. */
const VOICE_LOCATION_DETAIL = "Processing follows your OpenAI workspace's data residency setting.";
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
      /** Status strip segment when nothing leaves the device: no reference is enabled. */
      note?: string;
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
  return (state.mcpServers ?? []).filter((server) => server.installed && server.enabled && !server.missingTools?.length).map((server) => server.host);
}

const DataBoundaryContext = createContext<DataBoundaryContextValue | undefined>(undefined);

export function DataBoundaryProvider({ children }: { children: ReactNode }) {
  const { state } = useAppState();
  const [voiceHosted, setVoiceHosted] = useState(false);

  const boundary = useMemo<DataBoundary>(() => {
    const activeTenant = state.activeTenantId
      ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
      : undefined;
    const provider = state.providers.find((entry) => entry.id === state.activeProviderId);
    const model = resolveProviderDefaultModel(
      provider,
      state.activeModelByProviderId,
    ).model;

    if (voiceHosted) {
      // Voice runs on OpenAI's own service, not Codex: say where it goes, what
      // the location depends on, and that no tenant data is sent when nothing is connected.
      const voiceBoundary = activeTenant
        ? "Voice audio, prompts and tenant data go to OpenAI."
        : "Voice audio and prompts go to OpenAI. Nothing is connected, so no tenant data is sent.";
      return {
        kind: "hosted",
        label: "Voice · OpenAI",
        model: "GPT-Live-1",
        tooltip: `${voiceBoundary} ${VOICE_LOCATION_DETAIL} Nova voice audio and shared context are active.`,
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
      noTenant: !activeTenant,
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
        ...(trust.toolHosts ? {} : { note: NOTHING_LEAVES_COPY }),
        tooltip: `${provider.name}${model ? ` using ${model}` : ""}. ${trust.storage}${toolDetail}`,
        isVoiceHosted: false,
      };
    }
    return {
      kind: "hosted",
      // The strip names the provider and where it processes prompts (hard constraint 1).
      label: `Hosted · ${providerDataLocation(provider)}`,
      ...(model ? { model } : {}),
      ...toolHosts,
      // The tooltip adds what the location depends on (the account, the workspace, the deployment type).
      tooltip: `${trust.boundary ?? trust.strip}${providerDataLocationDetail(provider) ? ` ${providerDataLocationDetail(provider)}` : ""}${toolDetail}`,
      isVoiceHosted: false,
    };
  }, [state, voiceHosted]);

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
