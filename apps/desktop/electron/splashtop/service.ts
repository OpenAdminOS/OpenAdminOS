import {
  isSplashtopRegion,
  organizationForTenant,
  resolveOrganizations,
  splashtopConnectionOf,
  splashtopConnectionSummary,
  splashtopRegion,
  type ConnectSplashtopInput,
  type OrganizationRecord,
  type RotateSplashtopTokenInput,
  type SplashtopConnectionRecord,
  type SplashtopConnectionSummary,
  type TenantRecord,
} from "@openadminos/agent-sdk";

import { normalizeSplashtopToken, SplashtopApi, SplashtopApiError, splashtopTokenProblem, type SplashtopFetch } from "./api.js";
import type { SplashtopTokenStore } from "./token-store.js";

/**
 * The Splashtop connection of each organization: connect, test, rotate and
 * disconnect, and the API client Chat and change plans use. A connection
 * belongs to one organization; its token is stored under that
 * organization's id and is never used for another one.
 */

export interface SplashtopStateLike {
  organizations?: OrganizationRecord[];
  tenants: TenantRecord[];
  activeTenantId?: string;
}

export interface SplashtopServiceHost<S extends SplashtopStateLike> {
  read(): Promise<S>;
  serialize<T>(work: () => Promise<T>): Promise<T>;
  write(state: S): Promise<void>;
  tokens: SplashtopTokenStore;
  clock(): Date;
  fetch?: SplashtopFetch;
  timeoutMs?: number;
  changed(): void;
}

export interface SplashtopBinding {
  organization: OrganizationRecord;
  record: SplashtopConnectionRecord;
  api: SplashtopApi;
}

export class SplashtopNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplashtopNotConnectedError";
  }
}

export class SplashtopService<S extends SplashtopStateLike> {
  constructor(private readonly host: SplashtopServiceHost<S>) {}

  private client(region: SplashtopConnectionRecord["region"], token: string): SplashtopApi {
    return new SplashtopApi({
      region,
      token,
      ...(this.host.fetch ? { fetch: this.host.fetch } : {}),
      ...(this.host.timeoutMs ? { timeoutMs: this.host.timeoutMs } : {}),
    });
  }

  // TODO(ugur): an organization is still created by its Microsoft 365
  // connection, so Splashtop connects only into one that has it. A
  // Splashtop-only organization needs the active organization to stop
  // deriving from `activeTenantId`.
  private organization(state: S, organizationId: string): OrganizationRecord {
    const organization = resolveOrganizations(state).find((entry) => entry.id === organizationId);
    if (!organization) throw new SplashtopNotConnectedError("That organization is no longer on this device. Reopen Connections and try again.");
    if (organization.kind === "sample") throw new SplashtopNotConnectedError("The sample organization cannot connect services.");
    return organization;
  }

  private withRecord(state: S, organizationId: string, record: SplashtopConnectionRecord | undefined): S {
    const organizations = resolveOrganizations(state).map((organization) => {
      if (organization.id !== organizationId) return organization;
      const { splashtop: _previous, ...connections } = organization.connections;
      return { ...organization, connections: record ? { ...connections, splashtop: record } : connections };
    });
    return { ...state, organizations };
  }

  summaries(state: S): SplashtopConnectionSummary[] {
    return resolveOrganizations(state).flatMap((organization) => {
      const record = splashtopConnectionOf(organization);
      return record ? [splashtopConnectionSummary(organization.id, record)] : [];
    });
  }

  async connect(input: ConnectSplashtopInput): Promise<SplashtopConnectionSummary> {
    if (!isSplashtopRegion(input.region)) throw new SplashtopApiError("refused", "Choose the region of your Splashtop account: Global / US, EU or Oceania. Nothing was sent.", { sent: false });
    const token = normalizeSplashtopToken(String(input.token ?? ""));
    const problem = splashtopTokenProblem(token);
    if (problem) throw new SplashtopApiError("refused", `${problem} Nothing was sent.`, { sent: false });
    this.organization(await this.host.read(), input.organizationId);
    // The check runs before anything is saved; a failure saves nothing.
    const info = await this.client(input.region, token).basicInfo();
    const now = this.host.clock().toISOString();
    const summary = await this.host.serialize(async () => {
      const state = await this.host.read();
      const organization = this.organization(state, input.organizationId);
      const previous = splashtopConnectionOf(organization);
      const previousToken = previous ? await this.host.tokens.get(organization.id) : undefined;
      const record: SplashtopConnectionRecord = {
        region: input.region,
        teamId: info.teamId,
        ...(info.account ? { account: info.account } : {}),
        connectedAt: now,
        tokenSetAt: now,
        lastCheckedAt: now,
        tokenScopes: info.tokenScopes,
      };
      await this.host.tokens.set(organization.id, token);
      try {
        await this.host.write(this.withRecord(state, organization.id, record));
      } catch (cause) {
        if (previousToken) await this.host.tokens.set(organization.id, previousToken).catch(() => undefined);
        else await this.host.tokens.remove(organization.id).catch(() => undefined);
        throw cause;
      }
      return splashtopConnectionSummary(organization.id, record);
    });
    this.host.changed();
    return summary;
  }

