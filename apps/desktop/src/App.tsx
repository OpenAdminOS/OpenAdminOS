import { Route, Routes, useLocation } from "react-router";
import { AppShell } from "./components/AppShell";
import AgentsHome from "./pages/AgentsHome";
import AgentDetail from "./pages/AgentDetail";
import AgentHub from "./pages/AgentHub";
import Activity from "./pages/Activity";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import RunResult from "./pages/RunResult";

export default function App() {
  const location = useLocation();
  const noShell = location.pathname.startsWith("/onboarding");

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
        <Route path="/activity" element={<Activity />} />
        <Route path="/runs/:id" element={<RunResult />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
