import { join } from "node:path";

import type { RunInitiator, RunLlmApi, RunRecord } from "@openadminos/agent-sdk";
import {
  appendSandboxEvent,
  ApplicationTokenError,
  AuditLogStore,
  createApplicationTokenProvider,
  createGraphAdapter,
  createLmStudioLlm,
  createOllamaLlm,
  createQueuedRun,
  executeRun,
  findRegistryAgentById,
  graphRequestAuditSink,
  type ApplicationToken,
  type ApplicationTokenProvider,
  type ApplicationTokenProviderOptions,
  type SandboxAuditContext,
} from "@openadminos/runtime";

import { resolveSandboxAgent, type SandboxAgent } from "./agents.js";
import { chooseCertificate } from "./certificates.js";
import type { SandboxAgentConfig, SandboxConfig } from "./config.js";
import { payloadDigest, renderFailureNotice, renderRecoveryNotice, renderSandboxReport, sendDelivery } from "./delivery.js";
import { describe, ensurePrivateDirectory } from "./files.js";
import { sandboxGraphFetch } from "./graph-fetch.js";
import { assertAgentPermissions, assertSandboxIdentity } from "./identity.js";
import { InstanceLock } from "./lock.js";
import { createLineLogger, type SandboxLogger } from "./log.js";
import { checkLocalModel, type ModelCheck } from "./model.js";
import { isSandboxRefusal, SandboxRefusal, signInRefusal, type RefusalReason } from "./refusal.js";
import { Scheduler, type SchedulerClock } from "./scheduler.js";
import { loadSandboxSecrets, type SandboxSecrets } from "./secrets.js";
import { HealthStore, RunStore } from "./store.js";

/** Seams for tests and for a future key store; production uses the defaults. */
export interface SandboxHostDeps {
  now?: () => Date;
  log?: SandboxLogger;
  /** Transport under the Graph egress wrapper. */
  graphFetch?: typeof fetch;
  /** Transport for Microsoft sign-in, pinned to the sign-in host. */
  signInFetch?: typeof fetch;
  /** Transport for the model checks. */
  modelFetch?: typeof fetch;
  /** Transport for report delivery, pinned to the destination. */
  deliveryFetch?: typeof fetch;
  createLlm?: (model: SandboxConfig["model"], check: ModelCheck) => RunLlmApi;
  createTokenProvider?: (options: ApplicationTokenProviderOptions) => ApplicationTokenProvider;
  /** Graph retry backoff; tests pass 0. */
  graphRetryBackoffMs?: number;
  schedulerClock?: SchedulerClock;
  /** The platform the host refuses or accepts; tests pass one. */
  platform?: NodeJS.Platform;
}

export type RunOutcome =
  | { kind: "completed"; run: RunRecord }
  | { kind: "failed"; reason: RefusalReason; message: string; run: RunRecord }
  | { kind: "refused"; reason: RefusalReason; message: string };

/**
 * The headless sandbox host. It runs bundled read-only agents with the
 * sandbox's own app-only identity and a model on this machine, checks
 * everything again before every run, writes every Graph request to the
 * audit log before it is sent, and keeps results in its data folder.
 */
export class SandboxHost {
  private readonly now: () => Date;
  private readonly log: SandboxLogger;
  private readonly lock: InstanceLock;
  private readonly runs: RunStore;
  private readonly health: HealthStore;
  private audit: AuditLogStore | undefined;
  private readonly inFlight = new Set<string>();
  private readonly allowedRoles: ReadonlySet<string>;
  private scheduler: Scheduler | undefined;
  private readonly stopController = new AbortController();

  constructor(private readonly config: SandboxConfig, private readonly deps: SandboxHostDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? createLineLogger();
    if ((deps.platform ?? process.platform) === "win32") {
      throw new SandboxRefusal(
        "platform-not-supported",
        "The sandbox host does not run on Windows yet: it cannot check who can read the config, the private key and the secrets file there. Run it on Linux or macOS.",
      );
    }
    ensurePrivateDirectory(config.dataDir);
    this.lock = new InstanceLock(join(config.dataDir, "sandbox.lock"));
    this.runs = new RunStore(join(config.dataDir, "runs"));
    this.health = new HealthStore(join(config.dataDir, "health.json"), config.sandbox.id);
    // Declared scopes of every configured agent, whether or not it passes
    // its own checks, so one refused agent does not refuse the others.
    this.allowedRoles = new Set(config.agents.flatMap((agent) => findRegistryAgentById(agent.id)?.scopes ?? []));
  }

