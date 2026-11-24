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
  const query = new URLSearchParams({ pageSize: "50" });
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
  const query = new URLSearchParams({ ids: ids.join(","), pageSize: "50" });
  const endpoints = new Map(targets((await api.read(identity, "endpoints", query)).items).map((target) => [target.id.toLowerCase(), target]));
  const verb = kind === "isolate" ? "Isolate" : kind === "release" ? "Release" : "Scan";
  return {
    summary: `${verb} ${ids.length} Sophos Central ${ids.length === 1 ? "endpoint" : "endpoints"}.`,
    confirmationPhrase: `${verb.toUpperCase()} ${ids.length} ${ids.length === 1 ? "DEVICE" : "DEVICES"}`,
    actions: ids.map((id) => {
      const endpoint = endpoints.get(id);
      if (!endpoint) throw new Error(`Sophos Central no longer returned endpoint ${id}. Refresh the endpoint list and try again.`);
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
