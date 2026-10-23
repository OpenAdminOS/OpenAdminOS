import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { deriveTrustCopy } from "../copy";
import { resolveProviderDefaultModel } from "../shared/openAdminOS";
import { useAppState } from "./AppStateContext";

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
      tooltip: string;
      isVoiceHosted: false;
    }
  | {
      kind: "hosted";
      label: string;
      model?: string;
      tooltip: string;
      isVoiceHosted: boolean;
    };

interface DataBoundaryContextValue {
  boundary: DataBoundary;
  setVoiceHosted: Dispatch<SetStateAction<boolean>>;
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
      const trust = deriveTrustCopy({
        provider: { name: "OpenAI", isLocal: false },
        model: "GPT-Live-1",
        scope: { tenantNames: activeTenant ? [activeTenant.displayName] : [] },
      });
      return {
        kind: "hosted",
        label: "Voice · OpenAI",
        model: "GPT-Live-1",
        tooltip: `${trust.boundary ?? trust.strip} Nova voice audio and shared context are active.`,
        isVoiceHosted: true,
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
    });
    if (provider.isLocal) {
      return {
        kind: "local",
        label: `Local · ${provider.name}`,
        ...(model ? { model } : {}),
        tooltip: `${provider.name}${model ? ` using ${model}` : ""}. ${trust.storage}`,
        isVoiceHosted: false,
      };
    }
    return {
      kind: "hosted",
      label: `Hosted · ${provider.name}`,
      ...(model ? { model } : {}),
      tooltip: `${trust.boundary ?? trust.strip}`,
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
