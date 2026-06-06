import type {
  AgentConnectorRequirement,
  AgentMode,
  GraphOperation,
  GraphRequestInput,
  LlmOptions,
  RunContext,
  SandboxBrokerRequest,
  SandboxBrokerResponse,
  WriteHttpMethod,
  WritePlan,
} from "@openadminos/agent-sdk";

export interface SandboxBrokerAgentPolicy {
  slug: string;
  mode: AgentMode;
  scopes?: string[];
  graphOperations?: GraphOperation[];
  connectors?: AgentConnectorRequirement[];
}

export interface SandboxBroker {
  handle(request: SandboxBrokerRequest): Promise<SandboxBrokerResponse>;
  getWritePlan(): WritePlan | undefined;
}

export interface SandboxBrokerInput {
  agent: SandboxBrokerAgentPolicy;
  ctx: RunContext;
}

type BrokerErrorCode =
  | "invalid_request"
  | "policy_denied"
  | "not_available"
  | "host_error";

class SandboxBrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly detail?: unknown;

  constructor(message: string, code: BrokerErrorCode, detail?: unknown) {
    super(message);
    this.name = "SandboxBrokerError";
    this.code = code;
    this.detail = detail;
  }
}

export function createSandboxBroker(input: SandboxBrokerInput): SandboxBroker {
  let writePlan: WritePlan | undefined;

  return {
    async handle(request) {
      const id = typeof request?.id === "string" && request.id.length > 0
        ? request.id
        : "unknown";
      try {
        assertBaseRequest(request);
        switch (request.method) {
          case "graph.request":
            return ok(id, await handleGraphRequest(input, request.params));
          case "llm.complete":
            return ok(id, await handleLlmRequest(input, request.params));
          case "connector.invoke":
            return ok(id, await handleConnectorRequest(input, request.params));
          case "write.plan":
            writePlan = handleWritePlanRequest(input, request.params);
            return ok(id, writePlan);
          case "log":
            input.ctx.log(
              request.params.level,
              request.params.message,
              request.params.metadata,
            );
            return ok(id);
          default:
            throw new SandboxBrokerError(
              `Unsupported sandbox broker method "${String((request as { method?: unknown }).method)}".`,
              "invalid_request",
            );
        }
      } catch (error) {
        return failure(id, error);
      }
    },
    getWritePlan: () => writePlan,
  };
}

async function handleGraphRequest(
  input: SandboxBrokerInput,
  params: GraphRequestInput,
): Promise<unknown> {
  const request = normalizeGraphRequest(params);
  if (request.method !== "GET") {
    throw new SandboxBrokerError(
      "Sandboxed code cannot call Graph write methods directly. Return a write.plan request instead.",
      "policy_denied",
      { method: request.method, path: request.path },
    );
  }
  if (!input.agent.scopes || input.agent.scopes.length === 0) {
    throw new SandboxBrokerError(
      `Agent "${input.agent.slug}" does not declare Graph scopes for sandboxed Graph access.`,
      "policy_denied",
    );
  }

  const operation = findDeclaredGraphOperation(
    input.agent.graphOperations ?? [],
    request,
  );
  if (!operation) {
    throw new SandboxBrokerError(
      `Graph request ${request.method} ${request.path} is not declared by agent "${input.agent.slug}".`,
      "policy_denied",
      { method: request.method, path: request.path },
    );
  }
  validateSelectSubset(operation, request);
  return await input.ctx.graph.request(request);
}

async function handleLlmRequest(
  input: SandboxBrokerInput,
  params: Omit<LlmOptions, "signal">,
): Promise<unknown> {
  if (!input.ctx.llm.available) {
    throw new SandboxBrokerError(
      "The active LLM provider is not available.",
      "not_available",
    );
  }
  if (!params || typeof params.prompt !== "string" || params.prompt.length === 0) {
    throw new SandboxBrokerError(
      "llm.complete requires a non-empty prompt.",
      "invalid_request",
    );
  }

  const activeModel = input.ctx.model ?? input.ctx.llm.defaultModel;
  if (params.model && activeModel && params.model !== activeModel) {
    throw new SandboxBrokerError(
      "Sandboxed code cannot change the active LLM model.",
      "policy_denied",
      { requestedModel: params.model, activeModel },
    );
  }

  const options: LlmOptions = {
    prompt: params.prompt,
    ...(typeof params.system === "string" ? { system: params.system } : {}),
    ...(activeModel
      ? { model: activeModel }
      : typeof params.model === "string"
        ? { model: params.model }
        : {}),
    ...(typeof params.temperature === "number"
      ? { temperature: params.temperature }
      : {}),
    ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
  };
  return await input.ctx.llm.complete(options);
}