  /** Takes the instance lock, opens the audit log and marks interrupted runs. */
  open(): void {
    this.lock.acquire();
    try {
      this.audit = new AuditLogStore(join(this.config.dataDir, "openadminos.db"), this.now);
      const interrupted = this.runs.markInterrupted(this.now());
      if (interrupted > 0) this.log("warn", "Runs left running by a stopped host were marked interrupted.", { count: interrupted });
    } catch (error) {
      this.lock.release();
      throw error;
    }
  }

  /** Stops the schedule, stops runs in progress, closes the audit log and releases the lock. */
  async close(): Promise<void> {
    this.stopController.abort();
    await this.scheduler?.stop();
    this.audit?.close();
    this.audit = undefined;
    this.lock.release();
  }

  startSchedule(): Scheduler {
    const scheduler = new Scheduler(
      this.config.agents.map((agent) => ({
        id: agent.id,
        intervalMs: agent.intervalSeconds * 1000,
        ...(this.lastStartedAt(agent.id) !== undefined ? { lastStartedAt: this.lastStartedAt(agent.id) as number } : {}),
        run: async () => {
          await this.runAgent(agent, "schedule");
        },
      })),
      this.deps.schedulerClock,
    );
    this.scheduler = scheduler;
    scheduler.start();
    for (const next of scheduler.nextRuns()) {
      this.log("info", "Scheduled.", { agent: next.id, next: new Date(next.dueAt).toISOString() });
    }
    return scheduler;
  }

  async runAgent(agentConfig: SandboxAgentConfig, initiator: Extract<RunInitiator, "schedule" | "person">): Promise<RunOutcome> {
    if (this.inFlight.has(agentConfig.id)) {
      const message = `${agentConfig.id} is still running; this start was skipped.`;
      this.log("warn", message, { agent: agentConfig.id, reason: "already-running" });
      return { kind: "refused", reason: "already-running", message };
    }
    this.inFlight.add(agentConfig.id);
    try {
      return await this.runAgentNow(agentConfig, initiator);
    } catch (error) {
      // Run records, health.json and the audit log live in the data folder;
      // a failure to write them is named, never dropped.
      const message = `${agentConfig.id} stopped: the sandbox data folder could not be written. ${describe(error)} Check free disk space and permissions of ${this.config.dataDir}.`;
      this.log("error", message, { agent: agentConfig.id, reason: "storage-failed" });
      this.safeHealth(agentConfig.id, { lastRefusal: { reason: "storage-failed", message, at: this.now().toISOString() } });
      return { kind: "refused", reason: "storage-failed", message };
    } finally {
      this.inFlight.delete(agentConfig.id);
    }
  }

  private auditContext(agentId: string, initiator: RunInitiator, runId?: string): SandboxAuditContext {
    return {
      tenantId: this.config.tenantId,
      organizationId: this.config.organizationId,
      sandboxId: this.config.sandbox.id,
      agentSlug: agentId,
      initiator,
      ...(runId ? { runId } : {}),
    };
  }

  private requireAudit(): AuditLogStore {
    if (!this.audit) throw new SandboxRefusal("audit-failed", "The audit log is not open. Start the sandbox host again.");
    return this.audit;
  }

  /** The throwing append: a failure becomes the named audit refusal. */
  private auditEvent(context: SandboxAuditContext, type: string, details: Record<string, unknown>): void {
    try {
      appendSandboxEvent(this.requireAudit(), context, type, details, this.now);
    } catch (cause) {
      if (isSandboxRefusal(cause)) throw cause;
      throw new SandboxRefusal(
        "audit-failed",
        `The audit log could not record ${type}: ${describe(cause)} Nothing was sent. Check free disk space and permissions of the sandbox data folder.`,
        { cause },
      );
    }
  }

