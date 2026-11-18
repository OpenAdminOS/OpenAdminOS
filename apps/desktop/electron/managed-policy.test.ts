import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  MANAGED_POLICY_KEYS,
  MANAGED_POLICY_SETTING_KEYS,
  providerCatalog,
  type ManagedPolicyStatus,
} from "@openadminos/agent-sdk";

import { MCP_CATALOG } from "./mcp/catalog.js";
import {
  JsonSyntaxError,
  decodePolicyText,
  describeManagedPolicyIssue,
  loadManagedPolicy,
  managedPolicyFingerprint,
  managedPolicyPaths,
  parseJsonDocument,
  parsePolicyFile,
  resolveManagedPolicyPaths,
} from "./managed-policy.js";

const catalog = {
  providerIds: providerCatalog.map((provider) => provider.id),
  publicReferenceIds: MCP_CATALOG.map((entry) => entry.id),
};
const MACHINE = "/Library/Application Support/OpenAdminOS/policy.json";
const USER = "/Users/admin/Library/Application Support/OpenAdminOS/policy.json";
const paths = [
  { scope: "machine" as const, path: MACHINE },
  { scope: "user" as const, path: USER },
];

async function load(files: Partial<Record<string, string | Uint8Array>>): Promise<ManagedPolicyStatus | undefined> {
  return loadManagedPolicy({
    ...catalog,
    paths,
    read: async (path) => {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return typeof content === "string" ? new TextEncoder().encode(content) : content;
    },
  });
}

describe("policy file paths", () => {
  it("documents a machine and a user path per OS", () => {
    assert.deepEqual(managedPolicyPaths({ platform: "darwin", env: {}, home: "/Users/admin" }), [
      { scope: "machine", path: MACHINE },
      { scope: "user", path: USER },
    ]);
    assert.deepEqual(
      managedPolicyPaths({
        platform: "win32",
        env: { ProgramData: "C:\\ProgramData", APPDATA: "C:\\Users\\admin\\AppData\\Roaming" },
        home: "C:\\Users\\admin",
      }),
      [
        { scope: "machine", path: "C:\\ProgramData\\OpenAdminOS\\policy.json" },
        { scope: "user", path: "C:\\Users\\admin\\AppData\\Roaming\\OpenAdminOS\\policy.json" },
      ],
    );
    assert.deepEqual(managedPolicyPaths({ platform: "linux", env: {}, home: "/home/admin" }), [
      { scope: "machine", path: "/etc/openadminos/policy.json" },
      { scope: "user", path: "/home/admin/.config/openadminos/policy.json" },
    ]);
  });

  it("lets only unpackaged builds point the paths elsewhere", () => {
    const env = { OPENADMINOS_POLICY_MACHINE_PATH: "/tmp/machine.json", OPENADMINOS_POLICY_USER_PATH: "/tmp/user.json" };
    assert.deepEqual(
      resolveManagedPolicyPaths({ packaged: false, env, platform: "linux", home: "/home/admin" }).map((entry) => entry.path),
      ["/tmp/machine.json", "/tmp/user.json"],
    );
    assert.deepEqual(
      resolveManagedPolicyPaths({ packaged: true, env, platform: "linux", home: "/home/admin" }).map((entry) => entry.path),
      ["/etc/openadminos/policy.json", "/home/admin/.config/openadminos/policy.json"],
    );
  });
});

