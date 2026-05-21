import { createHash } from "node:crypto";

import {
  ConnectorAuthError,
  ConnectorError,
  ConnectorNotConfiguredError,
  ConnectorRemoteError,
  ConnectorValidationError,
  type AgentConnectorRequirement,
  type CapabilityDescriptor,
  type CapabilityKind,
  type ConnectorAccessor,
  type ConnectorAuditEntry,
  type ConnectorBuildContext,
  type ConnectorDescriptor,
  type ConnectorFactory,
  type ConnectorInstance,
  type RunLogLevel,
  type TenantSession,
} from "@openadminos/agent-sdk";

import { teamsConnector } from "@openadminos/connector-teams";

/**
 * Static connector registry. Importing `@openadminos/connector-teams`
 * here also activates the `teams` key on `ConnectorRegistry` via the
 * declaration-merging block inside that package, so all downstream
 * consumers see the typed `ctx.connectors.teams` shape.
 */
const REGISTERED_CONNECTORS: ReadonlyMap<string, ConnectorFactory<unknown>> =
  new Map<string, ConnectorFactory<unknown>>([["teams", teamsConnector]]);

export function listRegisteredConnectors(): ConnectorDescriptor[] {
  return Array.from(REGISTERED_CONNECTORS.values()).map((f) => f.descriptor);
}

export function findConnectorFactory(
  id: string,
): ConnectorFactory<unknown> | undefined {
  return REGISTERED_CONNECTORS.get(id);
}

export interface BuiltConnector {
  id: string;
  required: boolean;
  instance: ConnectorInstance<unknown>;
}

export interface PreflightConnectorsInput {
  runId: string;
  requirements: readonly AgentConnectorRequirement[];
  tenant: TenantSession;
  configFor: (connectorId: string) => Record<string, unknown>;
  secretsFor: (connectorId: string) => ConnectorBuildContext["secrets"];
  log: (
    level: RunLogLevel,
    message: string,
    metadata?: Record<string, unknown>,
  ) => void;
}

/**
 * Resolves and builds every connector declared in the agent's manifest.
 *
 * For each requirement:
 *   1. Look up the factory in the static registry. Unknown ids fail the
 *      run with `ConnectorValidationError` (recovery: 'fatal').
 *   2. Build the connector instance via `factory.build(...)`. Errors
 *      bubble up as-is — connector implementations are expected to
 *      throw typed `ConnectorError` subclasses.
 *   3. Health-check the instance. An unhealthy required connector
 *      fails preflight; an unhealthy optional connector is reported
 *      via log + skipped (its slot in the accessor stays undefined).
 *
 * Returns the list of built connectors so the caller can `dispose()`
 * them at run end, plus the `ConnectorAccessor` object for injection
 * into the run's RunContext.
 */
