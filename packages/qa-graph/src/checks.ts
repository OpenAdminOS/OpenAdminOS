import type { GraphOperation } from "@openagents/agent-sdk";

import type { AgentManifest } from "./load-agents.js";
import type { MsgraphClient } from "./msgraph-client.js";
import { parseProperties, primitiveKind } from "./properties.js";

export type Severity = "pass" | "warn" | "fail";

export interface CheckResult {
  name: string;
  severity: Severity;
  message: string;
  details?: string[];
}

export async function runAgentChecks(
  agent: AgentManifest,
  client: MsgraphClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(...(await checkScopesAreKnown(agent, client)));
  const opResults = await checkOperationsExist(agent, client);
  results.push(...opResults.results);
  results.push(...(await checkScopeCoverage(agent, opResults.endpointDocs)));
  results.push(...(await checkSelectProperties(agent, opResults.endpointDocs, client)));
  results.push(...(await checkSampleBacking(agent, client)));

  return results;
}

async function checkScopesAreKnown(
  agent: AgentManifest,
  client: MsgraphClient,
): Promise<CheckResult[]> {
  if (agent.scopes.length === 0) {
    return [
      {
        name: "scopes-declared",
        severity: "warn",
        message: "Agent declares no scopes.",
      },
    ];
  }

  const failures: string[] = [];
  for (const scope of agent.scopes) {
    const known = await client.scopeIsKnown(scope);
    if (!known) {
      failures.push(scope);
    }
  }

  if (failures.length === 0) {
    return [
      {
        name: "scopes-known",
        severity: "pass",
        message: `All ${agent.scopes.length} scopes recognized by Graph.`,
      },
    ];
  }

  return [
    {
      name: "scopes-known",
      severity: "fail",
      message: `Scope(s) not known to Graph: ${failures.join(", ")}.`,
      details: failures,
    },
  ];
}

interface OperationCheckResult {
  results: CheckResult[];
  endpointDocs: Map<string, EndpointDocLite | undefined>;
}

export interface EndpointDocLite {
  path: string;
  method: string;
  permissions?: {
    application?: string[];
    delegatedWork?: string[];
    delegatedPersonal?: string[];
  };
}

async function checkOperationsExist(
  agent: AgentManifest,
  client: MsgraphClient,
): Promise<OperationCheckResult> {
  if (agent.graphOperations.length === 0) {
    return {
      results: [
        {
          name: "operations-declared",
          severity: "fail",
          message: "Agent declares no graphOperations. Every agent must declare at least one.",
        },
      ],
      endpointDocs: new Map(),
    };
  }

  const results: CheckResult[] = [];
  const endpointDocs = new Map<string, EndpointDocLite | undefined>();

  for (const op of agent.graphOperations) {
    const key = `${op.method} ${op.path}`;
    const resolved = await client.resolveOperation(op.path, op.method);
    if (!resolved.doc && !resolved.openapi) {
      results.push({
        name: "operation-exists",
        severity: "fail",
        message: `${key} not found in Graph OpenAPI index.`,
      });
      endpointDocs.set(key, undefined);
      continue;
    }

    if (resolved.doc) {
      endpointDocs.set(key, {
        path: resolved.doc.path,
        method: resolved.doc.method,
        ...(resolved.doc.permissions ? { permissions: resolved.doc.permissions } : {}),
      });
      results.push({
        name: "operation-exists",
        severity: "pass",
        message: `${key} resolved (documented endpoint).`,
      });
    } else {
      endpointDocs.set(key, undefined);
      results.push({
        name: "operation-exists",
        severity: "warn",
        message: `${key} exists in OpenAPI but has no detailed permissions doc.`,
      });
    }
  }

  return { results, endpointDocs };
}

async function checkScopeCoverage(
  agent: AgentManifest,
  endpointDocs: Map<string, EndpointDocLite | undefined>,
): Promise<CheckResult[]> {
  const requiredCandidates: { op: string; scopes: string[] }[] = [];
  for (const op of agent.graphOperations) {
    const key = `${op.method} ${op.path}`;
    const doc = endpointDocs.get(key);
    if (!doc?.permissions) continue;
    const scopes = [
      ...(doc.permissions.application ?? []),
      ...(doc.permissions.delegatedWork ?? []),
    ];
    if (scopes.length > 0) {
      requiredCandidates.push({ op: key, scopes });
    }
  }

  if (requiredCandidates.length === 0) {
    return [
      {
        name: "scope-coverage",
        severity: "warn",
        message: "No documented permissions to cross-check declared scopes.",
      },
    ];
  }

  const declared = new Set(agent.scopes);
  const missing: string[] = [];

  for (const { op, scopes } of requiredCandidates) {
    const intersects = scopes.some((scope) => declared.has(scope));
    if (!intersects) {
      missing.push(`${op} requires one of [${scopes.join(", ")}], none declared.`);
    }
  }

  if (missing.length === 0) {
    return [
      {
        name: "scope-coverage",
        severity: "pass",
        message: "Every operation has at least one accepted scope in the manifest.",
      },
    ];
  }

  return [
    {
      name: "scope-coverage",
      severity: "fail",
      message: `Operation(s) missing a declared scope.`,
      details: missing,
    },
  ];
}

