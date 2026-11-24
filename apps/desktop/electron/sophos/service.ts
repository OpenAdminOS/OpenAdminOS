import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  activeOrganizationOf,
  isSophosId,
  isSophosRegionHost,
  resolveOrganizations,
  type ConnectSophosInput,
  type OrganizationRecord,
  type SophosConnectionRecord,
  type SophosConnectionSummary,
  type TenantRecord,
} from "@openadminos/agent-sdk";

import { SafeStorageConnectorSecretStore } from "../connector-secret-store.js";
import { dataFolderSealed, DataFolderSealedError } from "../data-folder-seal.js";
import { SophosApi, SophosApiError, type SophosCredentials } from "./api.js";

interface SophosState {
  organizations?: OrganizationRecord[];
  tenants: TenantRecord[];
  activeTenantId?: string;
}

function key(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function validRecord(record: SophosConnectionRecord | undefined): record is SophosConnectionRecord {
  return Boolean(record && isSophosRegionHost(record.host) && isSophosId(record.tenantId) &&
    typeof record.connectionId === "string" && record.connectionId &&
    typeof record.connectedAt === "string" && Number.isFinite(Date.parse(record.connectedAt)) &&
    typeof record.lastCheckedAt === "string" && Number.isFinite(Date.parse(record.lastCheckedAt)));
}

function summary(organizationId: string, record: SophosConnectionRecord): SophosConnectionSummary {
  return { ...record, organizationId, region: record.host.slice(4, 8).toUpperCase() };
}

export class SophosService<S extends SophosState> {
  private readonly disconnecting = new Set<string>();
  private readonly memory = new Map<string, string>();
  private readonly clients = new Map<string, { connectionId: string; api: SophosApi }>();
  private readonly storage;

  constructor(private readonly host: {
    read(): Promise<S>;
    serialize<T>(work: () => Promise<T>): Promise<T>;
    write(state: S): Promise<void>;
    changed(): void;
    clock(): Date;
    secretsRoot?: string;
    fetch?: typeof fetch;
  }) {
    this.storage = host.secretsRoot
      ? new SafeStorageConnectorSecretStore(host.secretsRoot).forConnector("sophos")
      : {
          get: async (id: string) => this.memory.get(id),
          set: async (id: string, value: string) => { this.memory.set(id, value); },
          remove: async (id: string) => this.memory.delete(id),
        };
  }

  private active(state: S, id: string): OrganizationRecord {
    if (dataFolderSealed()) throw new DataFolderSealedError();
    const organization = activeOrganizationOf(state);
    if (organization?.id !== id) {
      throw new SophosApiError("refused", "Switch to the organization in Connections and try again.");
    }
    if (this.disconnecting.has(id)) {
      throw new SophosApiError("refused", "Sophos Central is disconnecting. Wait for it to finish, then reconnect in Connections.");
    }
    return organization;
  }

  private update(state: S, id: string, record?: SophosConnectionRecord): Promise<void> {
    const organizations = resolveOrganizations(state).map((organization) => {
      if (organization.id !== id) return organization;
      const { sophos: _previous, ...connections } = organization.connections;
      return { ...organization, connections: record ? { ...connections, sophos: record } : connections };
    });
    return this.host.write({ ...state, organizations });
  }

  private client(credentials: SophosCredentials): SophosApi {
    return new SophosApi(credentials, this.host.fetch ? { fetch: this.host.fetch } : {});
  }

  private async credentialsFor(id: string): Promise<SophosCredentials> {
    let credentials: Partial<SophosCredentials> | undefined;
    try {
      const stored = await this.storage.get(key(id));
      if (stored) credentials = JSON.parse(stored);
    } catch {
      throw new SophosApiError("credentials", "Could not read the Sophos Central credential from secure storage. Unlock this device's secure storage or reconnect in Connections.");
    }
    if (typeof credentials?.clientId !== "string" || typeof credentials.clientSecret !== "string") {
      throw new SophosApiError("credentials", "The Sophos Central credential is missing. Disconnect and reconnect in Connections.");
    }
    return { clientId: credentials.clientId, clientSecret: credentials.clientSecret };
  }

  summaries(state: S): SophosConnectionSummary[] {
    return resolveOrganizations(state).flatMap(({ id, connections: { sophos } }) => {
      if (sophos === undefined) return [];
      if (validRecord(sophos)) return [summary(id, sophos)];
      return [{ organizationId: id, unreadable: true, region: "", host: "", tenantId: "", connectionId: "", connectedAt: "", lastCheckedAt: "" }];
    });
  }

  async connect({ organizationId, clientId, clientSecret }: ConnectSophosInput): Promise<SophosConnectionSummary> {
    const credentials = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new SophosApiError("refused", "Enter the Sophos Central client ID and secret.");
    }
    const result = await this.host.serialize(async () => {
      const before = this.active(await this.host.read(), organizationId);
      if (before.connections.sophos !== undefined) throw new SophosApiError("refused", "Disconnect Sophos Central before connecting new credentials.");
      const api = this.client(credentials);
      const identity = await api.identify();
      const state = await this.host.read();
      this.active(state, organizationId);
      const now = this.host.clock().toISOString();
      const record = { ...identity, connectionId: randomUUID(), connectedAt: now, lastCheckedAt: now };
      const secretKey = key(organizationId);
      await this.storage.set(secretKey, JSON.stringify(credentials));
      try {
        await this.update(state, organizationId, record);
      } catch (error) {
        await this.storage.remove(secretKey);
        throw error;
      }
      this.clients.set(organizationId, { connectionId: record.connectionId, api });
      return summary(organizationId, record);
    });
    this.host.changed();
    return result;
  }

  async binding(state: S, id: string) {
    const { connections: { sophos: record } } = this.active(state, id);
    if (!validRecord(record)) {
      throw new SophosApiError("refused", "Connect Sophos Central for this organization in Connections.");
    }
    const cached = this.clients.get(id);
    if (cached?.connectionId === record.connectionId) return { record, api: cached.api };
    const api = this.client(await this.credentialsFor(id));
    this.requireBinding(await this.host.read(), id, record.connectionId);
    this.clients.set(id, { connectionId: record.connectionId, api });
    return { record, api };
  }

  requireBinding(state: S, id: string, connectionId: string): SophosConnectionRecord {
    const record = this.active(state, id).connections.sophos;
    if (!validRecord(record) || record.connectionId !== connectionId) {
      throw new SophosApiError("refused", "The Sophos Central connection changed. Reconnect in Connections and try again.");
    }
    return record;
  }

  // Call with the state lock held when the read is part of a serialized operation.
  async check<T>(id: string, connectionId: string, work: () => Promise<T>, locked = false): Promise<T> {
    const save = async (issue?: SophosConnectionRecord["issue"]) => {
      const write = async () => {
        const state = await this.host.read();
        const { issue: _previous, ...record } = this.requireBinding(state, id, connectionId);
        await this.update(state, id, {
          ...record,
          lastCheckedAt: this.host.clock().toISOString(),
          ...(issue ? { issue } : {}),
        });
        this.host.changed();
      };
      if (locked) await write();
      else await this.host.serialize(write);
    };
    let result: T;
    try {
      result = await work();
    } catch (error) {
      if (error instanceof SophosApiError &&
          (error.code === "credentials" || error.code === "forbidden" || error.code === "rate-limit")) {
        await save(error.code);
      }
      throw error;
    }
    await save();
    return result;
  }

  async test(id: string): Promise<SophosConnectionSummary> {
    return this.host.serialize(async () => {
      const record = this.active(await this.host.read(), id).connections.sophos;
      if (!validRecord(record)) {
        throw new SophosApiError("refused", "Disconnect the unreadable Sophos Central connection record and reconnect.");
      }
      await this.check(id, record.connectionId, async () => {
        this.clients.delete(id);
        const api = this.client(await this.credentialsFor(id));
        const identity = await api.identify();
        if (identity.tenantId !== record.tenantId || identity.host !== record.host) {
          throw new SophosApiError("credentials", "The credential now identifies a different Sophos Central tenant or region. Disconnect and reconnect in Connections.");
        }
        this.clients.set(id, { connectionId: record.connectionId, api });
      }, true);
      return summary(id, this.requireBinding(await this.host.read(), id, record.connectionId));
    });
  }

  async disconnect(id: string): Promise<void> {
    if (this.disconnecting.has(id)) return;
    this.disconnecting.add(id);
    try {
      await this.host.serialize(async () => {
        const state = await this.host.read();
        if (dataFolderSealed()) throw new DataFolderSealedError();
        if (activeOrganizationOf(state)?.id !== id) {
          throw new SophosApiError("refused", "Switch to the organization in Connections and try again.");
        }
        await this.storage.remove(key(id));
        this.clients.delete(id);
        await this.update(state, id);
      });
      this.host.changed();
    } finally {
      this.disconnecting.delete(id);
    }
  }

  async sweep(): Promise<void> {
    await this.host.serialize(async () => {
      const connected = this.summaries(await this.host.read());
      const kept = new Set(connected.map(({ organizationId }) => key(organizationId)));
      for (const id of this.clients.keys()) {
        if (!kept.has(key(id))) this.clients.delete(id);
      }
      let files: string[] = [];
      if (this.host.secretsRoot) {
        try {
          files = await readdir(join(this.host.secretsRoot, "sophos"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const keys = [...this.memory.keys(), ...files.filter((file) => file.endsWith(".bin")).map((file) => file.slice(0, -4))];
      for (const secretKey of keys) {
        if (!kept.has(secretKey)) await this.storage.remove(secretKey);
      }
    });
  }
}
