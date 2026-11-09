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
  RequestedScope,
  TenantRecord,
} from "../shared/openAdminOS";
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
  const providerReady = useCallback(
    (candidate: PendingIntent | null | undefined) => {
      const providerId =
        candidate?.kind === "agent-run" && candidate.providerId
          ? candidate.providerId
          : state.activeProviderId;
      const provider = state.providers.find((entry) => entry.id === providerId);
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
    [state.activeProviderId, state.providers],
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

  useEffect(() => {
    if (open && stage === "provider" && providerReadyForIntent(intent)) {
      setStage("ready");
    }
  }, [intent, open, providerReadyForIntent, stage]);

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

  const selectProvider = useCallback(
    async (id: ProviderId) => {
      try {
        setError(null);
        setIntent((current) => {
          if (current?.kind !== "agent-run") return current;
          const next = { ...current, providerId: id, model: undefined };
          writePendingIntent(next);
          return next;
        });
        await setActiveProvider(id);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [setActiveProvider],
  );

  const resume = useCallback(() => {
    const nextIntent = intent ?? readPendingIntent();
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
  }, [intent, navigate]);

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
        error={error}
        activeTenant={connectedTenant ?? activeTenant}
        agentName={pendingAgentName}
        providers={state.providers}
        activeProviderId={state.activeProviderId}
        savedRegistrations={state.savedAppRegistrations ?? []}
        {...(editOptions ? { editOptions } : {})}
        {...(presetPartIds ? { presetPartIds } : {})}
        onClose={closeFlow}
        onConnect={(options) => void startConnect(options)}
        onKeepWaiting={() => setStage("waiting")}
        onTryAgain={() => void tryAgain()}
        onEditSignIn={editSignIn}
        onSelectProvider={(id) => void selectProvider(id)}
        onRecheckProviders={refresh}
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

function intentNeedsProvider(intent: PendingIntent): boolean {
  return (
    intent.kind === "chat-send" ||
    intent.kind === "agent-run" ||
    intent.kind === "scheduled-batch"
  );
}
