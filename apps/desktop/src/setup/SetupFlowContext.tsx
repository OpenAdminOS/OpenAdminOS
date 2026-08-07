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
import type { ProviderId, RequestedScope, TenantRecord } from "../shared/openAdminOS";
import { useAppState } from "../state";
import {
  clearPendingIntent,
  readPendingIntent,
  writePendingIntent,
  type PendingIntent,
} from "./pending-intent";
import { TenantSetupDialog, type SetupStage } from "./TenantSetupDialog";

const SOFT_TIMEOUT_MS = 180_000;

interface SetupFlowValue {
  requireTenant(intent?: PendingIntent): boolean;
  requireTenantAndProvider(intent?: PendingIntent): boolean;
  openSetup(): void;
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
  const attemptIdRef = useRef(0);
  const restoredRef = useRef(false);

  const activeTenant = state.activeTenantId
    ? state.tenants.find((tenant) => tenant.id === state.activeTenantId)
    : undefined;
  const pendingAgentName =
    intent?.kind === "agent-run"
      ? state.installedAgents.find((agent) => agent.slug === intent.slug)?.name ??
        state.registryAgents.find((agent) => agent.slug === intent.slug)?.name
      : undefined;
  const providerReadyForIntent = useCallback(
    (candidate: PendingIntent | null | undefined) => {
      const providerId =
        candidate?.kind === "agent-run" && candidate.providerId
          ? candidate.providerId
          : state.activeProviderId;
      const provider = state.providers.find((entry) => entry.id === providerId);
      return Boolean(
        provider &&
          isProviderImplemented(provider.id) &&
          provider.status === "connected",
      );
    },
    [state.activeProviderId, state.providers],
  );

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
    (nextIntent: PendingIntent | null, requestedStage?: SetupStage) => {
      attemptIdRef.current += 1;
      setIntent(nextIntent);
      setError(null);
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
      if (nextStage === "permissions") void loadScopes();
    },
    [activeTenant, loadScopes, providerReadyForIntent],
  );

  useEffect(() => {
    if (loading || restoredRef.current) return;
    restoredRef.current = true;
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

  const closeFlow = useCallback(() => {
    const wasWaiting = stage === "waiting" || stage === "timeout";
    attemptIdRef.current += 1;
    setOpen(false);
    setIntent(null);
    setError(null);
    clearPendingIntent();
    if (wasWaiting) void cancelConnectTenant();
  }, [cancelConnectTenant, stage]);

  const startConnect = useCallback(async () => {
    const attemptId = attemptIdRef.current + 1;
    attemptIdRef.current = attemptId;
    setError(null);
    setStage("waiting");
    try {
      const tenant = await connectTenant();
      if (attemptId !== attemptIdRef.current) {
        if (tenant) toast.success(SETUP_COPY.lateSuccess(tenant.displayName));
        return;
      }
      setConnectedTenant(tenant);
      setStage(
        intent && intentNeedsProvider(intent) && !providerReadyForIntent(intent)
          ? "provider"
          : "ready",
      );
    } catch (caught) {
      if (attemptId !== attemptIdRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setStage("error");
    }
  }, [connectTenant, intent, providerReadyForIntent, toast]);

  const tryAgain = useCallback(async () => {
    attemptIdRef.current += 1;
    await cancelConnectTenant().catch(() => undefined);
    void startConnect();
  }, [cancelConnectTenant, startConnect]);

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
    () => ({ requireTenant, requireTenantAndProvider, openSetup }),
    [openSetup, requireTenant, requireTenantAndProvider],
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
        onClose={closeFlow}
        onConnect={() => void startConnect()}
        onKeepWaiting={() => setStage("waiting")}
        onTryAgain={() => void tryAgain()}
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