describe("policy parsing", () => {
  it("reads every key of a valid file", async () => {
    const policy = await load({
      [MACHINE]: JSON.stringify({
        $schema: "https://openadminos.com/schemas/policy/v1.schema.json",
        version: 1,
        allowedProviders: ["ollama", "lm-studio"],
        defaultProvider: "ollama",
        defaultModel: "llama3.1:8b",
        allowedPublicReferences: ["microsoft-learn"],
        appRegistration: { clientId: "AAAAAAAA-1111-2222-3333-444444444444", tenantId: "contoso.onmicrosoft.com", label: "Contoso IT" },
        skipFirstRunScan: true,
        novaVoiceModes: ["local"],
        novaInstructions: "Answer in short sentences.",
        novaCapabilities: { webSearch: false, connectorSends: ["outlook"] },
        novaMemory: "off",
      }),
    });
    assert.ok(policy);
    assert.deepEqual(policy.issues, []);
    assert.deepEqual(policy.values, {
      allowedProviders: ["ollama", "lm-studio"],
      defaultProvider: "ollama",
      defaultModel: "llama3.1:8b",
      allowedPublicReferences: ["microsoft-learn"],
      appRegistration: { clientId: "aaaaaaaa-1111-2222-3333-444444444444", tenantId: "contoso.onmicrosoft.com", label: "Contoso IT" },
      skipFirstRunScan: true,
      novaVoiceModes: ["local"],
      novaInstructions: "Answer in short sentences.",
      novaCapabilities: { webSearch: false, connectorSends: ["outlook"] },
      novaMemory: "off",
    });
    // No lock list: every key the file sets is locked.
    assert.deepEqual(policy.locked, [...MANAGED_POLICY_SETTING_KEYS]);
    assert.deepEqual(policy.files, [
      { scope: "machine", path: MACHINE, found: true },
      { scope: "user", path: USER, found: false },
    ]);
  });

  it("reports a Nova ability set twice and uses the more restrictive value, so a repeat cannot widen the policy", async () => {
    const policy = await load({ [MACHINE]: '{ "novaCapabilities": { "webSearch": false, "webSearch": true, "connectorSends": ["outlook", "teams"], "connectorSends": true } }' });
    assert.ok(policy);
    assert.deepEqual(policy.values.novaCapabilities, { webSearch: false, connectorSends: ["outlook", "teams"] });
    assert.equal(policy.issues.filter((entry) => /appears more than once/.test(entry.message)).length, 2, JSON.stringify(policy.issues));
  });

  it("returns no policy when neither file exists", async () => {
    assert.equal(await load({}), undefined);
  });

  it("locks only what lock names, and nothing with an empty list", async () => {
    const partial = await load({ [MACHINE]: JSON.stringify({ defaultProvider: "ollama", defaultModel: "llama3.1:8b", lock: ["defaultProvider"] }) });
    assert.deepEqual(partial?.locked, ["defaultProvider"]);
    const none = await load({ [MACHINE]: JSON.stringify({ defaultProvider: "ollama", lock: [] }) });
    assert.deepEqual(none?.locked, []);
  });

  it("keeps an empty public reference list, which allows none", async () => {
    const policy = await load({ [MACHINE]: JSON.stringify({ allowedPublicReferences: [] }) });
    assert.deepEqual(policy?.values.allowedPublicReferences, []);
  });

  it("reads UTF-8 with a byte order mark and UTF-16 as Windows PowerShell writes it", async () => {
    const text = JSON.stringify({ allowedProviders: ["ollama"] });
    assert.equal(decodePolicyText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)])), text);
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let index = 0; index < text.length; index += 1) utf16[2 + index * 2] = text.charCodeAt(index);
    const policy = await load({ [MACHINE]: utf16 });
    assert.deepEqual(policy?.values.allowedProviders, ["ollama"]);
    assert.deepEqual(policy?.issues, []);
  });
});

describe("policy precedence", () => {
  it("lets the machine file win over the user file, key by key", async () => {
    const policy = await load({
      [MACHINE]: JSON.stringify({ allowedProviders: ["ollama"], lock: [] }),
      [USER]: JSON.stringify({ allowedProviders: ["ollama", "anthropic"], defaultProvider: "ollama", defaultModel: "qwen3:8b" }),
    });
    assert.ok(policy);
    assert.deepEqual(policy.values.allowedProviders, ["ollama"]);
    assert.equal(policy.values.defaultProvider, "ollama");
    assert.equal(policy.values.defaultModel, "qwen3:8b");
    assert.deepEqual(policy.sources, { allowedProviders: "machine", defaultProvider: "user", defaultModel: "user" });
    // Each key is locked by the file it came from.
    assert.deepEqual(policy.locked, ["defaultProvider", "defaultModel"]);
  });

  it("uses the user file's key when the machine file's is invalid", async () => {
    const policy = await load({
      [MACHINE]: JSON.stringify({ defaultProvider: "olama" }),
      [USER]: JSON.stringify({ defaultProvider: "lm-studio" }),
    });
    assert.equal(policy?.values.defaultProvider, "lm-studio");
    assert.equal(policy?.sources.defaultProvider, "user");
    assert.equal(policy?.issues.length, 1);
  });

  it("drops a default provider the allowed list excludes, and the model that needs it", async () => {
    const text = '{\n  "allowedProviders": ["ollama"],\n  "defaultProvider": "anthropic",\n  "defaultModel": "sonnet"\n}\n';
    const policy = await load({ [MACHINE]: text });
    assert.ok(policy);
    assert.deepEqual(policy.values, { allowedProviders: ["ollama"] });
    assert.deepEqual(policy.locked, ["allowedProviders"]);
    assert.deepEqual(
      policy.issues.map((entry) => [entry.key, entry.line]),
      [
        ["defaultProvider", 3],
        ["defaultModel", 4],
      ],
    );
  });

  it("fingerprints values, sources and locks", async () => {
    const one = (await load({ [MACHINE]: JSON.stringify({ allowedProviders: ["ollama"] }) }))!;
    const same = (await load({ [MACHINE]: JSON.stringify({ allowedProviders: ["ollama"] }) }))!;
    const unlocked = (await load({ [MACHINE]: JSON.stringify({ allowedProviders: ["ollama"], lock: [] }) }))!;
    const fromUser = (await load({ [USER]: JSON.stringify({ allowedProviders: ["ollama"] }) }))!;
    assert.equal(managedPolicyFingerprint(one), managedPolicyFingerprint(same));
    assert.notEqual(managedPolicyFingerprint(one), managedPolicyFingerprint(unlocked));
    assert.notEqual(managedPolicyFingerprint(one), managedPolicyFingerprint(fromUser));
  });
});