async function checkSelectProperties(
  agent: AgentManifest,
  endpointDocs: Map<string, EndpointDocLite | undefined>,
  client: MsgraphClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const op of agent.graphOperations) {
    if (!op.select || op.select.length === 0) continue;
    const resourceName = inferResourceName(op);
    if (!resourceName) {
      results.push({
        name: "select-properties",
        severity: "warn",
        message: `Cannot infer resource type for ${op.method} ${op.path}; skipped select check.`,
      });
      continue;
    }

    const resource = await client.findResource(resourceName);
    if (!resource) {
      results.push({
        name: "select-properties",
        severity: "warn",
        message: `Resource type "${resourceName}" not found; skipped select check for ${op.path}.`,
      });
      continue;
    }

    const props = new Map(
      parseProperties(resource.properties).map((property) => [property.name, property]),
    );
    const missing = op.select.filter((field) => !props.has(field));
    if (missing.length > 0) {
      results.push({
        name: "select-properties",
        severity: "fail",
        message: `select fields not on ${resourceName}: ${missing.join(", ")} (${op.method} ${op.path}).`,
        details: missing,
      });
    } else {
      results.push({
        name: "select-properties",
        severity: "pass",
        message: `All ${op.select.length} select fields exist on ${resourceName}.`,
      });
    }
  }

  return results;
}

async function checkSampleBacking(
  agent: AgentManifest,
  client: MsgraphClient,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const op of agent.graphOperations) {
    if (op.method !== "GET") continue;
    const sample = await client.sampleForPath(op.path);
    if (sample) {
      results.push({
        name: "sample-backing",
        severity: "pass",
        message: `Sample backing found: ${sample.file}.`,
      });
    } else {
      results.push({
        name: "sample-backing",
        severity: "warn",
        message: `No curated sample for ${op.method} ${op.path}.`,
      });
    }
  }
  return results;
}

function inferResourceName(op: GraphOperation): string | undefined {
  if (op.method !== "GET") return undefined;
  // Match the last path segment that names a top-level collection.
  // e.g. /deviceManagement/managedDevices -> managedDevice
  const segments = op.path
    .split("/")
    .filter((segment) => segment.length > 0 && !segment.startsWith("{") && !segment.endsWith(")"));
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  if (last.endsWith("ies")) return `${last.slice(0, -3)}y`;
  if (last.endsWith("s")) return last.slice(0, -1);
  return last;
}

export interface FixtureField {
  name: string;
  primitiveKind: string;
}

export interface FixtureSpec {
  resourceName: string;
  fixtureName: string;
  fields: FixtureField[];
}

export async function checkFixtureAgainstResource(
  fixture: FixtureSpec,
  client: MsgraphClient,
): Promise<CheckResult[]> {
  const resource = await client.findResource(fixture.resourceName);
  if (!resource) {
    return [
      {
        name: "fixture-resource",
        severity: "fail",
        message: `Resource "${fixture.resourceName}" not found in Graph schema index.`,
      },
    ];
  }

  const graphProperties = new Map(
    parseProperties(resource.properties).map((property) => [property.name, property]),
  );

  const missing: string[] = [];
  const typeMismatches: string[] = [];

  for (const field of fixture.fields) {
    const graphProp = graphProperties.get(field.name);
    if (!graphProp) {
      missing.push(field.name);
      continue;
    }
    const expected = field.primitiveKind;
    const actual = primitiveKind(graphProp.type);
    if (expected !== "complex" && actual !== "complex" && expected !== actual) {
      typeMismatches.push(`${field.name}: fixture ${expected} vs Graph ${actual}`);
    }
  }

  const results: CheckResult[] = [];

  if (missing.length === 0) {
    results.push({
      name: "fixture-fields",
      severity: "pass",
      message: `All ${fixture.fields.length} ${fixture.fixtureName} fields exist on ${fixture.resourceName}.`,
    });
  } else {
    results.push({
      name: "fixture-fields",
      severity: "fail",
      message: `${fixture.fixtureName} fields not on ${fixture.resourceName}: ${missing.join(", ")}.`,
      details: missing,
    });
  }

  if (typeMismatches.length > 0) {
    results.push({
      name: "fixture-types",
      severity: "fail",
      message: `${fixture.fixtureName} type mismatches against ${fixture.resourceName}.`,
      details: typeMismatches,
    });
  } else {
    results.push({
      name: "fixture-types",
      severity: "pass",
      message: `${fixture.fixtureName} primitive kinds align with ${fixture.resourceName}.`,
    });
  }

  return results;
}