async function handleConnectorRequest(
  input: SandboxBrokerInput,
  params: {
    connector: string;
    capability: string;
    args: Record<string, unknown>;
  },
): Promise<unknown> {
  if (!isRecord(params)) {
    throw new SandboxBrokerError(
      "connector.invoke params must be an object.",
      "invalid_request",
    );
  }
  const connectorId = readNonEmptyString(params.connector, "connector");
  const capabilityId = readNonEmptyString(params.capability, "capability");
  const args = isRecord(params.args) ? params.args : undefined;
  if (!args) {
    throw new SandboxBrokerError(
      "connector.invoke args must be an object.",
      "invalid_request",
    );
  }

  const requirement = input.agent.connectors?.find(
    (entry) => entry.id === connectorId,
  );
  if (!requirement) {
    throw new SandboxBrokerError(
      `Connector "${connectorId}" is not declared by agent "${input.agent.slug}".`,
      "policy_denied",
    );
  }
  if (
    !requirement.capabilities.some((capability) => capability.id === capabilityId)
  ) {
    throw new SandboxBrokerError(
      `Connector capability "${connectorId}.${capabilityId}" is not declared by agent "${input.agent.slug}".`,
      "policy_denied",
    );
  }

  const connector = (input.ctx.connectors as Record<string, unknown> | undefined)?.[
    connectorId
  ] as { capabilities?: Record<string, unknown> } | undefined;
  if (!connector) {
    throw new SandboxBrokerError(
      `Connector "${connectorId}" is not available for this run.`,
      requirement.required ? "not_available" : "policy_denied",
    );
  }

  const methodName = kebabToCamel(capabilityId);
  const method = connector.capabilities?.[methodName];
  if (typeof method !== "function") {
    throw new SandboxBrokerError(
      `Connector "${connectorId}" does not expose capability "${capabilityId}".`,
      "policy_denied",
    );
  }
  return await method(args);
}

function handleWritePlanRequest(
  input: SandboxBrokerInput,
  params: WritePlan,
): WritePlan {
  if (input.agent.mode !== "write") {
    throw new SandboxBrokerError(
      `Read agent "${input.agent.slug}" cannot return a write plan.`,
      "policy_denied",
    );
  }
  validateWritePlan(params, input.agent);
  return params;
}

function normalizeGraphRequest(input: GraphRequestInput): GraphRequestInput {
  if (!isRecord(input)) {
    throw new SandboxBrokerError(
      "graph.request params must be an object.",
      "invalid_request",
    );
  }
  const method = input.method;
  if (
    method !== "GET" &&
    method !== "POST" &&
    method !== "PATCH" &&
    method !== "PUT" &&
    method !== "DELETE"
  ) {
    throw new SandboxBrokerError(
      `Unsupported Graph method "${String(method)}".`,
      "invalid_request",
    );
  }
  const path = readNonEmptyString(input.path, "path");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new SandboxBrokerError(
      "Graph path must be a relative Microsoft Graph path starting with one slash.",
      "invalid_request",
      { path },
    );
  }
  if (path.includes("?") || path.includes("#")) {
    throw new SandboxBrokerError(
      "Graph query and fragment values must be supplied through the query field, not embedded in path.",
      "invalid_request",
      { path },
    );
  }
  if (method === "GET" && input.body !== undefined) {
    throw new SandboxBrokerError(
      "Graph GET requests from sandboxed code cannot include a body.",
      "invalid_request",
    );
  }

  return {
    method,
    path,
    ...(input.query ? { query: normalizeStringRecord(input.query, "query") } : {}),
    ...(input.headers
      ? { headers: normalizeGraphHeaders(input.headers) }
      : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
  };
}

function normalizeStringRecord(
  value: unknown,
  label: string,
): Record<string, string> {
  if (!isRecord(value)) {
    throw new SandboxBrokerError(`${label} must be an object.`, "invalid_request");
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new SandboxBrokerError(
        `${label}.${key} must be a string.`,
        "invalid_request",
      );
    }
    result[key] = entry;
  }
  return result;
}

function normalizeGraphHeaders(value: unknown): Record<string, string> {
  const input = normalizeStringRecord(value, "headers");
  const allowed = new Set(["consistencylevel", "prefer"]);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!allowed.has(key.toLowerCase())) {
      throw new SandboxBrokerError(
        `Graph header "${key}" is not allowed for sandboxed code.`,
        "policy_denied",
      );
    }
    result[key] = entry;
  }
  return result;
}

function findDeclaredGraphOperation(
  operations: readonly GraphOperation[],
  request: GraphRequestInput,
): GraphOperation | undefined {
  return operations.find(
    (operation) =>
      operation.method === request.method &&
      graphPathMatches(operation.path, request.path),
  );
}

function graphPathMatches(pattern: string, path: string): boolean {
  const normalizedPattern = trimTrailingSlash(pattern);
  const normalizedPath = trimTrailingSlash(path);
  if (normalizedPattern === normalizedPath) return true;

  const patternSegments = normalizedPattern.split("/");
  const pathSegments = normalizedPath.split("/");
  if (patternSegments.length !== pathSegments.length) return false;

  return patternSegments.every((segment, index) => {
    const actual = pathSegments[index];
    return isPathParam(segment) || segment === actual;
  });
}

function trimTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

function isPathParam(segment: string): boolean {
  return (
    (segment.startsWith("{") && segment.endsWith("}") && segment.length > 2) ||
    (segment.startsWith(":") && segment.length > 1)
  );
}

function validateSelectSubset(
  operation: GraphOperation,
  request: GraphRequestInput,
): void {
  if (!operation.select || operation.select.length === 0) return;
  const requestedSelect = request.query?.$select;
  if (!requestedSelect) {
    throw new SandboxBrokerError(
      `Graph request ${request.method} ${request.path} must include the manifest-declared $select subset.`,
      "policy_denied",
      { allowedSelect: operation.select },
    );
  }

  const allowed = new Set(operation.select.map((value) => value.toLowerCase()));
  const requested = requestedSelect
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const field of requested) {
    if (!allowed.has(field.toLowerCase())) {
      throw new SandboxBrokerError(
        `Graph field "${field}" is not declared for ${request.path}.`,
        "policy_denied",
        { allowedSelect: operation.select },
      );
    }
  }
}

function validateWritePlan(
  plan: WritePlan,
  agent: SandboxBrokerAgentPolicy,
): void {
  if (!isRecord(plan)) {
    throw new SandboxBrokerError(
      "write.plan params must be an object.",
      "invalid_request",
    );
  }
  if (typeof plan.summary !== "string" || plan.summary.length === 0) {
    throw new SandboxBrokerError(
      `Agent "${agent.slug}" returned a plan without a summary.`,
      "invalid_request",
    );
  }
  if (
    typeof plan.confirmationPhrase !== "string" ||
    plan.confirmationPhrase.length === 0
  ) {
    throw new SandboxBrokerError(
      `Agent "${agent.slug}" returned a plan without a confirmation phrase.`,
      "invalid_request",
    );
  }
  if (!Array.isArray(plan.actions)) {
    throw new SandboxBrokerError(
      `Agent "${agent.slug}" returned a plan without an actions array.`,
      "invalid_request",
    );
  }

  for (const action of plan.actions) {
    if (
      !isRecord(action) ||
      typeof action.id !== "string" ||
      typeof action.kind !== "string" ||
      typeof action.label !== "string"
    ) {
      throw new SandboxBrokerError(
        `Agent "${agent.slug}" returned an action missing id/kind/label.`,
        "invalid_request",
      );
    }
    const request = action.request;
    if (request === undefined) continue;
    validateWriteActionRequest(request, agent);
  }
}

function validateWriteActionRequest(
  request: unknown,
  agent: SandboxBrokerAgentPolicy,
): void {
  if (!isRecord(request)) {
    throw new SandboxBrokerError(
      "write action request must be an object.",
      "invalid_request",
    );
  }
  const method = request.method as WriteHttpMethod;
  if (
    method !== "POST" &&
    method !== "PATCH" &&
    method !== "PUT" &&
    method !== "DELETE"
  ) {
    throw new SandboxBrokerError(
      "write action requests must use POST, PATCH, PUT, or DELETE.",
      "invalid_request",
      { method: request.method },
    );
  }
  const path = readNonEmptyString(request.path, "request.path");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new SandboxBrokerError(
      "Write action Graph path must be a relative Microsoft Graph path starting with one slash.",
      "invalid_request",
      { path },
    );
  }
  if (!agent.scopes || agent.scopes.length === 0) {
    throw new SandboxBrokerError(
      `Agent "${agent.slug}" does not declare Graph scopes for write actions.`,
      "policy_denied",
    );
  }
  const operation = findDeclaredGraphOperation(agent.graphOperations ?? [], {
    method,
    path,
  });
  if (!operation) {
    throw new SandboxBrokerError(
      `Write request ${method} ${path} is not declared by agent "${agent.slug}".`,
      "policy_denied",
    );
  }
}

function assertBaseRequest(request: SandboxBrokerRequest): void {
  if (!isRecord(request)) {
    throw new SandboxBrokerError(
      "Sandbox broker request must be an object.",
      "invalid_request",
    );
  }
  readNonEmptyString(request.id, "id");
  readNonEmptyString(request.method, "method");
  if (!isRecord(request.params)) {
    throw new SandboxBrokerError(
      "Sandbox broker request params must be an object.",
      "invalid_request",
    );
  }
}

function ok(id: string, result?: unknown): SandboxBrokerResponse {
  return result === undefined ? { id, ok: true } : { id, ok: true, result };
}

function failure(id: string, error: unknown): SandboxBrokerResponse {
  if (error instanceof SandboxBrokerError) {
    return {
      id,
      ok: false,
      error: {
        message: error.message,
        code: error.code,
        ...(error.detail !== undefined ? { detail: error.detail } : {}),
      },
    };
  }
  return {
    id,
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: "host_error",
    },
  };
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SandboxBrokerError(
      `${label} must be a non-empty string.`,
      "invalid_request",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function kebabToCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_match, ch: string) => ch.toUpperCase());
}