describe("policy problems", () => {
  it("names the line of a JSON syntax error and applies nothing from that file", async () => {
    const text = '{\n  "allowedProviders": ["ollama"],\n  "defaultProvider": "ollama",\n}\n';
    const policy = await load({ [MACHINE]: text, [USER]: JSON.stringify({ skipFirstRunScan: true }) });
    assert.ok(policy);
    assert.deepEqual(policy.values, { skipFirstRunScan: true });
    assert.equal(policy.issues.length, 1);
    const [issue] = policy.issues;
    assert.equal(issue!.path, MACHINE);
    assert.equal(issue!.line, 4);
    assert.match(issue!.message, /not valid JSON\. Remove the comma before `\}`\. No setting from this file is applied\./);
    assert.equal(describeManagedPolicyIssue(issue!), `${MACHINE}, line 4: ${issue!.message}`);
  });

  it("reports comments, single quotes, an unclosed string and a Windows path without escapes", () => {
    const cases: Array<[string, number, RegExp]> = [
      ['{\n  // IT\n  "version": 1\n}', 2, /Comments are not allowed/],
      ["{\n  'version': 1\n}", 2, /Expected a key in double quotes/],
      ['{\n  "defaultModel": "llama\n}', 2, /not closed/],
      ['{\n  "x": "C:\\Tools"\n}', 2, /invalid escape/],
      ['[1, 2,]', 1, /Remove the comma before `\]`/],
    ];
    for (const [text, line, message] of cases) {
      assert.throws(
        () => parseJsonDocument(text),
        (error: unknown) => error instanceof JsonSyntaxError && error.position.line === line && message.test(error.message),
        text,
      );
    }
  });

  it("reports unknown keys and wrong types with their lines, and applies the valid keys", async () => {
    const text = [
      "{",
      '  "allowedProviders": ["ollama", "olama", 7],',
      '  "AllowedPublicReferences": [],',
      '  "telemetry": false,',
      '  "skipFirstRunScan": "yes",',
      '  "appRegistration": { "clientId": "not-a-guid" },',
      '  "lock": ["defaultProvider", "everything"],',
      '  "version": 2',
      "}",
    ].join("\n");
    const policy = await load({ [MACHINE]: text });
    assert.ok(policy);
    // A typo allows less, never more: the valid entries stay in force.
    assert.deepEqual(policy.values, { allowedProviders: ["ollama"] });
    const lines = policy.issues.map((entry) => [entry.line, entry.key]);
    assert.deepEqual(lines, [
      [2, "allowedProviders"],
      [2, "allowedProviders"],
      [3, "AllowedPublicReferences"],
      [4, "telemetry"],
      [5, "skipFirstRunScan"],
      [6, "appRegistration"],
      [7, "lock"],
      [8, "version"],
    ]);
    assert.match(policy.issues[0]!.message, /lists "olama", which is not a provider id/);
    assert.match(policy.issues[2]!.message, /Keys are case-sensitive: use "allowedPublicReferences"/);
    assert.match(policy.issues[3]!.message, /"telemetry" is not a policy key/);
    // The lock list only names "defaultProvider", which the file does not set validly.
    assert.deepEqual(policy.locked, []);
  });

  it("reports duplicate keys, an empty file, a non-object and an unreadable file", async () => {
    const duplicate = parsePolicyFile("machine", MACHINE, '{\n  "skipFirstRunScan": true,\n  "skipFirstRunScan": false\n}', catalog);
    assert.equal(duplicate.values.skipFirstRunScan, false);
    assert.equal(duplicate.issues[0]!.line, 3);
    assert.match(parsePolicyFile("machine", MACHINE, "  \n", catalog).issues[0]!.message, /The file is empty/);
    assert.match(parsePolicyFile("machine", MACHINE, '["ollama"]', catalog).issues[0]!.message, /must be a JSON object/);

    const unreadable = await loadManagedPolicy({
      ...catalog,
      paths,
      read: async (path) => {
        if (path === MACHINE) throw Object.assign(new Error("denied"), { code: "EACCES" });
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });
    assert.ok(unreadable);
    assert.deepEqual(unreadable.values, {});
    assert.match(unreadable.issues[0]!.message, /no permission to read it/);
    assert.equal(unreadable.files[0]!.found, true);
  });

  it("refuses a file over 64 KB", async () => {
    const policy = await load({ [MACHINE]: `{"$schema": "${"x".repeat(70 * 1024)}"}` });
    assert.match(policy!.issues[0]!.message, /larger than 64 KB/);
  });
});

describe("policy schema", () => {
  it("matches the keys and ids the app reads", async () => {
    const schema = JSON.parse(await readFile(new URL("../../../schemas/policy.schema.json", import.meta.url), "utf8")) as {
      $id: string;
      additionalProperties: boolean;
      properties: Record<string, unknown>;
      $defs: Record<string, { enum: string[] }>;
    };
    assert.match(schema.$id, /\/policy\/v1\.schema\.json$/);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), [...MANAGED_POLICY_KEYS].sort());
    assert.deepEqual(schema.$defs.providerId!.enum, catalog.providerIds);
    assert.deepEqual(schema.$defs.publicReferenceId!.enum, catalog.publicReferenceIds);
    assert.deepEqual(schema.$defs.settingKey!.enum, [...MANAGED_POLICY_SETTING_KEYS]);
  });
});
