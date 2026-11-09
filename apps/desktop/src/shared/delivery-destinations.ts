import type { AgentSummary, ConnectorSummary } from "./openAdminOS.js";

/** Result connectors an agent can deliver to, in the order Connections lists them. */
const DELIVERY_CONNECTORS: ReadonlyArray<{
  key: keyof NonNullable<AgentSummary["delivery"]>;
  name: string;
  /** Posts with an organization's Microsoft sign-in, so it is skipped without one. */
  needsOrganization: boolean;
}> = [
  { key: "teams", name: "Microsoft Teams", needsOrganization: true },
  { key: "outlook", name: "Outlook", needsOrganization: true },
  { key: "slack", name: "Slack", needsOrganization: false },
  { key: "discord", name: "Discord", needsOrganization: false },
  { key: "signal", name: "Signal", needsOrganization: false },
  { key: "whatsappWeb", name: "WhatsApp", needsOrganization: false },
];

/** Connector id of each delivery rule key. */
const DELIVERY_CONNECTOR_IDS: Record<string, string> = {
  teams: "teams",
  outlook: "outlook",
  slack: "slack",
  discord: "discord",
  signal: "signal",
  whatsappWeb: "whatsapp-web",
};

/** One place a finished run's report can leave the device to. */
export interface ResultDestination {
  connectorId: string;
  name: string;
  /** Set up in Connections, so a report can actually be sent. */
  configured: boolean;
  /** At least one installed agent has a saved delivery rule for it. */
  byRule: boolean;
  /** At least one installed agent declares a step that uses it. */
  byStep: boolean;
}

function connectorConfigured(summary: ConnectorSummary | undefined): boolean {
  if (!summary) return false;
  if (summary.status === "connected") return true;
  return summary.status === "unknown" && Object.keys(summary.config ?? {}).length > 0;
}

/**
 * Where run reports can go: every connector that an enabled delivery rule
 * or a declared connector step of an installed agent uses, with whether
 * it is set up. The reach map and the Results section read this one list,
 * so they cannot disagree. Without the connector list yet (`undefined`),
 * nothing counts as configured.
 */
export function resultDestinations(
  agents: readonly AgentSummary[],
  connectors: readonly ConnectorSummary[] | undefined,
): ResultDestination[] {
  const byId = new Map<string, ResultDestination>();
  const entry = (connectorId: string) => {
    let current = byId.get(connectorId);
    if (!current) {
      const summary = connectors?.find((candidate) => candidate.descriptor.id === connectorId);
      current = {
        connectorId,
        name:
          summary?.descriptor.name ??
          DELIVERY_CONNECTORS.find((connector) => DELIVERY_CONNECTOR_IDS[connector.key] === connectorId)?.name ??
          connectorId,
        configured: connectorConfigured(summary),
        byRule: false,
        byStep: false,
      };
      byId.set(connectorId, current);
    }
    return current;
  };
  for (const agent of agents) {
    for (const connector of DELIVERY_CONNECTORS) {
      if (agent.delivery?.[connector.key]?.enabled === true) entry(DELIVERY_CONNECTOR_IDS[connector.key]!).byRule = true;
    }
    for (const requirement of agent.connectors ?? []) entry(requirement.id).byStep = true;
  }
  return [...byId.values()];
}

/** Names of the destinations a report can reach now: set up and used by a rule or a step. */
export function reportDestinations(destinations: readonly ResultDestination[]): string[] {
  return [...new Set(destinations.filter((destination) => destination.configured).map((destination) => destination.name))];
}

/** Rules or steps that point at a connector that is not set up, so nothing is sent there. */
export function unconfiguredDestinations(destinations: readonly ResultDestination[]): string[] {
  return [...new Set(destinations.filter((destination) => !destination.configured).map((destination) => destination.name))];
}

/**
 * Where a manual run's report can go under this agent's saved delivery
 * rules. A rule sends only to a connector that is set up (`notSetUp`
 * otherwise), and a run with no organization skips Teams and Outlook,
 * which post with an organization's sign-in (`skipped`).
 */
export function manualRunReportDestinations(
  agent: Pick<AgentSummary, "delivery">,
  hasOrganization: boolean,
  connectors: readonly ConnectorSummary[],
): { sent: string[]; skipped: string[]; notSetUp: string[] } {
  const applies = DELIVERY_CONNECTORS.filter((connector) => {
    const rule = agent.delivery?.[connector.key];
    return rule?.enabled === true && rule.includeManualRuns !== false;
  });
  const skipped = applies.filter((connector) => !hasOrganization && connector.needsOrganization);
  const rest = applies.filter((connector) => !skipped.includes(connector));
  const configured = (connector: (typeof DELIVERY_CONNECTORS)[number]) =>
    connectorConfigured(connectors.find((summary) => summary.descriptor.id === DELIVERY_CONNECTOR_IDS[connector.key]));
  return {
    sent: rest.filter(configured).map((connector) => connector.name),
    skipped: skipped.map((connector) => connector.name),
    notSetUp: rest.filter((connector) => !configured(connector)).map((connector) => connector.name),
  };
}
