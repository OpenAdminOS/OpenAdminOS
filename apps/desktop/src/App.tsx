import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { AppShell, TitleBarInset } from "./components/AppShell";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { useAppState } from "./state";

const Agents = lazy(() => import("./pages/Agents"));
const AgentsHome = lazy(() => import("./pages/AgentsHome"));
const AgentDetail = lazy(() => import("./pages/AgentDetail"));
const AgentHub = lazy(() => import("./pages/AgentHub"));
const Activity = lazy(() => import("./pages/Activity"));
const IntuneChat = lazy(() => import("./pages/IntuneChat"));
const Changes = lazy(() => import("./pages/Changes"));
const Workspaces = lazy(() => import("./pages/Workspaces"));
const Connectors = lazy(() => import("./pages/Connectors"));
const Settings = lazy(() => import("./pages/Settings"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const RunResult = lazy(() => import("./pages/RunResult"));
const Schedules = lazy(() => import("./pages/Schedules"));
const MenuBarCompanion = lazy(() => import("./pages/MenuBarCompanion"));

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { state, loading } = useAppState();
  const noShell = location.pathname.startsWith("/onboarding");
  const isCompanion = location.pathname.startsWith("/companion");
  const hasDesktopBridge = Boolean(window.openAdminOS);

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api) return;
    const unsubscribeFocusRun = api.onFocusRun((runId) => {
      navigate(`/runs/${runId}`);
    });
    const unsubscribeNavigate = api.onNavigate((path) => {
      navigate(path);
    });
    return () => {
      unsubscribeFocusRun();
      unsubscribeNavigate();
    };
  }, [navigate]);

  if (isCompanion) {
    return (
      <Suspense fallback={<RouteFallback compact />}>
        <Routes>
          <Route path="/companion" element={<MenuBarCompanion />} />
        </Routes>
      </Suspense>
    );
  }

  if (!hasDesktopBridge && !noShell) {
    return <DesktopBridgeUnavailable onOpenOnboarding={() => navigate("/onboarding")} />;
  }

  // Routing gate: no tenants -> onboarding is the only reachable route.
  // Defer the gate until initial state has loaded so we don't bounce a
  // user with persisted tenants through onboarding during cold start.
  if (!loading && state.tenants.length === 0 && !noShell) {
    return <Navigate to="/onboarding" replace />;
  }

  if (noShell) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/onboarding" element={<Onboarding />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <AppShell>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/agents" element={<Agents />}>
            <Route index element={<AgentsHome />} />
            <Route path="hub" element={<AgentHub embedded />} />
            <Route path="schedules" element={<Schedules embedded />} />
          </Route>
          <Route path="/agents/:slug/confirm" element={<AgentDetail startRunOnOpen />} />
          <Route path="/agents/:slug" element={<AgentDetail />} />
          <Route path="/hub" element={<Navigate to="/agents/hub" replace />} />
          <Route path="/chat/:conversationId?" element={<IntuneChat />} />
          <Route path="/changes" element={<Changes />} />
          <Route path="/workspaces" element={<Workspaces />} />
          <Route path="/connectors" element={<Connectors />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/runs/:id" element={<RunResult />} />
          <Route path="/settings/:section?" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="flex h-full items-center justify-center px-6">
      <Card className="w-full max-w-[480px]">
        <div className="p-6">
          <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Route not found
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
            This page is not available
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-soft)]">
            The link may be outdated. Return to Chat to continue in the active tenant.
          </p>
          <Button className="mt-5" variant="primary" onClick={() => navigate("/chat")}>
            Return to Chat
          </Button>
        </div>
      </Card>
    </div>
  );
}

function RouteFallback({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[var(--color-bg)] text-[var(--color-text-muted)]">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="h-3 w-3 animate-spin rounded-full border border-[var(--color-border-strong)] border-t-[var(--color-info)]" />
        <span>{compact ? "Opening" : "Loading"}</span>
      </div>
    </div>
  );
}

function DesktopBridgeUnavailable({
  onOpenOnboarding,
}: {
  onOpenOnboarding: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <TitleBarInset />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <Card className="w-full max-w-[560px]">
          <div className="p-6">
            <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Renderer-only development
            </div>
            <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
              Desktop bridge unavailable
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-soft)]">
              This browser tab can render the UI, but it cannot access the Electron
              desktop bridge for tenant auth, local SQLite, Graph cache, clipboard,
              or agent runs. Use the Electron window started by `npm run dev` for
              tenant-connected testing.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => window.location.reload()}>
                Reload
              </Button>
              <Button variant="secondary" onClick={onOpenOnboarding}>
                View onboarding
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
