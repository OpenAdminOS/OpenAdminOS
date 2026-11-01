import { useNavigate, useSearchParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { IconChevronDown, IconHub, IconPlus } from "../components/icons";
import { PilotProductionPage, usePilotMode } from "../components/PilotMode";
import { Button, Menu } from "../components/ui";
import AgentDetail from "./AgentDetail";
import AgentsHome from "./AgentsHome";
import PilotAgentsHome from "./PilotAgentsHome";

export default function Agents({ startRunOnOpen = false }: { startRunOnOpen?: boolean }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pilot = usePilotMode();
  const pilotHiddenTab =
    pilot && searchParams.get("source") === "hub"
      ? { feature: "Agent Hub", plural: false }
      : pilot && searchParams.get("filter") === "scheduled"
        ? { feature: "Schedules", plural: true }
        : undefined;

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
                  id: "install-hub",
                  label: "Install from hub",
                  icon: <IconHub size={14} />,
                  onSelect: () => navigate("/agents?source=hub"),
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
