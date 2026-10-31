import type {
  GraphOperation,
  WriteAction,
  WritePlan,
  WritePlanRiskAssessment,
  WritePlanRiskContext,
  WritePlanRiskFlag,
} from "@openadminos/agent-sdk";

export const WRITE_PLAN_SIZE_MEDIAN_MULTIPLE = 3;

/** Deterministic review hints only. This does not authorize or execute requests. */
export function assessWritePlan(
  plan: WritePlan,
  context: WritePlanRiskContext = {},
): WritePlanRiskFlag[] {
  const flags = new Map<string, WritePlanRiskFlag>();
  const flag = (
    id: string,
    severity: WritePlanRiskFlag["severity"],
    title: string,
    explanation: string,
    action: WriteAction,
  ) => {
    const existing = flags.get(id);
    if (existing) {
      if (!existing.actionIds.includes(action.id)) existing.actionIds.push(action.id);
    } else {
      flags.set(id, { id, severity, title, explanation, actionIds: [action.id] });
    }
  };

  for (const action of plan.actions) {
    const request = action.request;
    const path = request ? normalizedPath(request.path) : "";
    if (request) {
      const { method, body } = request;
      if (
        (method === "POST" && path === "/identity/conditionalAccess/policies") ||
        (["PATCH", "DELETE"].includes(method) &&
          /^\/identity\/conditionalAccess\/policies\/[^/]+$/.test(path))
      ) {
        flag("conditional-access", "danger", "Conditional Access policy change",
          "Changing a Conditional Access policy can change sign-in access across the tenant.", action);
      }
      if (/^\/(roleManagement|directoryRoles)(\/|\(|$)/.test(path)) {
        flag("privileged-role", "danger", "Privileged role change",
          "This request can change role assignments or the controls that govern privileged access.", action);
      }
      if (method === "DELETE" && directoryObjectPath(path)) {
        flag("directory-object-deletion", "danger", "Directory object deletion",
          "Deleting a user, group, application, or service principal can remove access and disrupt dependent services.", action);
      }
      if (applicationCredentialChange(path, method, body)) {
        flag("application-credentials", "danger", "Application credential change",
          "Changing application credentials can grant or revoke access for workloads using this identity.", action);
      }
      if (method !== "DELETE" && assignmentChange(path) && hasBroadAssignmentTarget(body)) {
        flag("tenant-wide-assignment", "warn", "Assignment targets All users or All devices",
          "This assignment targets All users or All devices, so its impact can extend across the tenant.", action);
      }
      if (context.graphOperations !== undefined && !declaresRequest(context.graphOperations, request)) {
        flag("undeclared-request", "danger", "Request is not declared by this agent",
          "The proposed request does not match any method and path declared in the agent's Graph operations.", action);
      }
    }
    if (
      action.kind === "retire-managed-device" ||
      (request && managedDeviceDestruction(path, request.method))
    ) {
      flag("managed-device-destructive", "danger", "Destructive managed device action",
        "Wiping, retiring, deleting, or resetting a device passcode can remove data or interrupt device access.", action);
    }
  }

  const counts = (context.historicalConfirmedActionCounts ?? [])
    .filter((count) => Number.isSafeInteger(count) && count > 0)
    .sort((a, b) => a - b);
  if (counts.length > 0) {
    const middle = Math.floor(counts.length / 2);
    const median = counts.length % 2 === 1
      ? counts[middle]!
      : (counts[middle - 1]! + counts[middle]!) / 2;
    if (plan.actions.length > median * WRITE_PLAN_SIZE_MEDIAN_MULTIPLE) {
      for (const action of plan.actions) {
        flag("unusual-plan-size", "warn", "More actions than this agent usually proposes",
          `This plan has ${plan.actions.length} actions, more than ${WRITE_PLAN_SIZE_MEDIAN_MULTIPLE} times the historical confirmed-plan median of ${median} for this agent and tenant.`, action);
      }
    }
  }
  return [...flags.values()];
}

/** A failed check is recorded explicitly, never reported as an empty flag list. */
export function assessWritePlanSafely(
  plan: WritePlan,
  context: WritePlanRiskContext = {},
): WritePlanRiskAssessment {
  try {
    return { status: "complete", flags: assessWritePlan(plan, context) };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "The risk rules could not inspect this plan" };
  }
}

function normalizedPath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error("A proposed Graph request path is invalid");
  }
  try {
    return decodeURIComponent(path.split(/[?#]/, 1)[0]!).replace(/\/+$/, "");
  } catch {
    throw new Error("A proposed Graph request path contains invalid encoding");
  }
}

function directoryObjectPath(path: string): boolean {
  return /^\/(users|groups|applications|servicePrincipals)(\/[^/]+|\([^/]+\))$/.test(path);
}

function applicationCredentialChange(path: string, method: string, body: unknown): boolean {
  const identity = /^\/(applications|servicePrincipals)(\/[^/]+|\([^/]+\))/.exec(path);
  if (!identity) return false;
  const suffix = path.slice(identity[0].length);
  if (method === "POST" && /^\/(addPassword|addKey|removePassword|removeKey)$/.test(suffix)) return true;
  if (/^\/federatedIdentityCredentials(\/[^/]+|\([^/]+\))?$/.test(suffix)) return true;
  return suffix === "" && method === "PATCH" && isRecord(body) &&
    (Object.hasOwn(body, "passwordCredentials") || Object.hasOwn(body, "keyCredentials"));
}

function managedDeviceDestruction(path: string, method: string): boolean {
  const device = /^(?:\/deviceManagement\/(?:managedDevices|comanagedDevices)|\/users\/[^/]+\/managedDevices|\/me\/managedDevices)\/[^/]+/;
  const match = device.exec(path);
  if (!match) return false;
  const suffix = path.slice(match[0].length);
  return (method === "DELETE" && suffix === "") ||
    (method === "POST" && /^\/(wipe|retire|resetPasscode)$/.test(suffix));
}

function assignmentChange(path: string): boolean {
  return /^\/(deviceManagement|deviceAppManagement)\//.test(path) &&
    /\/(assign|assignments(?:\/[^/]+)?)$/.test(path);
}

function hasBroadAssignmentTarget(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasBroadAssignmentTarget);
  if (!isRecord(value)) return false;
  if (isRecord(value.target) &&
    typeof value.target["@odata.type"] === "string" &&
    /^#?microsoft\.graph\.(allDevicesAssignmentTarget|allLicensedUsersAssignmentTarget)$/.test(value.target["@odata.type"])) return true;
  return Object.values(value).some(hasBroadAssignmentTarget);
}

function declaresRequest(operations: readonly GraphOperation[], request: NonNullable<WriteAction["request"]>): boolean {
  // Use the broker's method and segment-placeholder semantics for declarations.
  return operations.some((operation) => {
    if (operation.method !== request.method) return false;
    const pattern = operation.path.replace(/\/$/, "").split("/");
    const actual = request.path.replace(/\/$/, "").split("/");
    return pattern.length === actual.length && pattern.every((segment, index) =>
      (/^\{.+\}$/.test(segment) || /^:.+/.test(segment)) || segment === actual[index]);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
