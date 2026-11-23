import { MODEL_FIT_COPY } from "../copy/model-fit";
import { activeModelProvider } from "@openadminos/agent-sdk";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { SETUP_COPY } from "../copy";
import { useToast } from "../components/Toast";
import { isProviderImplemented } from "../shared/providers";
import type {
  ConnectTenantOptions,
  ProviderId,
  ProviderSummary,
  RequestedScope,
  TenantRecord,
} from "../shared/openAdminOS";
import { isManagedSettingLocked, isRemoteBackedModel } from "../shared/openAdminOS";
import { hostedModelFitModel, onDeviceRerunProvider, SELF_HOSTED_PROVIDER_IDS } from "../shared/model-fit";
import { useAppState } from "../state";
import {
  clearPendingIntent,
  readPendingIntent,
  writePendingIntent,
  type PendingIntent,
} from "./pending-intent";
import { TenantSetupDialog, type SetupStage } from "./TenantSetupDialog";

const SOFT_TIMEOUT_MS = 180_000;

/** Options of an entry point that shows its own result after a connect, such as the Microsoft 365 onboarding step. */
export interface SetupOpenOptions {
  /** Called with the connected tenant instead of the dialog's ready step; the dialog closes. */
  onConnected?: (tenant: TenantRecord) => void;
}

interface SetupFlowValue {
  /**
   * Hard constraint 3: nothing reads or writes a service unless it is
   * connected in the active organization. These gates open setup when no
   * organization is active, for work that always reads a service: cache
   * refresh, Changes, schedules and Chat. An agent run does not call them
   * without an organization; its preflight names the services instead,
   * and only an agent that calls no service API starts without one.
   */
  requireTenant(intent?: PendingIntent): boolean;
  requireTenantAndProvider(intent?: PendingIntent): boolean;
  /** Opens tenant setup on the sign-in choice with neither app chosen. */
  openSetup(): void;
  /**
   * Opens tenant setup with the service parts an entry point names
   * preselected, such as the not-connected card in Chat. The app choice
   * stays open.
   */
  openSetupForParts(partIds: readonly string[], options?: SetupOpenOptions): void;
  /** Opens tenant setup with "Your own app registration" chosen, and the named parts preselected. */
  openOwnRegistration(partIds?: readonly string[], options?: SetupOpenOptions): void;
}

const SetupFlowContext = createContext<SetupFlowValue | null>(null);

