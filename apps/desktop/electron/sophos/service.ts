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

function summary(organizationId: string, record: SophosConnectionRecord): SophosConnectionSummary {
  return { ...record, organizationId, region: record.host.slice(4, 8).toUpperCase() };
}

export class SophosService<S extends SophosState> {
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
    return resolveOrganizations(state).flatMap(({ id, connections: { sophos } }) =>
      sophos && isSophosRegionHost(sophos.host) && isSophosId(sophos.tenantId) ? [summary(id, sophos)] : []);
  }

  async connect({ organizationId, clientId, clientSecret }: ConnectSophosInput): Promise<SophosConnectionSummary> {
    const credentials = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new SophosApiError("refused", "Enter the Sophos Central client ID and secret.");
    }
    const result = await this.host.serialize(async () => {
      const before = this.active(await this.host.read(), organizationId);
      if (before.connections.sophos) throw new SophosApiError("refused", "Disconnect Sophos Central before connecting new credentials.");
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
    if (!record || !isSophosRegionHost(record.host) || !isSophosId(record.tenantId)) {
      throw new SophosApiError("refused", "Connect Sophos Central for this organization in Connections.");
    }
    const cached = this.clients.get(id);
    if (cached?.connectionId === record.connectionId) return { record, api: cached.api };
    const api = this.client(await this.credentialsFor(id));
    this.clients.set(id, { connectionId: record.connectionId, api });
    return { record, api };
  }

  async test(id: string): Promise<SophosConnectionSummary> {
    const result = await this.host.serialize(async () => {
      const state = await this.host.read();
      const { record } = await this.binding(state, id);
      this.clients.delete(id);
      const api = this.client(await this.credentialsFor(id));
      const identity = await api.identify();
      if (identity.tenantId !== record.tenantId || identity.host !== record.host) {
        throw new SophosApiError("refused", "The credential now identifies a different Sophos Central tenant or region. Disconnect and reconnect in Connections.");
      }
      const updated = { ...record, lastCheckedAt: this.host.clock().toISOString() };
      await this.update(state, id, updated);
      this.clients.set(id, { connectionId: record.connectionId, api });
      return summary(id, updated);
    });
    this.host.changed();
    return result;
  }

  async disconnect(id: string): Promise<void> {
    await this.host.serialize(async () => {
      const state = await this.host.read();
      this.active(state, id);
      await this.storage.remove(key(id));
      this.clients.delete(id);
      await this.update(state, id);
    });
    this.host.changed();
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
