import type {
  GraphCacheResourceKind,
  WriteAction,
} from "@openadminos/agent-sdk";

import type { DriftBaselineChangeRecord } from "../sqlite-store.js";

/**
 * Deterministic rollback plan building: baseline drift changes become
 * standard write actions that flow through the existing typed
 * confirmation gate. No LLM is involved anywhere in this module.
 *
 * Every generated action is validated against the bundled Graph
 * endpoint catalog by the caller-supplied resolver; anything the
 * catalog does not document becomes a manual item with a reason,
 * never a guessed request.
 */

export interface RollbackEndpointResolver {
  (method: string, path: string): { scopesDelegated: string[] } | null;
}

export interface RollbackManualItem {
  resource: GraphCacheResourceKind;
  resourceLabel: string;
  graphId: string;
  displayName?: string;
  reason: string;
}

export interface RollbackPlanDraft {
  summary: string;
  confirmationPhrase: string;
  actions: WriteAction[];
  requiredScopes: string[];
  manual: RollbackManualItem[];
}

interface RollbackWriteSpec {
  /** Collection base path; item paths append `/{graphId}`. */
  basePath: string;
  /** Singletons PATCH the base path itself and never create or delete. */
  singleton?: boolean;
  canUpdate: boolean;
  canCreate: boolean;
  canDelete: boolean;
  /** Set for resources that are deliberately report-only. */
  reportOnlyReason?: string;
}

const CREDENTIAL_REASON =
  "Credential material cannot be restored through Graph. Review this object manually.";

const ROLLBACK_WRITE_SPECS: Partial<
  Record<GraphCacheResourceKind, RollbackWriteSpec>
