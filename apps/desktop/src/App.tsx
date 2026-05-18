import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { AppShell } from "./components/AppShell";
import { useAppState } from "./state";
import AgentsHome from "./pages/AgentsHome";
import AgentDetail from "./pages/AgentDetail";
import AgentHub from "./pages/AgentHub";
import Activity from "./pages/Activity";
import Connectors from "./pages/Connectors";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import RunResult from "./pages/RunResult";

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { state, loading } = useAppState();
  const noShell = location.pathname.startsWith("/onboarding");

  useEffect(() => {
    const api = window.openAgents;
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

  // Routing gate: no tenants -> onboarding is the only reachable route.
  // Defer the gate until initial state has loaded so we don't bounce a
  // user with persisted tenants through onboarding during cold start.
  if (!loading && state.tenants.length === 0 && !noShell) {
    // eslint-disable-next-line no-console
    console.warn(
      "[app] redirecting to /onboarding because state.tenants is empty",
      {
        loading,
        tenantsLength: state.tenants.length,
        activeTenantId: state.activeTenantId,
        path: location.pathname,
      },
    );
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
        <Route path="/agents/:slug" element={<AgentDetail />} />
        <Route path="/hub" element={<AgentHub />} />
        <Route path="/connectors" element={<Connectors />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/runs/:id" element={<RunResult />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
