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

/** A delivery rule key, as stored on an installed agent. */
export type DeliveryRuleKey = keyof NonNullable<AgentSummary["delivery"]>;

/**
 * Why the host does not send a report under a saved rule. Only reasons
 * the host enforces before anything leaves the device are listed: the
 * rule is off, Teams or Outlook without an organization, or no
 * destination at all. A connector's health status is never a reason.
 */
export type DeliveryBlock = "rule-off" | "no-organization" | "no-target" | "no-default-target";

const configText = (config: Record<string, unknown>, key: string): string | undefined => {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

/**
 * The one decision on whether a saved rule sends a report, used by the
 * host before it sends and by every screen that says where reports go.
 * Returns undefined when the host will try to send: whether the saved
 * credentials work is only known when it does, so callers say the report
 * may be sent there. `config` is the connector's saved configuration;
 * undefined means it is not known yet, so a default destination is not
 * ruled out.
 */
export function deliveryBlock(
  key: DeliveryRuleKey,
  delivery: AgentSummary["delivery"],
  config: Record<string, unknown> | undefined,
  hasOrganization: boolean,
): DeliveryBlock | undefined {
  const rule = delivery?.[key];
  if (rule?.enabled !== true) return "rule-off";
  if (DELIVERY_CONNECTORS.find((connector) => connector.key === key)?.needsOrganization && !hasOrganization) {
    return "no-organization";
  }
  switch (key) {
    case "slack": {
      const slack = delivery?.slack;
      if (slack?.useDefaultChannel === false) return slack.channel?.trim() ? undefined : "no-target";
      return config && !configText(config, "defaultChannel") ? "no-default-target" : undefined;
    }
    case "signal": {
      const signal = delivery?.signal;
      if (signal?.useDefaultRecipient === false) return signal.recipient?.trim() ? undefined : "no-target";
      return config && !configText(config, "defaultRecipient") ? "no-default-target" : undefined;
    }
    case "whatsappWeb": {
      // The default recipient falls back to the linked account itself.
      const whatsApp = delivery?.whatsappWeb;
      return whatsApp?.useDefaultRecipient === false && !whatsApp.recipient?.trim() ? "no-target" : undefined;
    }
    case "outlook": {
      const outlook = delivery?.outlook;
      return outlook?.useDefaultRecipients === false &&
        !(outlook.recipients ?? []).some((recipient) => recipient.trim().length > 0)
        ? "no-target"
        : undefined;
    }
    default:
      return undefined;
  }
}

/** The delivery rule key of a connector id, if it has one. */
export function deliveryRuleKeyFor(connectorId: string): DeliveryRuleKey | undefined {
  return DELIVERY_CONNECTORS.find((connector) => DELIVERY_CONNECTOR_IDS[connector.key] === connectorId)?.key;
}

/** One place a finished run's report can leave the device to. */
export interface ResultDestination {
  connectorId: string;
  name: string;
  /**
   * The host will try to send there under at least one saved rule, or an
   * agent step uses it. Its saved credentials are only proven when it
   * sends, so this means a report may be sent there.
   */
  mayReceive: boolean;
  /** At least one installed agent has an enabled delivery rule for it. */
  byRule: boolean;
  /** At least one installed agent declares a step that uses it. */
  byStep: boolean;
}

/**
 * Where run reports can go: every connector that an enabled delivery rule
 * or a declared connector step of an installed agent uses, with whether
 * the host will try to send there (`deliveryBlock`, for a run in an
 * organization). The reach map and the Results section read this one
 * list, so they cannot disagree. Without the connector list yet
 * (`undefined`), a default destination is not ruled out.
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
        mayReceive: false,
        byRule: false,
        byStep: false,
      };
      byId.set(connectorId, current);
    }
    return current;
  };
  const configOf = (connectorId: string) =>
    connectors ? (connectors.find((summary) => summary.descriptor.id === connectorId)?.config ?? {}) : undefined;
  for (const agent of agents) {
    for (const connector of DELIVERY_CONNECTORS) {
      if (agent.delivery?.[connector.key]?.enabled !== true) continue;
      const connectorId = DELIVERY_CONNECTOR_IDS[connector.key]!;
      const destination = entry(connectorId);
      destination.byRule = true;
      if (!deliveryBlock(connector.key, agent.delivery, configOf(connectorId), true)) destination.mayReceive = true;
    }
    for (const requirement of agent.connectors ?? []) {
      const destination = entry(requirement.id);
      destination.byStep = true;
      destination.mayReceive = true;
    }
  }
  return [...byId.values()];
}

/** Names of the destinations a report may reach: the host will try to send there. */
export function reportDestinations(destinations: readonly ResultDestination[]): string[] {
  return [...new Set(destinations.filter((destination) => destination.mayReceive).map((destination) => destination.name))];
}

/** Connectors that saved rules name but that have no destination set, so the host sends nothing there. */
export function targetlessDestinations(destinations: readonly ResultDestination[]): string[] {
  return [...new Set(destinations.filter((destination) => destination.byRule && !destination.mayReceive).map((destination) => destination.name))];
}

/**
 * Where a manual run's report can go under this agent's saved delivery
 * rules, from the same decision the host makes (`deliveryBlock`): the
 * host tries to send (`mayGo`), skips Teams and Outlook for a run with no
 * organization (`skipped`), or has no destination to send to
 * (`noTarget`).
 */
export function manualRunReportDestinations(
  agent: Pick<AgentSummary, "delivery">,
  hasOrganization: boolean,
  connectors: readonly ConnectorSummary[],
): { mayGo: string[]; skipped: string[]; noTarget: string[] } {
  const result = { mayGo: [] as string[], skipped: [] as string[], noTarget: [] as string[] };
  for (const connector of DELIVERY_CONNECTORS) {
    if (agent.delivery?.[connector.key]?.includeManualRuns === false) continue;
    const connectorId = DELIVERY_CONNECTOR_IDS[connector.key]!;
    const config = connectors.find((summary) => summary.descriptor.id === connectorId)?.config ?? {};
    const block = deliveryBlock(connector.key, agent.delivery, config, hasOrganization);
    if (block === "rule-off") continue;
    if (block === "no-organization") result.skipped.push(connector.name);
    else if (block) result.noTarget.push(connector.name);
    else result.mayGo.push(connector.name);
  }
  return result;
}
