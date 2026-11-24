import {
  isSophosId,
  type PrepareSophosChangeInput,
  type SophosTarget,
  type WritePlan,
} from "@openadminos/agent-sdk";

import { SophosApiError, type SophosApi, type SophosIdentity } from "./api.js";

function targets(items: unknown): SophosTarget[] {
  if (!Array.isArray(items)) throw new SophosApiError("invalid-response", "Sophos Central did not return endpoints. Test the connection and try again.");
  return items.flatMap((item) => {
    if (!item || !isSophosId(item.id) || typeof item.hostname !== "string" || !item.hostname.trim()) return [];
    return [{
      id: item.id,
      hostname: item.hostname,
      isolationStatus: typeof item.isolation?.status === "string" ? item.isolation.status : "Unknown",
    }];
  });
}

export async function listSophosTargets(api: SophosApi, identity: SophosIdentity, search: string) {
  const query = new URLSearchParams({ pageSize: "50", view: "full" });
  if (search.trim()) query.set("search", search.trim());
  return targets((await api.read(identity, "endpoints", query)).items);
}

export async function prepareSophosPlan(api: SophosApi, identity: SophosIdentity, input: PrepareSophosChangeInput): Promise<WritePlan> {
  const { kind } = input;
  if (kind !== "isolate" && kind !== "release" && kind !== "scan") throw new Error("Choose isolate, release or scan.");
  if (!Array.isArray(input.targetIds) || input.targetIds.length < 1 || input.targetIds.length > 50 || !input.targetIds.every(isSophosId)) {
    throw new Error("Select between 1 and 50 Sophos Central endpoints.");
  }
  const ids = [...new Set(input.targetIds.map((id) => id.toLowerCase()))];
  const comment = typeof input.comment === "string" ? input.comment.trim() : "";
  if (kind !== "scan" && (!comment || comment.length > 400)) throw new Error("Enter an isolation reason of 1 to 400 characters.");
  const query = new URLSearchParams({ ids: ids.join(","), pageSize: "50", view: "full" });
  const endpoints = new Map(targets((await api.read(identity, "endpoints", query)).items).map((target) => [target.id.toLowerCase(), target]));
  const verb = kind === "isolate" ? "Isolate" : kind === "release" ? "Release" : "Scan";
  return {
    summary: `${verb} ${ids.length} Sophos Central ${ids.length === 1 ? "endpoint" : "endpoints"}.`,
    confirmationPhrase: `${verb.toUpperCase()} ${ids.length} ${ids.length === 1 ? "DEVICE" : "DEVICES"}`,
    actions: ids.map((id) => {
      const endpoint = endpoints.get(id);
      if (!endpoint) throw new Error(`Sophos Central no longer returned endpoint ${id}. Refresh the endpoint list and try again.`);
      if (kind !== "scan" && endpoint.isolationStatus !== "isolated" && endpoint.isolationStatus !== "notIsolated") {
        throw new Error("Sophos Central did not report an isolation state for this endpoint.");
      }
      if ((kind === "isolate" && endpoint.isolationStatus === "isolated")
          || (kind === "release" && endpoint.isolationStatus === "notIsolated")) {
        throw new Error(`${endpoint.hostname} already has the requested isolation state. Refresh the endpoint list and choose another endpoint.`);
      }
      const desired = kind === "isolate" ? "Isolated" : kind === "release" ? "Released" : "Scan requested";
      return {
        id,
        kind: "sophos-write",
        label: `${verb} ${endpoint.hostname}`,
        description: kind === "scan" ? `${id} · Request an endpoint scan` : `${id} · ${endpoint.isolationStatus} → ${desired} · ${comment}`,
        severity: kind === "isolate" ? "destructive" : "default",
        metadata: { service: "sophos", targetId: id, before: { isolation: endpoint.isolationStatus }, after: { desired } },
      };
    }),
  };
}

export async function recheckSophosTarget(
  api: SophosApi, identity: SophosIdentity, kind: PrepareSophosChangeInput["kind"],
  id: string, before: unknown, signal: AbortSignal,
) {
  const query = new URLSearchParams({ ids: id, pageSize: "50", view: "full" });
  const endpoint = targets((await api.read(identity, "endpoints", query, signal)).items)
    .find((target) => target.id.toLowerCase() === id.toLowerCase());
  if (!endpoint) throw new Error("Sophos Central could not find this endpoint. Refresh the endpoint list and prepare the change again.");
  if (kind === "scan") return;
  if (endpoint.isolationStatus === (kind === "isolate" ? "isolated" : "notIsolated")) {
    throw new Error("This endpoint already has the requested isolation state. Refresh the endpoint list and prepare the change again.");
  }
  if ((endpoint.isolationStatus !== "isolated" && endpoint.isolationStatus !== "notIsolated") || endpoint.isolationStatus !== before) {
    throw new Error("This endpoint's isolation status changed since the plan was prepared. Prepare the change again.");
  }
}

const endpointErrors = new Map([
  ["notFound", "Sophos Central could not find this endpoint. Refresh the endpoint list and prepare the change again."],
  ["notSupported", "This endpoint does not support the requested change. Check its capabilities in Sophos Central."],
  ["conflict", "The endpoint has a conflicting request. Check its status in Sophos Central before preparing another change."],
  ["permissionDenied", "Sophos Central refused the change. Use a credential with the Service Principal Management role."],
  ["internalError", "Sophos Central could not process the endpoint request. Check its status in Sophos Central before trying again."],
]);

export function verifySophosAcceptance(result: Record<string, unknown>, kind: PrepareSophosChangeInput["kind"], id: string) {
  const failure = Array.isArray(result.errors) ? result.errors.find((entry) => isSophosId(entry?.id) && entry.id.toLowerCase() === id.toLowerCase()) : undefined;
  const message = endpointErrors.get(failure?.errorCode);
  if (message) throw new SophosApiError(failure.errorCode === "permissionDenied" ? "forbidden" : "refused", message);
  const item = Array.isArray(result.items)
    ? result.items.find((entry) => isSophosId(entry?.id) && entry.id.toLowerCase() === id.toLowerCase())
    : undefined;
  if (!failure && item && (kind === "scan" ? item.status === "requested" : item.isolation?.enabled === (kind === "isolate"))) return;
  const operation = kind === "scan" ? "scan" : kind === "isolate" ? "isolation" : "release from isolation";
  throw new Error(`Sophos Central did not accept the ${operation} request. Check the endpoint in Sophos Central before trying again.`);
}