  async test(organizationId: string): Promise<SplashtopConnectionSummary> {
    const binding = await this.binding(await this.host.read(), organizationId);
    const info = await binding.api.basicInfo();
    const summary = await this.host.serialize(async () => {
      const state = await this.host.read();
      const organization = this.organization(state, organizationId);
      const current = splashtopConnectionOf(organization);
      // A disconnect or rotate while this ran wins; this check saves nothing then.
      if (!current || current.tokenSetAt !== binding.record.tokenSetAt) {
        throw new SplashtopNotConnectedError("The Splashtop connection changed while it was tested. Test it again.");
      }
      if (info.teamId !== current.teamId) {
        throw new SplashtopApiError("forbidden", `The token now reaches Splashtop team ${info.teamId}, not team ${current.teamId} it was connected to. Disconnect Splashtop and connect it again.`, { sent: true });
      }
      const record: SplashtopConnectionRecord = {
        ...current,
        ...(info.account ? { account: info.account } : {}),
        lastCheckedAt: this.host.clock().toISOString(),
        tokenScopes: info.tokenScopes,
      };
      await this.host.write(this.withRecord(state, organizationId, record));
      return splashtopConnectionSummary(organizationId, record);
    });
    this.host.changed();
    return summary;
  }

  async rotate(input: RotateSplashtopTokenInput): Promise<SplashtopConnectionSummary> {
    const token = normalizeSplashtopToken(String(input.token ?? ""));
    const problem = splashtopTokenProblem(token);
    if (problem) throw new SplashtopApiError("refused", `${problem} Nothing was sent.`, { sent: false });
    const before = splashtopConnectionOf(this.organization(await this.host.read(), input.organizationId));
    if (!before) throw new SplashtopNotConnectedError("Splashtop is not connected for this organization. Connect it first.");
    // The new token is checked against the connection's own region only.
    const info = await this.client(before.region, token).basicInfo();
    if (info.teamId !== before.teamId) {
      throw new SplashtopApiError(
        "forbidden",
        `The new token belongs to Splashtop team ${info.teamId}, not team ${before.teamId} of this connection. Nothing was changed. To switch teams, disconnect Splashtop and connect again.`,
        { sent: true },
      );
    }
    const summary = await this.host.serialize(async () => {
      const state = await this.host.read();
      const organization = this.organization(state, input.organizationId);
      const current = splashtopConnectionOf(organization);
      if (!current || current.tokenSetAt !== before.tokenSetAt) {
        throw new SplashtopNotConnectedError("The Splashtop connection changed while the new token was checked. Nothing was changed; try again.");
      }
      const previousToken = await this.host.tokens.get(organization.id);
      const now = this.host.clock().toISOString();
      const record: SplashtopConnectionRecord = {
        ...current,
        ...(info.account ? { account: info.account } : {}),
        tokenSetAt: now,
        lastCheckedAt: now,
        tokenScopes: info.tokenScopes,
      };
      await this.host.tokens.set(organization.id, token);
      try {
        await this.host.write(this.withRecord(state, organization.id, record));
      } catch (cause) {
        if (previousToken) await this.host.tokens.set(organization.id, previousToken).catch(() => undefined);
        throw cause;
      }
      return splashtopConnectionSummary(organization.id, record);
    });
    this.host.changed();
    return summary;
  }

  async disconnect(organizationId: string): Promise<void> {
    await this.host.serialize(async () => {
      const state = await this.host.read();
      const organization = resolveOrganizations(state).find((entry) => entry.id === organizationId);
      if (organization && splashtopConnectionOf(organization)) {
        await this.host.write(this.withRecord(state, organizationId, undefined));
      }
      // The token goes even when the record was already gone.
      await this.host.tokens.remove(organizationId);
    });
    this.host.changed();
  }

  /** Deletes tokens of organizations that no longer hold a Splashtop connection. */
  async sweep(state: S): Promise<number> {
    const keep = new Set(resolveOrganizations(state).filter((organization) => splashtopConnectionOf(organization)).map((organization) => organization.id));
    return this.host.tokens.sweep(keep);
  }

  /** The organization's client. Refuses, with a designed message, when it has no connection or token. */
  async binding(state: S, organizationId: string): Promise<SplashtopBinding> {
    const organization = this.organization(state, organizationId);
    const record = splashtopConnectionOf(organization);
    if (!record) throw new SplashtopNotConnectedError(`Splashtop is not connected for ${organization.name}. Connect it on Connections.`);
    const token = await this.host.tokens.get(organization.id);
    if (!token) {
      throw new SplashtopNotConnectedError(
        `The Splashtop token of ${organization.name} is not in this device's secure storage anymore. Use Rotate token on Connections to save a new one.`,
      );
    }
    return { organization, record, api: this.client(record.region, token) };
  }

  /** The binding of the organization that holds this tenant, or undefined when it has no Splashtop connection. */
  async bindingForTenant(state: S, tenantId: string): Promise<SplashtopBinding | undefined> {
    const organization = organizationForTenant(resolveOrganizations(state), tenantId);
    if (!organization || !splashtopConnectionOf(organization)) return undefined;
    return this.binding(state, organization.id);
  }

  static teamLabel(binding: Pick<SplashtopBinding, "organization" | "record">): string {
    return `${binding.organization.name} (Splashtop team ${binding.record.teamId}, ${splashtopRegion(binding.record.region).label})`;
  }
}