  private async runAgentNow(agentConfig: SandboxAgentConfig, initiator: Extract<RunInitiator, "schedule" | "person">): Promise<RunOutcome> {
    const agentId = agentConfig.id;
    const context = this.auditContext(agentId, initiator);
    let secrets: SandboxSecrets = {};
    let prepared: { resolved: SandboxAgent; model: ModelCheck; tokenProvider: ApplicationTokenProvider; token: ApplicationToken };
    try {
      prepared = await this.preflight(agentConfig, context, (loaded) => {
        secrets = loaded;
      });
    } catch (error) {
      const refusal = isSandboxRefusal(error) ? error : new SandboxRefusal("run-failed", `The preflight of ${agentId} failed: ${describe(error)}`, { cause: error });
      return this.refuse(agentConfig, context, refusal, secrets);
    }
    return this.execute(agentConfig, initiator, prepared, secrets);
  }

  private async preflight(
    agentConfig: SandboxAgentConfig,
    context: SandboxAuditContext,
    setSecrets: (secrets: SandboxSecrets) => void,
  ): Promise<{ resolved: SandboxAgent; model: ModelCheck; tokenProvider: ApplicationTokenProvider; token: ApplicationToken }> {
    const now = this.now();
    const certificate = chooseCertificate(this.config.certificates, now);
    for (const warning of certificate.warnings) this.log("warn", warning, { agent: agentConfig.id });
    const resolved = resolveSandboxAgent(agentConfig);
    const model = await checkLocalModel(this.config.model, this.deps.modelFetch ?? fetch);
    if (agentConfig.delivery) {
      setSecrets(loadSandboxSecrets(this.config.secretsPath, new Set([agentConfig.delivery.connector])));
    }
    this.auditEvent(context, "sandbox.run.preflight", {
      templateSha256: resolved.sha256,
      model: model.model,
      ...(model.digest ? { modelDigest: model.digest } : {}),
      certificateSha256: certificate.signer.thumbprintSha256,
    });

    const expectation = { tenantId: this.config.tenantId, clientId: this.config.clientId, allowedRoles: this.allowedRoles };
    const factory = this.deps.createTokenProvider ?? createApplicationTokenProvider;
    const tokenProvider = factory({
      tenantId: this.config.tenantId,
      clientId: this.config.clientId,
      signer: certificate.signer,
      ...(this.deps.signInFetch ? { fetch: this.deps.signInFetch } : {}),
      onAcquired: (token) => {
        this.auditEvent(context, "sandbox.token.acquired", {
          roles: token.roles,
          expiresOn: token.expiresOn.toISOString(),
          certificateSha256: certificate.signer.thumbprintSha256,
        });
        assertSandboxIdentity(token, expectation);
      },
      onFailed: (error) => {
        this.auditEvent(context, "sandbox.token.failed", { code: error.code, ...(error.aadsts ? { aadsts: error.aadsts } : {}) });
      },
    });
    let token: ApplicationToken;
    try {
      token = await tokenProvider.acquire();
    } catch (error) {
      if (isSandboxRefusal(error)) throw error;
      if (error instanceof ApplicationTokenError) {
        if (error.code === "token-undecodable") throw new SandboxRefusal("token-undecodable", "The token from Microsoft sign-in cannot be decoded, so its permissions cannot be checked. Nothing was read.");
        throw signInRefusal(error.aadsts, error.message);
      }
      throw signInRefusal(undefined, describe(error));
    }
    assertAgentPermissions(token.roles, resolved.manifest.descriptor.name, resolved.agent.scopes);
    return { resolved, model, tokenProvider, token };
  }

