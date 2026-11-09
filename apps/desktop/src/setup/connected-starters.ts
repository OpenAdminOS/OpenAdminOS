import {
  AVAILABLE_SERVICES,
  grantedParts,
  serviceStatus,
  type ServiceDefinition,
  type ServicePart,
  type TenantRecord,
} from "../shared/openAdminOS";

export interface ConnectedService {
  service: ServiceDefinition;
  status: "connected" | "partial";
  /** The parts whose every scope is granted, in registry order. */
  parts: ServicePart[];
}

/**
 * The services a connected tenant can answer from, with the parts granted.
 * A tenant connected before grants were recorded has no list to read, so
 * nothing is claimed for it.
 */
export function connectedServices(tenant: TenantRecord | undefined): ConnectedService[] {
  if (!tenant || tenant.grantedScopes === undefined) return [];
  const granted = grantedParts(tenant);
  return AVAILABLE_SERVICES.flatMap((service) => {
    const status = serviceStatus(tenant, service.id);
    if (status === "missing") return [];
    return [{ service, status, parts: granted.filter((part) => part.service === service.id) }];
  });
}

/**
 * Chat's starters after a connect (mockup 32, section B): for each
 * connected service, questions its granted parts can answer, one per part
 * and at most two per service.
 */
export function connectedStarters(tenant: TenantRecord | undefined): { service: ServiceDefinition; prompts: string[] }[] {
  return connectedServices(tenant)
    .map(({ service, parts }) => ({
      service,
      prompts: [...new Set(parts.flatMap((part) => part.chatExamples.slice(0, 1)))].slice(0, 2),
    }))
    .filter((group) => group.prompts.length > 0);
}
