import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { IconAgentTeam, IconChevronDown, IconHub, IconPlus } from "../components/icons";
import { Button, Menu } from "../components/ui";
import AgentDetail from "./AgentDetail";
import AgentsHome from "./AgentsHome";

export default function Agents({ startRunOnOpen = false }: { startRunOnOpen?: boolean }) {
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title="Agents"
        actions={
          <Menu
            align="end"
            ariaLabel="Add agent or teammate"
            trigger={
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<IconPlus size={14} />}
                trailingIcon={<IconChevronDown size={13} />}
              >
                Add
              </Button>
            }
            items={[
              {
                id: "add-teammate",
                label: "Add teammate",
                icon: <IconAgentTeam size={14} />,
                onSelect: () => navigate("/agents?add=teammate"),
              },
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
        }
      />
      <PageBody>
        <AgentsHome />
      </PageBody>
      <AgentDetail startRunOnOpen={startRunOnOpen} />
    </>
  );
}
