import type { AgentSummary } from "./openAdminOS.js";

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

/** Connectors that at least one installed agent sends reports to under a saved delivery rule. */
export function deliveryDestinations(agents: readonly AgentSummary[]): string[] {
  return DELIVERY_CONNECTORS.filter((connector) =>
    agents.some((agent) => agent.delivery?.[connector.key]?.enabled === true),
  ).map((connector) => connector.name);
}

/**
 * Where a manual run's report can go under this agent's saved delivery
 * rules. A run with no organization skips Teams and Outlook, which post
 * with an organization's sign-in; those are returned as `skipped`.
 */
export function manualRunReportDestinations(
  agent: Pick<AgentSummary, "delivery">,
  hasOrganization: boolean,
): { sent: string[]; skipped: string[] } {
  const applies = DELIVERY_CONNECTORS.filter((connector) => {
    const rule = agent.delivery?.[connector.key];
    return rule?.enabled === true && rule.includeManualRuns !== false;
  });
  return {
    sent: applies.filter((connector) => hasOrganization || !connector.needsOrganization).map((connector) => connector.name),
    skipped: applies.filter((connector) => !hasOrganization && connector.needsOrganization).map((connector) => connector.name),
  };
}