  private async execute(
    agentConfig: SandboxAgentConfig,
    initiator: Extract<RunInitiator, "schedule" | "person">,
    prepared: { resolved: SandboxAgent; model: ModelCheck; tokenProvider: ApplicationTokenProvider },
    secrets: SandboxSecrets,
  ): Promise<RunOutcome> {
    const { resolved, model, tokenProvider } = prepared;
    const queued = createQueuedRun({ agent: resolved.agent, providerId: this.config.model.provider, model: model.model });
    let run: RunRecord = {
      ...queued,
      trigger: initiator === "schedule" ? "schedule" : "manual",
      initiator,
      tenantId: this.config.tenantId,
      executedOn: {
        kind: "sandbox",
        sandboxId: this.config.sandbox.id,
        name: this.config.sandbox.name,
        organizationId: this.config.organizationId,
        model: model.model,
        ...(model.digest ? { modelDigest: model.digest } : {}),
      },
    };
    const context = this.auditContext(agentConfig.id, initiator, run.id);
    this.runs.write(run);
    this.log("info", "Run started.", { agent: agentConfig.id, run: run.id });

    const controller = new AbortController();
    let stopReason: SandboxRefusal | undefined;
    const stop = (refusal: SandboxRefusal) => {
      stopReason ??= refusal;
      if (!controller.signal.aborted) controller.abort(refusal);
    };
    const onShutdown = () => stop(new SandboxRefusal("run-stopped", "The sandbox host stopped during the run. The next scheduled run starts fresh."));
    this.stopController.signal.addEventListener("abort", onShutdown, { once: true });
    if (this.stopController.signal.aborted) onShutdown();
    const deadline = setTimeout(
      () => stop(new SandboxRefusal("run-deadline", `The run did not finish within ${this.config.runDeadlineSeconds} seconds and was stopped. Check the model's speed on this machine, or raise runDeadlineSeconds.`)),
      this.config.runDeadlineSeconds * 1000,
    );
    const statuses: number[] = [];
    const sink = graphRequestAuditSink(this.requireAudit(), context, this.now);
    const fetchImpl = sandboxGraphFetch({
      ...(this.deps.graphFetch ? { base: this.deps.graphFetch } : {}),
      sink,
      onStop: stop,
      onStatus: (status) => statuses.push(status),
    });
    const guardedTokens = (async () => {
      try {
        return await tokenProvider();
      } catch (error) {
        const refusal = isSandboxRefusal(error)
          ? error
          : error instanceof ApplicationTokenError
            ? signInRefusal(error.aadsts, error.message)
            : signInRefusal(undefined, describe(error));
        stop(refusal);
        throw refusal;
      }
    });
    const timeoutMs = (this.config.model.timeoutSeconds ?? 300) * 1000;
    const llm = this.deps.createLlm?.(this.config.model, model) ??
      (this.config.model.provider === "ollama"
        ? createOllamaLlm({ endpoint: this.config.model.endpoint, defaultModel: model.model, timeoutMs })
        : createLmStudioLlm({ endpoint: this.config.model.endpoint, defaultModel: model.model, timeoutMs }));

    try {
      run = await executeRun({
        signal: controller.signal,
        run,
        agent: resolved.agent,
        providerId: this.config.model.provider,
        model: model.model,
        llm,
        realWrites: false,
        module: resolved.module,
        createGraph: (log) =>
          createGraphAdapter({
            tokenProvider: guardedTokens,
            log,
            signal: controller.signal,
            fetchImpl,
            ...(this.deps.graphRetryBackoffMs !== undefined ? { retryBackoffMs: this.deps.graphRetryBackoffMs } : {}),
          }),
        onProgress: (progress) => {
          run = progress;
        },
      });
    } catch (error) {
      run = { ...run, status: "failed", finishedAt: this.now().toISOString(), error: describe(error), summary: `${resolved.manifest.descriptor.name} failed.` };
    } finally {
      clearTimeout(deadline);
      this.stopController.signal.removeEventListener("abort", onShutdown);
    }

    let outcome: RunOutcome;
    if (run.status === "completed" && !stopReason) {
      outcome = { kind: "completed", run };
    } else {
      const refusal = stopReason ?? failureReason(run, statuses);
      run = {
        ...run,
        status: "failed",
        finishedAt: run.finishedAt ?? this.now().toISOString(),
        error: refusal.message,
        logs: [...run.logs, { id: `${run.id}_reason`, runId: run.id, timestamp: this.now().toISOString(), level: "error", message: refusal.message, metadata: { reason: refusal.reason } }],
      };
      outcome = { kind: "failed", reason: refusal.reason, message: refusal.message, run };
    }
    this.runs.write(run);
    this.safeHealth(agentConfig.id, {
      lastRun: { runId: run.id, status: run.status, ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}), ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) },
    });
    try {
      this.auditEvent(context, "sandbox.run.finished", { status: run.status, ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}) });
    } catch (error) {
      this.log("error", describe(error), { agent: agentConfig.id, run: run.id, reason: "audit-failed" });
    }
    this.log(outcome.kind === "completed" ? "info" : "error", outcome.kind === "completed" ? "Run completed." : "Run failed.", {
      agent: agentConfig.id,
      run: run.id,
      reason: outcome.kind === "failed" ? outcome.reason : undefined,
      steps: run.steps.length,
    });

    const delivered = await this.deliverRun(agentConfig, context, run, resolved, outcome, secrets);
    if (delivered) {
      run = delivered;
      outcome = { ...outcome, run };
    }
    return outcome;
  }

  /** Sends the report when the config asks for it, once. Records the result on the run. */
  private async deliverRun(
    agentConfig: SandboxAgentConfig,
    context: SandboxAuditContext,
    run: RunRecord,
    resolved: SandboxAgent,
    outcome: RunOutcome,
    secrets: SandboxSecrets,
  ): Promise<RunRecord | undefined> {
    const delivery = agentConfig.delivery;
    if (!delivery) return undefined;
    const completed = outcome.kind === "completed";
    if (!((completed && delivery.notifyOnSuccess) || (!completed && delivery.notifyOnFailure))) {
      await this.sendNotice(agentConfig, context, outcome.kind === "completed" ? undefined : outcome.reason, secrets);
      return undefined;
    }
    const text = renderSandboxReport({
      run,
      agentName: resolved.manifest.descriptor.name,
      sandboxName: this.config.sandbox.name,
      resultDefinition: resolved.manifest.definition.result.data,
      ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}),
    });
    const result = await this.send(agentConfig, context, run.id, delivery, secrets, text);
    if (delivery.failureNotice && result.outcome === "sent") {
      // The report carried the status, so it counts as the notice for it.
      this.safeHealth(agentConfig.id, { lastNoticeReason: outcome.kind === "failed" ? outcome.reason : undefined });
    }
    const at = this.now().toISOString();
    const label = delivery.connector === "slack" ? "Send report to Slack" : "Send report to Discord";
    const updated: RunRecord = {
      ...run,
      steps: [...run.steps, { id: `${run.id}_delivery`, runId: run.id, label, status: result.outcome === "sent" ? "completed" : "failed", detail: result.detail, startedAt: at, finishedAt: at }],
      logs: [...run.logs, { id: `${run.id}_delivery_log`, runId: run.id, timestamp: at, level: result.outcome === "sent" ? "info" : "warn", message: result.outcome === "sent" ? "Report delivered." : `Report not delivered: ${result.detail}`, metadata: { reason: result.outcome === "sent" ? "delivered" : "delivery-failed" } }],
    };
    this.runs.write(updated);
    return updated;
  }

  private async send(
    agentConfig: SandboxAgentConfig,
    context: SandboxAuditContext,
    idempotencyKey: string,
    delivery: NonNullable<SandboxAgentConfig["delivery"]>,
    secrets: SandboxSecrets,
    text: string,
  ): Promise<{ outcome: "sent" | "failed"; detail: string }> {
    const digest = payloadDigest(text);
    try {
      this.auditEvent(context, "delivery.attempted", { connector: delivery.connector, payloadDigest: digest, idempotencyKey });
    } catch (error) {
      const detail = describe(error);
      this.safeHealth(agentConfig.id, { lastDelivery: { runId: idempotencyKey, outcome: "failed", detail, at: this.now().toISOString() } });
      this.log("error", "Report not delivered: the audit log could not record it.", { agent: agentConfig.id, reason: "audit-failed" });
      return { outcome: "failed", detail };
    }
    const result = await sendDelivery({ delivery, secrets, text, ...(this.deps.deliveryFetch ? { fetch: this.deps.deliveryFetch } : {}) });
    try {
      this.auditEvent(context, "delivery.result", { connector: delivery.connector, payloadDigest: digest, idempotencyKey, outcome: result.outcome });
    } catch (error) {
      this.log("error", describe(error), { agent: agentConfig.id, reason: "audit-failed" });
    }
    this.safeHealth(agentConfig.id, { lastDelivery: { runId: idempotencyKey, outcome: result.outcome, detail: result.detail, at: this.now().toISOString() } });
    this.log(result.outcome === "sent" ? "info" : "warn", result.outcome === "sent" ? "Report delivered." : "Report not delivered.", {
      agent: agentConfig.id,
      connector: delivery.connector,
      reason: result.outcome === "sent" ? undefined : "delivery-failed",
    });
    return result;
  }

  private async refuse(agentConfig: SandboxAgentConfig, context: SandboxAuditContext, refusal: SandboxRefusal, secrets: SandboxSecrets): Promise<RunOutcome> {
    const at = this.now().toISOString();
    this.log("error", refusal.message, { agent: agentConfig.id, reason: refusal.reason });
    this.safeHealth(agentConfig.id, { lastRefusal: { reason: refusal.reason, message: refusal.message, at } });
    if (refusal.reason !== "audit-failed") {
      try {
        this.auditEvent(context, "sandbox.run.refused", { reason: refusal.reason });
      } catch (error) {
        this.log("error", describe(error), { agent: agentConfig.id, reason: "audit-failed" });
      }
    }
    await this.sendNotice(agentConfig, context, refusal.reason, secrets);
    return { kind: "refused", reason: refusal.reason, message: refusal.message };
  }

  /**
   * Failure notices, metadata only: one when the reason differs from the
   * last notice for this agent, and one when runs complete again. The
   * last reason noticed is kept in health.json, so a restart does not
   * repeat a notice.
   */
  private async sendNotice(agentConfig: SandboxAgentConfig, context: SandboxAuditContext, reason: string | undefined, secrets: SandboxSecrets): Promise<void> {
    const delivery = agentConfig.delivery;
    if (!delivery?.failureNotice || !(secrets.slack || secrets.discord)) return;
    const previous = this.health.get(agentConfig.id).lastNoticeReason;
    if (reason === previous) return;
    const at = this.now().toISOString();
    const text = reason === undefined
      ? renderRecoveryNotice({ agentId: agentConfig.id, sandboxName: this.config.sandbox.name, at })
      : renderFailureNotice({ agentId: agentConfig.id, sandboxName: this.config.sandbox.name, reason, at });
    const result = await this.send(agentConfig, context, `notice:${agentConfig.id}:${at}`, delivery, secrets, text);
    if (result.outcome === "sent") this.safeHealth(agentConfig.id, { lastNoticeReason: reason });
  }

  /** health.json is a convenience for the admin; a failed write is logged and the run goes on. */
  private safeHealth(agentId: string, change: Parameters<HealthStore["update"]>[1]): void {
    try {
      this.health.update(agentId, change, this.now());
    } catch (error) {
      this.log("error", `health.json could not be written: ${describe(error)}`, { agent: agentId, reason: "storage-failed" });
    }
  }

  private lastStartedAt(agentId: string): number | undefined {
    const latest = this.runs.latest(agentId);
    const refusal = this.health.get(agentId).lastRefusal;
    const times = [latest?.queuedAt, refusal?.at].filter((value): value is string => typeof value === "string").map((value) => Date.parse(value)).filter(Number.isFinite);
    return times.length > 0 ? Math.max(...times) : undefined;
  }
}

/** The named reason of a run that failed without the sandbox stopping it. */
function failureReason(run: RunRecord, statuses: readonly number[]): SandboxRefusal {
  const error = run.error ?? "";
  if (/(?:Ollama|LM Studio) timed out/.test(error)) {
    return new SandboxRefusal("model-timeout", "The local model did not answer in time. Check the load on this machine, use a smaller model, or raise model.timeoutSeconds.");
  }
  const last = [...statuses].reverse().find((status) => status >= 400);
  if (last === 401) {
    return new SandboxRefusal("graph-unauthorized", "Microsoft Graph refused the sandbox token (HTTP 401). For Intune this also means the app lacks the permission the request needs. Check the granted permissions and admin consent.");
  }
  if (last === 403 || run.accessDenial) {
    return new SandboxRefusal("graph-forbidden", "Microsoft Graph denied a read (HTTP 403). Grant the Read permission the agent declares, with admin consent, then run again.");
  }
  if (last === 429) {
    return new SandboxRefusal("graph-throttled", "Microsoft Graph kept throttling the sandbox (HTTP 429) after the waits it asked for. The next scheduled run tries again.");
  }
  return new SandboxRefusal("run-failed", `The agent failed: ${error.slice(0, 300) || "no error was recorded."}`);
}