> = {
  deviceCompliancePolicies: {
    basePath: "/deviceManagement/deviceCompliancePolicies",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  deviceConfigurations: {
    basePath: "/deviceManagement/deviceConfigurations",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  configurationPolicies: {
    basePath: "/deviceManagement/configurationPolicies",
    // Settings catalog PATCH covers name/description; replacing the
    // settings payload is not documented in the bundled catalog, so
    // setting-level rollback downgrades to manual via validation.
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  conditionalAccessPolicies: {
    basePath: "/identity/conditionalAccess/policies",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  namedLocations: {
    basePath: "/identity/conditionalAccess/namedLocations",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  authenticationMethodsPolicy: {
    basePath: "/policies/authenticationMethodsPolicy",
    singleton: true,
    canUpdate: true,
    canCreate: false,
    canDelete: false,
  },
  authorizationPolicy: {
    basePath: "/policies/authorizationPolicy",
    singleton: true,
    canUpdate: true,
    canCreate: false,
    canDelete: false,
  },
  crossTenantAccessPolicy: {
    basePath: "/policies/crossTenantAccessPolicy",
    singleton: true,
    canUpdate: true,
    canCreate: false,
    canDelete: false,
  },
  administrativeUnits: {
    basePath: "/administrativeUnits",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  mobileApps: {
    basePath: "/deviceAppManagement/mobileApps",
    canUpdate: true,
    // App content (installer packages) cannot be recreated from cached
    // metadata.
    canCreate: false,
    canDelete: true,
  },
  managedAppPolicies: {
    basePath: "/deviceAppManagement/managedAppPolicies",
    canUpdate: true,
    canCreate: false,
    canDelete: false,
  },
  iosManagedAppProtections: {
    basePath: "/deviceAppManagement/iosManagedAppProtections",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  androidManagedAppProtections: {
    basePath: "/deviceAppManagement/androidManagedAppProtections",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  mobileAppConfigurations: {
    basePath: "/deviceAppManagement/mobileAppConfigurations",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  deviceHealthScripts: {
    basePath: "/deviceManagement/deviceHealthScripts",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  deviceManagementScripts: {
    basePath: "/deviceManagement/deviceManagementScripts",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  windowsAutopilotProfiles: {
    basePath: "/deviceManagement/windowsAutopilotDeploymentProfiles",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  deviceEnrollmentConfigurations: {
    basePath: "/deviceManagement/deviceEnrollmentConfigurations",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  windowsQualityUpdateProfiles: {
    basePath: "/deviceManagement/windowsQualityUpdateProfiles",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  windowsFeatureUpdateProfiles: {
    basePath: "/deviceManagement/windowsFeatureUpdateProfiles",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  endpointSecurityIntents: {
    basePath: "/deviceManagement/intents",
    // Intent settings roll back through a dedicated action Graph API,
    // not a document PATCH; deletion of drifted additions is safe.
    canUpdate: false,
    canCreate: false,
    canDelete: true,
  },
  groupPolicyConfigurations: {
    basePath: "/deviceManagement/groupPolicyConfigurations",
    // Definition values live in child collections; document-level
    // rollback would silently miss them.
    canUpdate: false,
    canCreate: false,
    canDelete: true,
  },
  assignmentFilters: {
    basePath: "/deviceManagement/assignmentFilters",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  roleScopeTags: {
    basePath: "/deviceManagement/roleScopeTags",
    canUpdate: true,
    canCreate: true,
    canDelete: true,
  },
  directoryRoles: {
    basePath: "/directoryRoles",
    canUpdate: false,
    canCreate: false,
    canDelete: false,
    reportOnlyReason:
      "Directory roles are not writable objects. Review role membership in Entra directly.",
  },
  applications: {
    basePath: "/applications",
    canUpdate: false,
    canCreate: false,
    canDelete: false,
    reportOnlyReason: CREDENTIAL_REASON,
  },
  servicePrincipals: {
    basePath: "/servicePrincipals",
    canUpdate: false,
    canCreate: false,
    canDelete: false,
    reportOnlyReason: CREDENTIAL_REASON,
  },
  domains: {
    basePath: "/domains",
    canUpdate: false,
    canCreate: false,
    canDelete: false,
    reportOnlyReason:
      "Domain and federation configuration is high-impact. Review it in Entra directly.",
  },
};

// Read-only and tenant-managed fields never belong in a write body.
const BODY_FIELDS_STRIPPED = new Set([
  "id",
  "createdDateTime",
  "lastModifiedDateTime",
  "modifiedDateTime",
  "version",
  "@odata.context",
  "@odata.etag",
  "supportsScopeTags",
]);

export function buildRollbackPlan(input: {
  changes: readonly DriftBaselineChangeRecord[];
  labelForResource(resource: GraphCacheResourceKind): string;
  resolveEndpoint: RollbackEndpointResolver;
  /** Optional subset; when set, only these (resource, graphId) pairs roll back. */
  selections?: ReadonlyArray<{ resource: GraphCacheResourceKind; graphId: string }>;
}): RollbackPlanDraft {
  const selected = input.selections
    ? new Set(input.selections.map((entry) => `${entry.resource} ${entry.graphId}`))
    : undefined;
  const actions: WriteAction[] = [];
  const manual: RollbackManualItem[] = [];
  const requiredScopes = new Set<string>();

  for (const change of input.changes) {
    if (selected && !selected.has(`${change.resource} ${change.graphId}`)) continue;
    const resourceLabel = input.labelForResource(change.resource);
    const spec = ROLLBACK_WRITE_SPECS[change.resource];
    const pushManual = (reason: string) =>
      manual.push({
        resource: change.resource,
        resourceLabel,
        graphId: change.graphId,
        ...(change.displayName ? { displayName: change.displayName } : {}),
        reason,
      });

    if (!spec) {
      pushManual("This resource has no rollback mapping.");
      continue;
    }
    if (spec.reportOnlyReason) {
      pushManual(spec.reportOnlyReason);
      continue;
    }

    const displayName = change.displayName ?? change.graphId;
    const itemPath = spec.singleton
      ? spec.basePath
      : `${spec.basePath}/${change.graphId}`;

    if (change.kind === "modified") {
      if (!spec.canUpdate) {
        pushManual("This resource cannot be updated in place through Graph.");
        continue;
      }
      const body = sanitizedBody(change.pinnedRawJson);
      if (body === undefined) {
        pushManual("The baseline copy of this object is unavailable.");
        continue;
      }
      const endpoint = input.resolveEndpoint("PATCH", itemPath);
      if (!endpoint) {
        pushManual(
          "Graph does not document a supported update for this object. Apply the baseline values manually.",
        );
        continue;
      }
      collectWriteScopes(endpoint.scopesDelegated, requiredScopes);
      actions.push({
        id: `rollback-${change.resource}-${change.graphId}-modify`,
        kind: "graph-write",
        label: `Restore baseline values for ${displayName}`,
        description: `${resourceLabel}: PATCH the pinned baseline configuration back onto this object.`,
        severity: "default",
        request: { method: "PATCH", path: itemPath, body },
      });
      continue;
    }

    if (change.kind === "added") {
      if (!spec.canDelete || spec.singleton) {
        pushManual("This object cannot be deleted through Graph. Remove it manually.");
        continue;
      }
      const endpoint = input.resolveEndpoint("DELETE", itemPath);
      if (!endpoint) {
        pushManual(
          "Graph does not document a supported delete for this object. Remove it manually.",
        );
        continue;
      }
      collectWriteScopes(endpoint.scopesDelegated, requiredScopes);
      actions.push({
        id: `rollback-${change.resource}-${change.graphId}-delete`,
        kind: "graph-write",
        label: `Delete ${displayName}`,
        description: `${resourceLabel}: this object does not exist in the baseline and will be deleted.`,
        severity: "destructive",
        request: { method: "DELETE", path: itemPath },
      });
      continue;
    }

    // removed: recreate from the pinned baseline copy.
    if (!spec.canCreate || spec.singleton) {
      pushManual(
        "This object cannot be recreated through Graph. The baseline copy is available in the drift detail.",
      );
      continue;
    }
    const body = sanitizedBody(change.pinnedRawJson);
    if (body === undefined) {
      pushManual("The baseline copy of this object is unavailable.");
      continue;
    }
    const endpoint = input.resolveEndpoint("POST", spec.basePath);
    if (!endpoint) {
      pushManual(
        "Graph does not document a supported create for this object. Recreate it manually from the baseline copy.",
      );
      continue;
    }
    collectWriteScopes(endpoint.scopesDelegated, requiredScopes);
    actions.push({
      id: `rollback-${change.resource}-${change.graphId}-create`,
      kind: "graph-write",
      label: `Recreate ${displayName}`,
      description: `${resourceLabel}: recreate this object from its pinned baseline copy. The recreated object gets a new Graph id.`,
      severity: "default",
      request: { method: "POST", path: spec.basePath, body },
    });
  }

  const objectCount = actions.length;
  const noun = objectCount === 1 ? "OBJECT" : "OBJECTS";
  return {
    summary: buildSummary(objectCount, manual.length),
    confirmationPhrase: `ROLLBACK ${objectCount} ${noun}`,
    actions,
    requiredScopes: [...requiredScopes].sort(),
    manual,
  };
}

function buildSummary(actionCount: number, manualCount: number): string {
  const parts: string[] = [];
  parts.push(
    actionCount === 1
      ? "1 object will be rolled back to its baseline state."
      : `${actionCount} objects will be rolled back to their baseline state.`,
  );
  if (manualCount > 0) {
    parts.push(
      manualCount === 1
        ? "1 change needs manual review and is not part of this plan."
        : `${manualCount} changes need manual review and are not part of this plan.`,
    );
  }
  return parts.join(" ");
}

function collectWriteScopes(scopes: readonly string[], out: Set<string>): void {
  for (const scope of scopes) {
    if (/ReadWrite|Write/.test(scope)) out.add(scope);
  }
}

function sanitizedBody(rawJson: string | undefined): Record<string, unknown> | undefined {
  if (rawJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (BODY_FIELDS_STRIPPED.has(key)) continue;
    body[key] = value;
  }
  return body;
}
