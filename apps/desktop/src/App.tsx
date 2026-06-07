import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { AppShell, TitleBarInset } from "./components/AppShell";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { useAppState } from "./state";
import AgentsHome from "./pages/AgentsHome";
import AgentDetail from "./pages/AgentDetail";
import AgentHub from "./pages/AgentHub";
import Activity from "./pages/Activity";
import IntuneChat from "./pages/IntuneChat";
import Connectors from "./pages/Connectors";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import RunResult from "./pages/RunResult";
import Schedules from "./pages/Schedules";

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { state, loading } = useAppState();
  const noShell = location.pathname.startsWith("/onboarding");
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
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
      </Routes>
    );
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<AgentsHome />} />
        <Route path="/agents/schedules" element={<Schedules />} />
        <Route path="/agents/:slug/confirm" element={<AgentDetail startRunOnOpen />} />
        <Route path="/agents/:slug" element={<AgentDetail />} />
        <Route path="/hub" element={<AgentHub />} />
        <Route path="/chat" element={<IntuneChat />} />
        <Route path="/connectors" element={<Connectors />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/runs/:id" element={<RunResult />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
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