export function SetupFlowProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const toast = useToast();
  const {
    state,
    loading,
    connectTenant,
    cancelConnectTenant,
    getRequestedScopes,
    setActiveProvider,
    refresh,
  } = useAppState();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<SetupStage>("permissions");
  const [intent, setIntent] = useState<PendingIntent | null>(null);
  const [scopes, setScopes] = useState<RequestedScope[] | null>(null);
  const [scopesError, setScopesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectedTenant, setConnectedTenant] = useState<TenantRecord | undefined>();
  // Options of the last sign-in attempt, so "Try again" and "Change
  // sign-in options" never switch the admin to a different app.
  const lastOptionsRef = useRef<ConnectTenantOptions | undefined>(undefined);
  const [editOptions, setEditOptions] = useState<ConnectTenantOptions | undefined>();
  const [presetPartIds, setPresetPartIds] = useState<readonly string[] | undefined>();
  const attemptIdRef = useRef(0);
  const restoredRef = useRef(false);
  // Set by an entry point that shows its own result after a connect.
  const onConnectedRef = useRef<SetupOpenOptions["onConnected"]>(undefined);

  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const pendingAgentName =
    intent?.kind === "agent-run"
      ? state.installedAgents.find((agent) => agent.slug === intent.slug)?.name ??
        state.registryAgents.find((agent) => agent.slug === intent.slug)?.name
      : undefined;
  const selectedProvider = state.providers.find((provider) => provider.id === (
    (intent?.kind === "agent-run" && intent.providerId) || state.activeProviderId
  ));
  const onDeviceModelMissing = isOneRunProviderIntent(intent) && selectedProvider?.isLocal &&
    selectedProvider.status === "connected" && onDeviceRerunProvider(selectedProvider).models.length === 0;
  const dryRunIntent = lockedDryRunIntent(intent);
  const dryRunProvider = state.providers.find((provider) => provider.id === dryRunIntent?.providerId);
  const providerReady = useCallback(
    (candidate: PendingIntent | null | undefined) => {
      const providerId =
        candidate?.kind === "agent-run" && candidate.providerId
          ? candidate.providerId
          : state.activeProviderId;
      const dryRun = lockedDryRunIntent(candidate);
      const provider = state.providers.find((entry) => entry.id === (dryRun ? dryRun.providerId : providerId));
      if (dryRun?.model && (!provider?.models.includes(dryRun.model) || provider.modelsFromPolicy)) return false;
      if (dryRun?.model && dryRun.safeguards?.onDevice && provider && isRemoteBackedModel(provider, dryRun.model)) return false;
      // A run for one request after a model fit failure never goes to a self-hosted server outside this device.
      if (isOneRunProviderIntent(candidate) && provider && !modelFitUsable(provider, state.activeModelByProviderId, candidate.safeguards?.onDevice === true)) return false;
      return Boolean(
        provider &&
          isProviderImplemented(provider.id) &&
          (provider.status === "connected" ||
            // The host accepts a fully configured Azure deployment at
            // "available" (its probe has no connected state). Gating on
            // "connected" alone made every Azure send loop into setup.
            (provider.id === "azure-openai" && provider.status === "available")),
      );
    },
    [state.activeModelByProviderId, state.activeProviderId, state.providers],
  );
  const providerReadyForIntent = providerReady;

  const loadScopes = useCallback(async () => {
    setScopes(null);
    setScopesError(null);
    try {
      setScopes(await getRequestedScopes());
    } catch (caught) {
      setScopesError(
        caught instanceof Error
          ? caught.message
          : "Requested permissions could not be loaded. Close this dialog and try again.",
      );
    }
  }, [getRequestedScopes]);

  const beginFlow = useCallback(
    (nextIntent: PendingIntent | null, requestedStage?: SetupStage, partIds?: readonly string[], options?: SetupOpenOptions) => {
      attemptIdRef.current += 1;
      onConnectedRef.current = options?.onConnected;
      setIntent(nextIntent);
      setError(null);
      setEditOptions(undefined);
      setPresetPartIds(partIds && partIds.length > 0 ? partIds : undefined);
      lastOptionsRef.current = undefined;
      setConnectedTenant(activeTenant);
      if (nextIntent) writePendingIntent(nextIntent);
      else clearPendingIntent();

      const nextStage =
        requestedStage ??
        (!activeTenant
          ? "permissions"
          : nextIntent &&
              intentNeedsProvider(nextIntent) &&
              !providerReadyForIntent(nextIntent)
            ? "provider"
            : "ready");
      setStage(nextStage);
      setOpen(true);
      if (nextStage === "permissions" || nextStage === "own-registration") {
        void loadScopes();
      }
    },
    [activeTenant, loadScopes, providerReadyForIntent],
  );

  useEffect(() => {
    if (loading || restoredRef.current) return;
    restoredRef.current = true;
    // A restored pending intent reopens its setup. Nothing else opens on
    // its own: a fresh install starts in Chat, which needs only a model.
    const restored = readPendingIntent();
    if (restored) beginFlow(restored);
  }, [beginFlow, loading]);

  useEffect(() => {
    if (!open || stage !== "waiting") return;
    const timer = window.setTimeout(() => setStage("timeout"), SOFT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [open, stage]);

  useEffect(() => {
    if (!open || stage !== "provider") return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [open, refresh, stage]);

  // A provider picked for one run moves setup on only once its full check is done,
  // so a cached "connected" does not let the admin resume before a stale sign-in shows.
  // A count, so a second pick while the first check runs keeps it pending until both are done.
  const [oneRunChecksRunning, setOneRunChecksRunning] = useState(0);
  useEffect(() => {
    if (open && stage === "provider" && oneRunChecksRunning === 0 && providerReadyForIntent(intent)) {
      setStage("ready");
    } else if (open && stage === "ready" && lockedDryRunIntent(intent) && !providerReadyForIntent(intent)) {
      setStage("provider");
    }
  }, [intent, oneRunChecksRunning, open, providerReadyForIntent, stage]);

  const requireTenant = useCallback(
    (nextIntent?: PendingIntent) => {
      if (activeTenant) return true;
      beginFlow(nextIntent ?? null, "permissions");
      return false;
    },
    [activeTenant, beginFlow],
  );

  const requireTenantAndProvider = useCallback(
    (nextIntent?: PendingIntent) => {
      if (activeTenant && providerReadyForIntent(nextIntent)) return true;
      beginFlow(nextIntent ?? null, activeTenant ? "provider" : "permissions");
      return false;
    },
    [activeTenant, beginFlow, providerReadyForIntent],
  );

  const openSetup = useCallback(() => beginFlow(null, "permissions"), [beginFlow]);
  const openSetupForParts = useCallback(
    (partIds: readonly string[], options?: SetupOpenOptions) => beginFlow(null, "permissions", partIds, options),
    [beginFlow],
  );
  const openOwnRegistration = useCallback(
    (partIds?: readonly string[], options?: SetupOpenOptions) => beginFlow(null, "own-registration", partIds, options),
    [beginFlow],
  );

  const closeFlow = useCallback(() => {
    const wasWaiting = stage === "waiting" || stage === "timeout";
    attemptIdRef.current += 1;
    onConnectedRef.current = undefined;
    setOpen(false);
    setIntent(null);
    setError(null);
    clearPendingIntent();
    if (wasWaiting) void cancelConnectTenant();
  }, [cancelConnectTenant, stage]);

  const startConnect = useCallback(async (options?: ConnectTenantOptions) => {
    const attemptId = attemptIdRef.current + 1;
    attemptIdRef.current = attemptId;
    lastOptionsRef.current = options;
    setError(null);
    setStage("waiting");
    try {
      const tenant = await connectTenant(options);
      if (attemptId !== attemptIdRef.current) {
        if (tenant) toast.success(SETUP_COPY.lateSuccess(tenant.displayName));
        return;
      }
      const onConnected = onConnectedRef.current;
      if (tenant && onConnected && !intent) {
        // The entry point shows what was connected itself.
        onConnectedRef.current = undefined;
        setConnectedTenant(tenant);
        setOpen(false);
        onConnected(tenant);
        return;
      }
      setConnectedTenant(tenant);
      // Intent-less flows (first run, status strip, Settings) continue into
      // provider selection when no provider is connected yet, so a fresh
      // install is fully usable when the dialog closes.
      setStage(
        (!intent || intentNeedsProvider(intent)) && !providerReady(intent)
          ? "provider"
          : "ready",
      );
    } catch (caught) {
      if (attemptId !== attemptIdRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setStage("error");
    }
  }, [connectTenant, intent, providerReady, state.tenants, toast]);


  const tryAgain = useCallback(async () => {
    attemptIdRef.current += 1;
    await cancelConnectTenant().catch(() => undefined);
    void startConnect(lastOptionsRef.current);
  }, [cancelConnectTenant, startConnect]);

  const editSignIn = useCallback(() => {
    setEditOptions(lastOptionsRef.current);
    setError(null);
    setStage("permissions");
  }, []);

  const recheckOneRunProvider = useCallback(
    async (id: ProviderId) => {
      setOneRunChecksRunning((running) => running + 1);
      try {
        await window.openAdminOS?.recheckProvider?.(id);
      } finally {
        // The list is read again even when the check failed, so it does not stay stale.
        try {
          await refresh();
        } finally {
          setOneRunChecksRunning((running) => running - 1);
        }
      }
    },
    [refresh],
  );

  const recheckProviders = useCallback(async () => {
    try {
      setError(null);
      const providerId = dryRunIntent?.providerId ?? (isOneRunProviderIntent(intent) ? intent.providerId : undefined);
      if (providerId) await recheckOneRunProvider(providerId);
      else await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [dryRunIntent, intent, recheckOneRunProvider, refresh]);

  const selectProvider = useCallback(
    async (id: ProviderId) => {
      if (dryRunIntent) return;
      try {
        setError(null);
        setIntent((current) => {
          if (current?.kind !== "agent-run" || lockedDryRunIntent(current)) return current;
          const next = { ...current, providerId: id, model: undefined };
          writePendingIntent(next);
          return next;
        });
        // A run that moves off a local model that could not fit it is for that run only:
        // the replacement stays on the run and the active provider is left as it was. It still
        // gets the full check selecting a provider runs, so a cached result does not hold it back.
        if (isOneRunProviderIntent(intent)) {
          await recheckOneRunProvider(id);
          return;
        }
        await setActiveProvider(id);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [dryRunIntent, intent, recheckOneRunProvider, setActiveProvider],
  );

  const resume = useCallback(() => {
    const nextIntent = intent ?? readPendingIntent();
    if (lockedDryRunIntent(nextIntent) && !providerReadyForIntent(nextIntent)) {
      setStage("provider");
      return;
    }
    clearPendingIntent();
    setIntent(null);
    setOpen(false);
    if (!nextIntent) return;

    switch (nextIntent.kind) {
      case "chat-send":
        navigate(nextIntent.returnTo, {
          state: { resumePendingIntent: nextIntent },
        });
        break;
      case "agent-run":
        navigate(`/agents/${encodeURIComponent(nextIntent.slug)}/confirm`, {
          state: { resumePendingIntent: nextIntent },
        });
        break;
      case "view-changes":
        navigate("/changes");
        break;
      case "refresh-cache":
        navigate(nextIntent.returnTo, {
          state: { resumePendingIntent: nextIntent },
        });
        break;
      case "scheduled-batch":
        navigate(nextIntent.returnTo, {
          state: { resumePendingIntent: nextIntent },
        });
        break;
    }
  }, [intent, navigate, providerReadyForIntent]);

  const value = useMemo<SetupFlowValue>(
    () => ({
      requireTenant,
      requireTenantAndProvider,
      openSetup,
      openSetupForParts,
      openOwnRegistration,
    }),
    [openOwnRegistration, openSetup, openSetupForParts, requireTenant, requireTenantAndProvider],
  );

  return (
    <SetupFlowContext.Provider value={value}>
      {children}
      <TenantSetupDialog
        open={open}
        stage={stage}
        intent={intent}
        scopes={scopes}
        scopesError={scopesError}
        error={error ?? (stage === "provider" && onDeviceModelMissing ? MODEL_FIT_COPY.onDeviceModelMissing(selectedProvider.name) : null)}
        activeTenant={connectedTenant ?? activeTenant}
        agentName={pendingAgentName}
        // The picker for one run offers only what the run host admits for it.
        providers={isOneRunProviderIntent(intent)
          ? state.providers.filter((provider) => modelFitUsable(provider, state.activeModelByProviderId, intent.safeguards?.onDevice === true))
          : state.providers.map((provider) => activeModelProvider(provider, state.activeModelByProviderId))}
        activeProviderId={isOneRunProviderIntent(intent) && intent.providerId ? intent.providerId : state.activeProviderId}
        {...(dryRunIntent ? {
          dryRunSetup: {
            provider: dryRunProvider,
            providerId: dryRunIntent.providerId,
            model: dryRunIntent.model,
            onOpenAgent: () => {
              closeFlow();
              navigate(`/agents/${encodeURIComponent(dryRunIntent.slug)}`);
            },
          },
        } : {})}
        savedRegistrations={state.savedAppRegistrations ?? []}
        registrationLocked={
          isManagedSettingLocked(state.managedPolicy, "appRegistration") &&
          (state.savedAppRegistrations ?? []).some((entry) => entry.managed)
        }
        {...(editOptions ? { editOptions } : {})}
        {...(presetPartIds ? { presetPartIds } : {})}
        onClose={closeFlow}
        onConnect={(options) => void startConnect(options)}
        onKeepWaiting={() => setStage("waiting")}
        onTryAgain={() => void tryAgain()}
        onEditSignIn={editSignIn}
        onSelectProvider={(id) => void selectProvider(id)}
        onRecheckProviders={recheckProviders}
        onResume={resume}
      />
    </SetupFlowContext.Provider>
  );
}

export function useSetupFlow(): SetupFlowValue {
  const value = useContext(SetupFlowContext);
  if (!value) {
    throw new Error("useSetupFlow must be used inside SetupFlowProvider.");
  }
  return value;
}

export function currentReturnTo(pathname: string, search = ""): string {
  return `${pathname}${search}`;
}

/** A self-hosted server outside this device (LM Studio, Lemonade or Ollama reached elsewhere) is never a model fit choice. */
function modelFitEligible(provider: ProviderSummary, onDevice: boolean): boolean {
  return provider.isLocal || (!onDevice && !SELF_HOSTED_PROVIDER_IDS.has(provider.id));
}

/**
 * A connected hosted provider is ready for a model fit rerun only with a model the run could name
 * (listed, not a placeholder such as Gemini's `gemini-default`, not only a policy lock). One that
 * still needs setup stays in the picker, so the admin can set it up.
 */
function modelFitUsable(provider: ProviderSummary, activeModelByProviderId: Partial<Record<ProviderId, string>> | undefined, onDevice: boolean): boolean {
  if (!modelFitEligible(provider, onDevice)) return false;
  // Azure OpenAI's ready state is "available"; any other state still needs setup.
  const ready = provider.status === "connected" || (provider.id === "azure-openai" && provider.status === "available");
  if (!ready) return true;
  if (provider.isLocal) return onDeviceRerunProvider(provider).models.length > 0;
  return hostedModelFitModel(provider, activeModelByProviderId) !== undefined;
}

function lockedDryRunIntent(intent: PendingIntent | null | undefined) {
  return intent?.kind === "agent-run" && intent.runForRealOfRunId ? intent : undefined;
}

/** A model fit rerun (or Run again of one): the provider it names is for this run only. */
function isOneRunProviderIntent(
  intent: PendingIntent | null | undefined,
): intent is Extract<PendingIntent, { kind: "agent-run" }> {
  return intent?.kind === "agent-run" && Boolean(intent.modelFit || intent.safeguards);
}

function intentNeedsProvider(intent: PendingIntent): boolean {
  return (
    intent.kind === "chat-send" ||
    intent.kind === "agent-run" ||
    intent.kind === "scheduled-batch"
  );
}