export async function preflightConnectors(
  input: PreflightConnectorsInput,
): Promise<{
  accessor: ConnectorAccessor;
  built: BuiltConnector[];
}> {
  const built: BuiltConnector[] = [];
  const accessor: Record<string, ConnectorInstance<unknown>> = {};

  for (const requirement of input.requirements) {
    const factory = findConnectorFactory(requirement.id);
    if (!factory) {
      throw new ConnectorValidationError(
        `Agent declares unknown connector '${requirement.id}'. Install the matching @openadminos/connector-* package or remove the requirement.`,
        { connectorId: requirement.id },
      );
    }

    if (!satisfiesMinVersion(factory.descriptor.version, requirement.minVersion)) {
      throw new ConnectorValidationError(
        `Connector '${requirement.id}' version ${factory.descriptor.version} does not satisfy required minVersion ${requirement.minVersion}.`,
        { connectorId: requirement.id },
      );
    }

    for (const capability of requirement.capabilities) {
      const known = factory.descriptor.capabilities.find(
        (cap) => cap.id === capability.id && cap.version === capability.version,
      );
      if (!known) {
        throw new ConnectorValidationError(
          `Connector '${requirement.id}' does not provide capability '${capability.id}@${capability.version}'.`,
          { connectorId: requirement.id, capabilityId: capability.id },
        );
      }
    }

    const buildContext: ConnectorBuildContext = {
      tenant: input.tenant,
      config: input.configFor(requirement.id),
      secrets: input.secretsFor(requirement.id),
      log: input.log,
      idempotencyKeyFor: (stepId, iteration) =>
        `${input.runId}:${stepId}:${iteration}`,
    };

    let instance: ConnectorInstance<unknown>;
    try {
      instance = await factory.build(buildContext);
    } catch (error) {
      if (requirement.required) {
        throw error;
      }
      input.log("warn", `Skipping optional connector '${requirement.id}': build failed.`, {
        connectorId: requirement.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const health = await instance.healthCheck();
    if (!health.healthy) {
      if (requirement.required) {
        await instance.dispose().catch(() => undefined);
        throw new ConnectorNotConfiguredError(
          `Connector '${requirement.id}' failed its health check${
            health.message ? `: ${health.message}` : "."
          }`,
          { connectorId: requirement.id },
        );
      }
      input.log("warn", `Skipping optional connector '${requirement.id}': health check failed.`, {
        connectorId: requirement.id,
        message: health.message,
      });
      await instance.dispose().catch(() => undefined);
      continue;
    }

    built.push({ id: requirement.id, required: requirement.required, instance });
    accessor[requirement.id] = instance;
  }

  return { accessor: accessor as ConnectorAccessor, built };
}

export async function disposeBuiltConnectors(
  built: readonly BuiltConnector[],
  log: (
    level: RunLogLevel,
    message: string,
    metadata?: Record<string, unknown>,
  ) => void,
): Promise<void> {
  for (const entry of built) {
    try {
      await entry.instance.dispose();
    } catch (error) {
      log("warn", `Connector '${entry.id}' dispose failed.`, {
        connectorId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * SemVer-aware comparison that accepts an installed version when its
 * major matches and (minor, patch) is `>=` the required one. We don't
 * pull in a SemVer library for this single use site; the format is
 * always `<major>.<minor>.<patch>` produced by our own package metadata.
 */
function satisfiesMinVersion(installed: string, minVersion: string): boolean {
  const installedParts = parseSemVer(installed);
  const minParts = parseSemVer(minVersion);
  if (!installedParts || !minParts) return false;
  if (installedParts[0] !== minParts[0]) return false;
  if (installedParts[1] !== minParts[1]) return installedParts[1] > minParts[1];
  return installedParts[2] >= minParts[2];
}

function parseSemVer(value: string): [number, number, number] | undefined {
  const parts = value.split(".");
  if (parts.length !== 3) return undefined;
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  const patch = Number.parseInt(parts[2] ?? "", 10);
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  ) {
    return undefined;
  }
  return [major, minor, patch];
}

/**
 * Reusable no-op secret accessor for `graph-delegated` connectors that
 * do not need keychain credentials. External connectors get a
 * keychain-backed implementation supplied by the host.
 */
export const noSecrets: ConnectorBuildContext["secrets"] = {
  async get(_key: string): Promise<string | undefined> {
    return undefined;
  },
  async set(_key: string, _value: string): Promise<void> {
    throw new ConnectorAuthError(
      "This connector is not configured to store credentials.",
      { connectorId: "<graph-delegated>" },
    );
  },
  async remove(_key: string): Promise<void> {
    // No-op.
  },
};

export type { ConnectorAuditEntry };

// ─── Capability invocation wrapper ────────────────────────────────────────
//
// Every call to a connector capability flows through `wrapConnector`. The
// wrapper:
//   1. Resolves the capability descriptor (kind, scopes) by mapping the
//      method name (camelCase) to the descriptor's `id` (kebab-case).
//   2. Applies the confirmation gate for `notify`/`mutating`/`destructive`
//      capabilities. The caller-supplied `confirmInvocation` callback
//      decides — it returns `false` to reject (the wrapper throws a
//      `ConnectorError` with `recovery: 'fatal'`).
//   3. Injects an `idempotencyKey` arg when the underlying method accepts
//      one (we set it on every call regardless of kind so the audit log
//      can record it).
//   4. Emits a `ConnectorAuditEntry` to the supplied `onAuditEntry`
//      callback after the call resolves, success or failure.

export type ConfirmationDecision =
  | { approved: true }
  | { approved: false; reason: string };

export interface ConnectorInvocationInfo {
  connectorId: string;
  capability: CapabilityDescriptor;
  args: unknown;
  egressTarget: string;
  idempotencyKey: string;
}

export interface WrapConnectorOptions {
  runId: string;
  /**
   * Current step id at the moment the capability fires. The wrapper
   * reads it lazily (function form) because the agent's call site is
   * typically inside an `ctx.step(...)` callback and the active step
   * id can change between invocations.
   */
  currentStepId: () => string | null;
  /**
   * Called before every `notify`/`mutating`/`destructive` capability.
   * `read` capabilities skip this. Returning `{ approved: false }`
   * rejects the call.
   */
  confirmInvocation?: (info: ConnectorInvocationInfo) => Promise<ConnectorInvocationInfo extends never ? never : ConfirmationDecision>;
  /** Fired after every capability call resolves, success or failure. */
  onAuditEntry?: (entry: ConnectorAuditEntry) => void;
  /** Sequence-of-iteration counter; reset to 0 by the caller per stepId. */
  nextIteration: (stepId: string, capabilityId: string) => number;
}

export function wrapConnector(
  connectorId: string,
  instance: ConnectorInstance<unknown>,
  options: WrapConnectorOptions,
): ConnectorInstance<unknown> {
  const wrappedCapabilities = wrapCapabilitiesObject(
    connectorId,
    instance.descriptor,
    instance.capabilities,
    options,
  );
  return { ...instance, capabilities: wrappedCapabilities };
}

function wrapCapabilitiesObject(
  connectorId: string,
  descriptor: ConnectorDescriptor,
  capabilities: unknown,
  options: WrapConnectorOptions,
): unknown {
  if (capabilities === null || typeof capabilities !== "object") {
    return capabilities;
  }
  const source = capabilities as Record<string, unknown>;
  const wrapped: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value !== "function") {
      wrapped[key] = value;
      continue;
    }
    const capabilityDescriptor = lookupCapabilityDescriptor(descriptor, key);
    wrapped[key] = async (...args: unknown[]): Promise<unknown> => {
      return invokeCapability({
        connectorId,
        capabilityDescriptor,
        methodName: key,
        method: value.bind(source) as (...callArgs: unknown[]) => Promise<unknown>,
        args,
        options,
      });
    };
  }
  return wrapped;
}

interface InvokeCapabilityInput {
  connectorId: string;
  capabilityDescriptor: CapabilityDescriptor | undefined;
  methodName: string;
  method: (...args: unknown[]) => Promise<unknown>;
  args: unknown[];
  options: WrapConnectorOptions;
}

async function invokeCapability(input: InvokeCapabilityInput): Promise<unknown> {
  const stepId = input.options.currentStepId() ?? "(no-step)";
  const capabilityId =
    input.capabilityDescriptor?.id ?? camelToKebab(input.methodName);
  const capabilityVersion = input.capabilityDescriptor?.version ?? 1;
  const kind: CapabilityKind = input.capabilityDescriptor?.kind ?? "read";

  const iteration = input.options.nextIteration(stepId, capabilityId);
  const idempotencyKey = `${input.options.runId}:${stepId}:${capabilityId}:${iteration}`;

  const args = injectIdempotencyKey(input.args, idempotencyKey);
  const egressTarget = describeEgressTarget(input.connectorId, args);
  const argsDigest = digestArgs(args);

  if (kind !== "read") {
    const decision = await runConfirmation({
      info: {
        connectorId: input.connectorId,
        capability:
          input.capabilityDescriptor ??
          synthesizeDescriptor(input.methodName, kind),
        args,
        egressTarget,
        idempotencyKey,
      },
      confirmInvocation: input.options.confirmInvocation,
    });
    if (!decision.approved) {
      const error = new ConnectorRemoteError(
        `Capability '${capabilityId}@${capabilityVersion}' rejected by user: ${decision.reason}`,
        {
          connectorId: input.connectorId,
          capabilityId,
          recovery: "fatal",
        },
      );
      emitAudit(input.options, {
        runId: input.options.runId,
        stepId,
        connector: input.connectorId,
        capability: `${capabilityId}@${capabilityVersion}`,
        kind,
        idempotencyKey,
        egressTarget,
        argsDigest,
        status: "failure",
        durationMs: 0,
        errorClass: "ConnectorRemoteError",
        errorMessage: error.message,
      });
      throw error;
    }
  }

  const started = Date.now();
  try {
    const result = await input.method(...args);
    const { externalId, externalUrl } = extractExternalRefs(result);
    emitAudit(input.options, {
      runId: input.options.runId,
      stepId,
      connector: input.connectorId,
      capability: `${capabilityId}@${capabilityVersion}`,
      kind,
      idempotencyKey,
      egressTarget,
      argsDigest,
      status: "success",
      durationMs: Date.now() - started,
      ...(externalId !== undefined ? { externalId } : {}),
      ...(externalUrl !== undefined ? { externalUrl } : {}),
    });
    return result;
  } catch (error) {
    const errorClass =
      error instanceof ConnectorError ? error.constructor.name : "Error";
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    emitAudit(input.options, {
      runId: input.options.runId,
      stepId,
      connector: input.connectorId,
      capability: `${capabilityId}@${capabilityVersion}`,
      kind,
      idempotencyKey,
      egressTarget,
      argsDigest,
      status: "failure",
      durationMs: Date.now() - started,
      errorClass,
      errorMessage,
    });
    throw error;
  }
}

function emitAudit(
  options: WrapConnectorOptions,
  entry: ConnectorAuditEntry,
): void {
  if (options.onAuditEntry) {
    options.onAuditEntry(entry);
  }
}

async function runConfirmation(input: {
  info: ConnectorInvocationInfo;
  confirmInvocation?: WrapConnectorOptions["confirmInvocation"];
}): Promise<ConfirmationDecision> {
  if (!input.confirmInvocation) {
    return { approved: true };
  }
  return await input.confirmInvocation(input.info);
}

function lookupCapabilityDescriptor(
  descriptor: ConnectorDescriptor,
  methodName: string,
): CapabilityDescriptor | undefined {
  const kebab = camelToKebab(methodName);
  return descriptor.capabilities.find((cap) => cap.id === kebab);
}

function synthesizeDescriptor(
  methodName: string,
  kind: CapabilityKind,
): CapabilityDescriptor {
  return {
    id: camelToKebab(methodName),
    version: 1,
    kind,
    scopes: [],
  };
}

function camelToKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function injectIdempotencyKey(args: unknown[], key: string): unknown[] {
  if (args.length === 0) return args;
  const first = args[0];
  if (
    first !== null &&
    typeof first === "object" &&
    !Array.isArray(first) &&
    !("idempotencyKey" in (first as Record<string, unknown>))
  ) {
    return [{ ...(first as Record<string, unknown>), idempotencyKey: key }, ...args.slice(1)];
  }
  return args;
}

function describeEgressTarget(connectorId: string, args: unknown[]): string {
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const obj = first as Record<string, unknown>;
    const teamId = typeof obj.teamId === "string" ? obj.teamId : undefined;
    const channelId =
      typeof obj.channelId === "string" ? obj.channelId : undefined;
    const chatId = typeof obj.chatId === "string" ? obj.chatId : undefined;
    if (teamId && channelId) {
      return `${connectorId}:team=${teamId};channel=${channelId}`;
    }
    if (chatId) {
      return `${connectorId}:chat=${chatId}`;
    }
  }
  return connectorId;
}

function digestArgs(args: unknown[]): string {
  try {
    const serialized = JSON.stringify(args, (_key, value) => {
      if (typeof value === "string" && value.length > 256) {
        return `${value.slice(0, 256)}…`;
      }
      return value;
    });
    return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
  } catch {
    return "unhashable";
  }
}

function extractExternalRefs(result: unknown): {
  externalId?: string;
  externalUrl?: string;
} {
  if (result === null || typeof result !== "object") return {};
  const obj = result as Record<string, unknown>;
  const externalId =
    typeof obj.messageId === "string"
      ? obj.messageId
      : typeof obj.id === "string"
        ? obj.id
        : undefined;
  const externalUrl =
    typeof obj.webUrl === "string"
      ? obj.webUrl
      : typeof obj.url === "string"
        ? obj.url
        : undefined;
  return {
    ...(externalId !== undefined ? { externalId } : {}),
    ...(externalUrl !== undefined ? { externalUrl } : {}),
  };
}
