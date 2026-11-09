import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { IconChevronDown, IconMarketplace, IconPlus } from "../components/icons";
import { Button, Menu } from "../components/ui";
import AgentDetail from "./AgentDetail";
import AgentsHome from "./AgentsHome";

export default function Agents({ startRunOnOpen = false }: { startRunOnOpen?: boolean }) {
  const navigate = useNavigate();
  const { slug } = useParams();
  const [searchParams] = useSearchParams();

  // The hub tab moved to the Marketplace. Agent detail links keep working.
  if (!slug && searchParams.get("source") === "hub") {
    return <Navigate to="/marketplace?kind=agents" replace />;
  }

  return (
    <>
      <PageHeader
        title="Agents"
        actions={
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
        }
      />
      <PageBody>
        <AgentsHome />
      </PageBody>
      <AgentDetail startRunOnOpen={startRunOnOpen} />
    </>
  );
}
