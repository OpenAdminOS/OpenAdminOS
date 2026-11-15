// Guards the versioned interface. Two checks:
//
// 1. A compile-time check (run by `npm run typecheck`): a module and a host
//    written against interface version 1 must still type check. Removing or
//    renaming a member, or narrowing what a module may pass, breaks it.
// 2. A runtime check: the declarations emitted for `interface.ts` must match
//    `api/interface-v<version>.d.ts` exactly. Any change to the contract
//    fails here. A compatible change updates the snapshot in the same
//    commit; an incompatible one raises ENTERPRISE_INTERFACE_VERSION and adds
//    a new snapshot, and the loader then refuses modules built for the old one.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import * as enterprise from "./index.js";
import {
  ENTERPRISE_INTERFACE_VERSION,
  ENTERPRISE_IPC_PREFIX,
  type EnterpriseEntitlement,
  type EnterpriseHandle,
  type EnterpriseHost,
  type EnterpriseModule,
  type EnterpriseOrganization,
  type EnterpriseReadOnlyAgent,
  type EnterpriseResult,
  type EnterpriseSandbox,
  type EnterpriseSandboxAssignResult,
  type EnterpriseSandboxStatus,
  type EnterpriseSandboxSyncResult,
  type EnterpriseSandboxUnpairResult,
} from "./interface.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- 1. Compile-time: interface version 1 as a module author wrote it. ----

const v1Module: EnterpriseModule = {
  interfaceVersion: 1,
  activate(host: EnterpriseHost): EnterpriseHandle | undefined {
    const version: 1 = host.interfaceVersion;
    const entitlement: EnterpriseEntitlement = host.entitlement();
    const state: "active" | "grace" | "expired" = entitlement.state;
    const fields: [string, readonly string[], number, number, number] = [
      entitlement.licenseeId,
      entitlement.features,
      entitlement.notBefore,
      entitlement.expiresAt,
      entitlement.graceEndsAt,
    ];
    host.registerIpc("team.status", (input) => ({ input, version, state, count: fields.length }));
    host.registerIpc("team.ping", async () => undefined);
    host.registerSettingsSection({ id: "team", title: "Team", description: "Approvals and audit." });
    host.setStatusContribution({ label: "Team service", detail: "End-to-end encrypted." });
    host.setStatusContribution({ label: "Team service" });
    host.setStatusContribution(undefined);
    const pending: [Promise<unknown>, Promise<void>, Promise<void>, Promise<readonly string[]>] = [
      host.storage.get("team.id"),
      host.storage.set("team.id", { nested: [1, "two", null, true] }),
      host.storage.delete("team.id"),
      host.storage.keys(),
    ];
    void pending;
    host.log.info("activated", { features: 1, grace: false, licensee: "x" });
    host.log.warn("warn");
    host.log.error("error");
    const lent: [
      Promise<readonly EnterpriseOrganization[]>,
      Promise<readonly EnterpriseReadOnlyAgent[]>,
      Promise<readonly EnterpriseSandbox[]>,
      Promise<EnterpriseResult<EnterpriseSandbox>>,
      Promise<EnterpriseResult<EnterpriseSandboxSyncResult>>,
      Promise<EnterpriseResult<EnterpriseSandboxAssignResult>>,
      Promise<EnterpriseResult<EnterpriseSandboxUnpairResult>>,
      Promise<EnterpriseResult<EnterpriseSandboxStatus>>,
    ] = [
      host.organizations.list(),
      host.agents.readOnlyCatalog(),
      host.sandboxes.list(),
      host.sandboxes.pair({ address: "100.64.0.10:7443", code: "code", organizationId: "org-1" }),
      host.sandboxes.sync("mini-pc"),
      host.sandboxes.assign("mini-pc", [{ agentId: "find-inactive-devices", intervalSeconds: 86400 }]),
      host.sandboxes.unpair("mini-pc"),
      host.sandboxes.status("mini-pc"),
    ];
    void lent;
    return { deactivate: async () => undefined };
  },
};

// A host written against version 1 must still satisfy the interface.
const v1Host: EnterpriseHost = {
  interfaceVersion: 1,
  entitlement: () => ({ state: "active", licenseeId: "x", features: [], notBefore: 0, expiresAt: 1, graceEndsAt: 2 }),
  registerIpc: () => undefined,
  registerSettingsSection: () => undefined,
  setStatusContribution: () => undefined,
  storage: {
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
    keys: async () => [],
  },
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  organizations: { list: async () => [{ id: "org-1", name: "Contoso", tenantId: "t" }] },
  agents: { readOnlyCatalog: async () => [{ id: "a", name: "A", scopes: [], manifestSha256: "0".repeat(64) }] },
  sandboxes: {
    list: async () => [],
    pair: async () => ({ ok: false, error: { code: "x", message: "x" } }),
    sync: async () => ({ ok: false, error: { code: "x", message: "x" } }),
    assign: async () => ({ ok: true, value: { version: 1, assigned: [], shadowed: [], rolesNoLongerNeeded: [] } }),
    unpair: async () => ({ ok: true, value: { sandboxId: "x", sandboxConfirmed: true, rolesNoLongerNeeded: [], message: "x" } }),
    status: async () => ({ ok: false, error: { code: "x", message: "x" } }),
  },
};

// ---- 2. Runtime: the emitted declarations match the snapshot. ----

