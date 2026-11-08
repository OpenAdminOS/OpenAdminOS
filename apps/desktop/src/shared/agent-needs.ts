import {
  agentCallsNoServiceApi,
  agentServiceIds,
  availableScopeSet,
  missingPartsForScopes,
  partLabel,
  serviceById,
  serviceStatus,
  type ServiceId,
  type ServicePart,
  type TenantRecord,
} from "./openAdminOS";

/** One chip under an agent: a service it reads, or a missing part of one. */
export interface AgentNeedChip {
  key: string;
  label: string;
  serviceId?: ServiceId;
  state: "ok" | "missing" | "none";
}

/**
 * What the agent's run button does for the active organization. With
 * everything connected it says Run; otherwise it names what is missing.
 */
export type AgentNeedAction =
  | { kind: "run"; label: "Run" }
  | { kind: "no-organization"; label: string; serviceIds: ServiceId[] }
  | { kind: "connect-service"; label: string; serviceId: ServiceId }
  | { kind: "add-part"; label: string; serviceId: ServiceId; partId: string };

export interface AgentNeeds {
  /** True only for an agent that calls no service API: it runs without an organization. */
  serviceFree: boolean;
  serviceIds: ServiceId[];
  chips: AgentNeedChip[];
  action: AgentNeedAction;
}

/** "sign-in logs" for the Entra sign-in logs part, keeping proper nouns. */
export function partShortLabel(part: ServicePart): string {
  return partLabel(part).slice(serviceById(part.service).title.length + 1);
}

type AgentShape = {
  scopes: readonly string[];
  services?: readonly ServiceId[];
  mode?: string;
  connectors?: readonly unknown[];
  graphOperations?: readonly unknown[];
};

/**
 * Services an agent reads and what the active organization is missing.
 * `tenant` is the active organization's Microsoft 365 tenant; undefined
 * means "No organization". `hasOrganizations` decides whether the action
 * asks to choose one or to connect the first service.
 */
export function agentNeeds(
  agent: AgentShape,
  tenant: TenantRecord | undefined,
  hasOrganizations = false,
): AgentNeeds {
  const serviceIds = agentServiceIds(agent);
  if (agentCallsNoServiceApi(agent)) {
    return {
      serviceFree: true,
      serviceIds,
      chips: [{ key: "none", label: "No service needed", state: "none" }],
      action: { kind: "run", label: "Run" },
    };
  }
  const titles = serviceIds.map((id) => serviceById(id).title);
  if (!tenant) {
    return {
      serviceFree: false,
      serviceIds,
      chips:
        serviceIds.length > 0
          ? serviceIds.map((id) => ({ key: id, label: serviceById(id).title, serviceId: id, state: "missing" as const }))
          : [{ key: "microsoft365", label: "Microsoft 365 sign-in", state: "missing" as const }],
      action: {
        kind: "no-organization",
        label: hasOrganizations
          ? "Choose an organization"
          : `Connect ${titles[0] ?? "Microsoft 365"}`,
        serviceIds,
      },
    };
  }
  const missingServices = serviceIds.filter((id) => serviceStatus(tenant, id) === "missing");
  const missingParts = missingPartsForScopes(agent.scopes, availableScopeSet(tenant), serviceIds).filter(
    (part) => !missingServices.includes(part.service),
  );
  const chips: AgentNeedChip[] = [
    ...serviceIds.map((id) => ({
      key: id,
      label: serviceById(id).title,
      serviceId: id,
      state: missingServices.includes(id) ? ("missing" as const) : ("ok" as const),
    })),
    ...missingParts.map((part) => ({
      key: part.id,
      label: partLabel(part),
      serviceId: part.service,
      state: "missing" as const,
    })),
  ];
  const firstMissing = missingServices[0];
  if (firstMissing) {
    return {
      serviceFree: false,
      serviceIds,
      chips,
      action: { kind: "connect-service", label: `Connect ${serviceById(firstMissing).title}`, serviceId: firstMissing },
    };
  }
  const firstPart = missingParts[0];
  if (firstPart) {
    return {
      serviceFree: false,
      serviceIds,
      chips,
      action: { kind: "add-part", label: `Add ${partShortLabel(firstPart)}`, serviceId: firstPart.service, partId: firstPart.id },
    };
  }
  return { serviceFree: false, serviceIds, chips, action: { kind: "run", label: "Run" } };
}
