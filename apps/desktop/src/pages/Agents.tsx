import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { IconChevronDown, IconMarketplace, IconPlus } from "../components/icons";
import { PilotProductionPage, usePilotMode } from "../components/PilotMode";
import { Button, Menu } from "../components/ui";
import AgentDetail from "./AgentDetail";
import AgentsHome from "./AgentsHome";
import PilotAgentsHome from "./PilotAgentsHome";

export default function Agents({ startRunOnOpen = false }: { startRunOnOpen?: boolean }) {
  const navigate = useNavigate();
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
  const pilot = usePilotMode();
  const pilotHiddenTab =
    pilot && searchParams.get("filter") === "scheduled"
      ? { feature: "Schedules", plural: true }
      : undefined;

  // The hub tab moved to the Marketplace. Agent detail links keep working.
  if (!slug && searchParams.get("source") === "hub") {
    return <Navigate to="/marketplace?kind=agents" replace />;
  }

  return (
    <>
      <PageHeader
        title="Agents"
        actions={
          pilot ? undefined : (
            <Menu
              align="end"
              ariaLabel="Add agent"
              trigger={
                <Button
                  variant="primary"
                  size="sm"
                  leadingIcon={<IconPlus size={14} />}
                  trailingIcon={<IconChevronDown size={13} />}
                >
                  New agent
                </Button>
              }
              items={[
                {
                  id: "browse-marketplace",
                  label: "Browse the Marketplace",
                  icon: <IconMarketplace size={14} />,
                  onSelect: () => navigate("/marketplace?kind=agents"),
                },
                {
                  id: "build-agent",
                  label: "Build your own agent",
                  icon: <IconPlus size={14} />,
                  onSelect: () => navigate("/agents?add=agent"),
                },
              ]}
            />
          )
        }
      />
      <PageBody>
        {pilotHiddenTab ? (
          <PilotProductionPage feature={pilotHiddenTab.feature} plural={pilotHiddenTab.plural} />
        ) : pilot ? (
          <PilotAgentsHome />
        ) : (
          <AgentsHome />
        )}
      </PageBody>
      <AgentDetail startRunOnOpen={startRunOnOpen} />
    </>
  );
}