function emittedDeclarations(): string {
  const file = join(packageDir, "src", "interface.ts");
  const options: ts.CompilerOptions = {
    declaration: true,
    emitDeclarationOnly: true,
    removeComments: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  let output = "";
  host.writeFile = (name, text) => {
    if (name.endsWith("interface.d.ts")) output = text;
  };
  const program = ts.createProgram([file], options, host);
  const result = program.emit(undefined, undefined, undefined, true);
  assert.deepEqual(result.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
  return output.replace(/\r\n/g, "\n").trim();
}

describe("enterprise interface", () => {
  it("is version 1 with the fixed IPC prefix", () => {
    assert.equal(ENTERPRISE_INTERFACE_VERSION, 1);
    assert.equal(ENTERPRISE_IPC_PREFIX, "openadminos-enterprise:");
    assert.equal(v1Module.interfaceVersion, ENTERPRISE_INTERFACE_VERSION);
    assert.equal(v1Host.interfaceVersion, ENTERPRISE_INTERFACE_VERSION);
  });

  it("matches the declaration snapshot for its version", () => {
    const snapshotPath = join(packageDir, "api", `interface-v${ENTERPRISE_INTERFACE_VERSION}.d.ts`);
    const snapshot = readFileSync(snapshotPath, "utf8").replace(/\r\n/g, "\n").trim();
    const actual = emittedDeclarations();
    assert.equal(
      actual,
      snapshot,
      `The enterprise interface changed. Keep it compatible and update ${snapshotPath}, ` +
        "or raise ENTERPRISE_INTERFACE_VERSION and add a new snapshot.",
    );
  });

  it("keeps the version 1 limits", () => {
    // Modules are written against these bounds. Tightening one breaks
    // modules that rely on it, so it needs a new interface version.
    assert.deepEqual(
      { ...enterprise.ENTERPRISE_LIMITS },
      {
        maxIpcHandlers: 32,
        maxIpcInputBytes: 65536,
        maxIpcOutputBytes: 262144,
        maxJsonDepth: 16,
        maxSettingsSections: 8,
        maxStorageKeys: 256,
        maxStorageValueBytes: 65536,
        maxStorageBytes: 1048576,
        maxLabelLength: 80,
        maxTitleLength: 60,
        maxDetailLength: 300,
        maxLogMessageLength: 500,
        maxSandboxIdLength: 64,
        maxSandboxAddressLength: 64,
        maxPairingCodeLength: 64,
        maxOrganizationIdLength: 200,
        maxAssignmentEntries: 50,
        maxAgentIdLength: 200,
      },
    );
    assert.ok(Object.isFrozen(enterprise.ENTERPRISE_LIMITS));
  });

  it("keeps the version 1 licence limits", () => {
    // Licences issued by the team service must fit these. Tightening one
    // can refuse licences already issued.
    assert.deepEqual(
      { ...enterprise.LICENCE_LIMITS },
      { maxTokenLength: 4096, maxFeatures: 64, maxGraceSeconds: 31536000 },
    );
    assert.ok(Object.isFrozen(enterprise.LICENCE_LIMITS));
  });

  it("keeps the version 1 name and storage key patterns", () => {
    assert.equal(enterprise.ENTERPRISE_NAME_PATTERN.source, "^[a-z][a-z0-9-]{0,47}(?:\\.[a-z][a-z0-9-]{0,47}){0,3}$");
    assert.equal(enterprise.ENTERPRISE_NAME_PATTERN.flags, "");
    assert.equal(enterprise.ENTERPRISE_STORAGE_KEY_PATTERN.source, "^[a-z][a-z0-9._-]{0,63}$");
    assert.equal(enterprise.ENTERPRISE_STORAGE_KEY_PATTERN.flags, "");
    // Frozen, so module code cannot recompile the host's checks.
    assert.throws(() => (enterprise.ENTERPRISE_NAME_PATTERN as RegExp & { compile(p: string): RegExp }).compile(".*"), TypeError);
    assert.ok(enterprise.ENTERPRISE_NAME_PATTERN.test("team.status"));
  });

  it("keeps the package exports", () => {
    assert.deepEqual(Object.keys(enterprise).sort(), [
      "ENTERPRISE_INTERFACE_VERSION",
      "ENTERPRISE_IPC_PREFIX",
      "ENTERPRISE_LIMITS",
      "ENTERPRISE_NAME_PATTERN",
      "ENTERPRISE_STORAGE_KEY_PATTERN",
      "EnterpriseHostError",
      "EnterpriseInterfaceVersionError",
      "LICENCE_LIMITS",
      "LICENCE_PUBLIC_KEY_PEM",
      "LICENCE_SIGNING_CONTEXT",
      "checkJson",
      "createEnterpriseHost",
      "defaultEnterpriseModule",
      "enterpriseIpcChannel",
      "entitlementAt",
      "isEnterpriseModule",
      "verifyLicence",
    ]);
  });

  it("ships a no-op default module that implements the current version", () => {
    assert.ok(enterprise.isEnterpriseModule(enterprise.defaultEnterpriseModule));
    assert.equal(enterprise.defaultEnterpriseModule.interfaceVersion, ENTERPRISE_INTERFACE_VERSION);
    assert.equal(enterprise.defaultEnterpriseModule.activate(v1Host), undefined);
    assert.ok(Object.isFrozen(enterprise.defaultEnterpriseModule));
  });

  it("names a version mismatch", () => {
    const error = new enterprise.EnterpriseInterfaceVersionError(2);
    assert.equal(error.name, "EnterpriseInterfaceVersionError");
    assert.equal(error.expected, 1);
    assert.equal(error.received, 2);
    assert.match(error.message, /interface version 2.*implements version 1/);
  });
});
