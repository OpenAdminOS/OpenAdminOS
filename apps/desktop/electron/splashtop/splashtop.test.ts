import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  splashtopConfirmationPhrase,
  type OrganizationRecord,
  type RunRecord,
  type SplashtopReadToolName,
} from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import type { ConfigurationAuditEvent } from "../configuration-audit.js";
import { AppStateStore } from "../state.js";
import type { SplashtopChatContext } from "../intune-chat/tools.js";
import { normalizeSplashtopToken, SplashtopApi, SplashtopApiError, splashtopTokenProblem, type SplashtopFetch } from "./api.js";
import { buildSplashtopChangePlan, isPlannedSplashtopRequest, SPLASHTOP_WRITE_KIND, validateSplashtopChangeRequest } from "./plans.js";
import { runSplashtopRead, SPLASHTOP_READ_TOOLS } from "./reads.js";
import { MemorySplashtopTokenStore } from "./token-store.js";

const TOKEN_A = "token-for-woodgrove-0123456789";
const TOKEN_B = "token-for-fabrikam-9876543210";
const TEAM = 11125;

interface Call {
  url: URL;
  init: RequestInit;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function ok(data: unknown): Response {
  return json(200, { result: 20200, commands: {}, messages: [], data });
}

function recorder(route: (call: Call) => Response | Promise<Response>): { calls: Call[]; fetch: SplashtopFetch } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return route({ url, init });
    },
  };
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body ?? "{}")) as Record<string, unknown>;
}

function authOf(call: Call): string {
  return (call.init.headers as Record<string, string>).authorization ?? "";
}

const BASIC_INFO = {
  name: "Woodgrove Admin",
  email: "admin@woodgrove.example",
  scopes: {
    inventory: { team_id: TEAM },
    logs: { stb_team_id: TEAM },
    team_users: { stb_team_id: TEAM },
    team_computers: { stb_team_id: TEAM },
    team_groups: { stb_team_id: TEAM },
  },
};

const COMPUTERS = [
  { id: 101, name: "DESK-01", host_name: "desk-01", online_status: 1 },
  { id: 102, name: "DESK-02", host_name: "desk-02", online_status: 0, last_online: "2026-10-01 10:00:00" },
  { id: 103, name: "LAPTOP-03", host_name: "laptop-03", online_status: 1 },
];

/** A Splashtop team as the Open API answers it, for the paths OpenAdminOS uses. */
function splashtopTeam(call: Call): Response {
  const path = call.url.pathname;
  if (path === "/api/open/v1/users/basic_info") return ok(BASIC_INFO);
  if (path === `/api/open/v1/teams/${TEAM}/computers` && call.init.method === "GET") {
    const ids = call.url.searchParams.get("ids");
    if (!ids) return ok(COMPUTERS.map(({ id, name }) => ({ id, name })));
    const wanted = ids.split(",").map(Number);
    return ok(COMPUTERS.filter((computer) => wanted.includes(computer.id)).map((computer) => ({ ...computer, os: "Windows 11", version: "3.7.4" })));
  }
  if (path === `/api/open/v1/teams/${TEAM}/users`) {
    const users = [
      { id: 1, email: "owner@woodgrove.example", role: "owner", status: "enabled" },
      { id: 2, email: "tech@woodgrove.example", role: "member", status: "enabled" },
      { id: 3, email: "old@woodgrove.example", role: "member", status: "disabled" },
    ];
    const ids = call.url.searchParams.get("ids");
    return ok(ids ? users.filter((user) => ids.split(",").map(Number).includes(user.id)).map((user) => ({ ...user, member_name: user.email })) : users);
  }
  if (path === "/api/open/v1/teams/logs/active_sessions") {
    return ok({ items: [
      { id: 900, src_user_email: "tech@woodgrove.example", srs_name: "DESK-01", created_at: "2026-11-09 09:00:00", can_force_disconnect: true },
      { id: 901, src_user_email: "tech@woodgrove.example", srs_name: "DESK-02", can_force_disconnect: false },
    ], total_pages: 1, total_entries: 2 });
  }
  if (path === `/api/open/v1/teams/${TEAM}/emm_policies`) return ok([{ id: 1, name: "Default policy" }]);
  if (call.init.method !== "GET" && path.startsWith(`/api/open/v1/teams/`)) return ok({});
  return json(404, { result: 40400, messages: ["not found"] });
}

describe("Splashtop API client", () => {
  it("sends the token only to the chosen region's host, as a Bearer header, never following a redirect", async () => {
    for (const [region, host] of [["global", "webapi.splashtop.com"], ["eu", "webapi.splashtop.eu"], ["oceania", "webapi.splashtop.nr"]] as const) {
      const { calls, fetch } = recorder(() => ok(BASIC_INFO));
      const api = new SplashtopApi({ region, token: TOKEN_A, fetch });
      const info = await api.basicInfo();
      assert.equal(info.teamId, TEAM);
      assert.deepEqual(info.tokenScopes, ["inventory", "logs", "team_computers", "team_groups", "team_users"]);
      assert.equal(info.account, "admin@woodgrove.example");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url.protocol, "https:");
      assert.equal(calls[0]!.url.host, host);
      assert.equal(calls[0]!.url.pathname, "/api/open/v1/users/basic_info");
      assert.equal(authOf(calls[0]!), `Bearer ${TOKEN_A}`);
      assert.equal(calls[0]!.init.redirect, "manual");
    }
  });

  it("refuses a path outside the Open API before anything is sent", async () => {
    const { calls, fetch } = recorder(() => ok({}));
    const api = new SplashtopApi({ region: "eu", token: TOKEN_A, fetch });
    for (const path of ["/api/other", "/api/open/v1/../../x", "/api/open/v1/teams/1/computers?x=1", "/api/open/v1//teams", "https://evil.example/api/open/v1/x"]) {
      await assert.rejects(api.request({ method: "GET", path }), (error: SplashtopApiError) => {
        assert.equal(error.code, "refused");
        assert.equal(error.sent, false);
        return true;
      });
    }
    assert.equal(calls.length, 0);
  });

  it("gives a designed message for 401, 403, 429, 404, 5xx, redirects, failures and malformed answers", async () => {
    const cases: Array<[Response | Error, string, RegExp]> = [
      [json(401, {}), "unauthorized", /did not accept the API token \(HTTP 401\) at webapi\.splashtop\.eu\..*another region.*Rotate token/],
      [json(403, { data: { error: "insufficient scope" } }), "forbidden", /\(HTTP 403\) at webapi\.splashtop\.eu\..*Splashtop Enterprise.*Team Owner or Super Admin.*insufficient scope/],
      [json(429, {}, { "retry-after": "30" }), "rate-limited", /HTTP 429\)\. Wait 30 seconds/],
      [json(404, {}), "not-found", /HTTP 404/],
      [json(503, {}), "server-error", /answered HTTP 503\. Try again later/],
      [new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }), "redirect", /never follows a redirect/],
      [new TypeError("fetch failed"), "unreachable", /could not be reached at webapi\.splashtop\.eu/],
      [new Response("<html>", { status: 200 }), "malformed", /could not read/],
      [json(200, { result: 40001, messages: ["Bad team"] }), "bad-request", /result 40001.*Bad team/],
    ];
    for (const [answer, code, message] of cases) {
      const api = new SplashtopApi({
        region: "eu",
        token: TOKEN_A,
        fetch: async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      });
      await assert.rejects(api.request({ method: "GET", path: "/api/open/v1/users/basic_info" }), (error: SplashtopApiError) => {
        assert.equal(error.code, code, `code for ${code}`);
        assert.match(error.message, message);
        assert.doesNotMatch(error.message, new RegExp(TOKEN_A));
        return true;
      });
    }
  });

  it("stops at the deadline with a designed message", async () => {
    const api = new SplashtopApi({
      region: "global",
      token: TOKEN_A,
      timeoutMs: 20,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    await assert.rejects(api.basicInfo(), (error: SplashtopApiError) => error.code === "timeout" && /within 1 seconds|did not answer within/.test(error.message));
  });

  it("explains a token that names no team as a plan or role limit", async () => {
    const api = new SplashtopApi({ region: "global", token: TOKEN_A, fetch: async () => ok({ email: "x@y.example", scopes: {} }) });
    await assert.rejects(api.basicInfo(), (error: SplashtopApiError) => error.code === "forbidden" && /Splashtop Enterprise/.test(error.message));
  });

  it("normalizes a pasted token and refuses one that cannot be a token", () => {
    assert.equal(normalizeSplashtopToken("  Bearer abcdefghij  "), "abcdefghij");
    assert.equal(splashtopTokenProblem("abcdefghij"), undefined);
    assert.match(splashtopTokenProblem("") ?? "", /Paste the API token/);
    assert.match(splashtopTokenProblem("has spaces in it") ?? "", /does not look like/);
  });
});

describe("Splashtop read tools", () => {
  const read = async (tool: SplashtopReadToolName, params: unknown, route: (call: Call) => Response = splashtopTeam) => {
    const { calls, fetch } = recorder(route);
    const api = new SplashtopApi({ region: "global", token: TOKEN_A, fetch });
    const result = await runSplashtopRead({ api, teamId: TEAM, now: () => new Date("2026-11-09T12:00:00Z") }, tool, params);
    return { result, calls };
  };

  it("offers eight read tools", () => {
    assert.deepEqual(SPLASHTOP_READ_TOOLS.map((tool) => tool.name), [
      "splashtop_list_computers",
      "splashtop_get_inventory",
      "splashtop_list_users",
      "splashtop_list_groups",
      "splashtop_list_sessions",
      "splashtop_list_team_history",
      "splashtop_list_policies",
      "splashtop_list_vulnerabilities",
    ]);
  });

  it("lists computers a page at a time, with details for that page only", async () => {
    const { result, calls } = await read("splashtop_list_computers", { limit: 2 });
    assert.deepEqual(result.records.map((record) => record.id), [101, 102]);
    assert.equal(result.records[0]!.os, "Windows 11");
    assert.deepEqual(result.page, { offset: 0, limit: 2, total: 3, next: { offset: 2, limit: 2 } });
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url.searchParams.get("ids"), "101,102");
    const second = await read("splashtop_list_computers", { offset: 2, limit: 2 });
    assert.deepEqual(second.result.records.map((record) => record.id), [103]);
    assert.equal(second.result.page.next, undefined);
  });

  it("filters computers by online state and name", async () => {
    const { result, calls } = await read("splashtop_list_computers", { online: "offline", nameContains: "desk-02" });
    assert.equal(calls[0]!.url.searchParams.get("online_status"), "0");
    assert.deepEqual(result.records.map((record) => record.name), ["DESK-02"]);
  });

  it("reads inventory for named computers with a POST body", async () => {
    const { calls } = await read("splashtop_get_inventory", { computerIds: [101, 102], software: true }, () => ok([{ id: "101", system: {} }]));
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal(calls[0]!.url.pathname, `/api/open/v1/teams/${TEAM}/inventory`);
    assert.deepEqual(bodyOf(calls[0]!), { ids: ["101", "102"], fields: ["system", "hardware", "software"] });
  });

  it("lists users and groups with pagination", async () => {
    const users = await read("splashtop_list_users", { status: "enabled", limit: 1 });
    assert.equal(users.calls[0]!.url.searchParams.get("status"), "enabled");
    assert.equal(users.result.records.length, 1);
    assert.deepEqual(users.result.page.next, { offset: 1, limit: 1 });
    const groups = await read("splashtop_list_groups", { type: "computer" }, () => ok([{ id: 7, name: "Kiosks", group_type: "computer", computers_count: 4, secret: "x" }]));
    assert.equal(groups.calls[0]!.url.searchParams.get("group_type"), "computer");
    assert.deepEqual(groups.result.records, [{ id: 7, name: "Kiosks", group_type: "computer", computers_count: 4 }]);
  });

  it("reads active and finished sessions with Splashtop's own pages", async () => {
    const finished = await read("splashtop_list_sessions", { days: 30, page: 2 }, () => ok({ items: [{ id: 5 }], total_pages: 3, total_entries: 120 }));
    assert.equal(finished.calls[0]!.url.pathname, "/api/open/v1/teams/logs/closed_sessions");
    assert.deepEqual({ ...bodyOf(finished.calls[0]!), fields: undefined }, { team_id: TEAM, date_range: "30", page: "2", per_page_size: "50", fields: undefined });
    assert.deepEqual(finished.result.page, { page: 2, total: 120, totalPages: 3, next: { page: 3 } });
    const active = await read("splashtop_list_sessions", { state: "active" });
    assert.equal(active.calls[0]!.url.pathname, "/api/open/v1/teams/logs/active_sessions");
  });

  it("reads team history between UTC times", async () => {
    const { calls } = await read("splashtop_list_team_history", { days: 2 }, () => ok({ items: [], total_pages: 1 }));
    assert.equal(calls[0]!.url.pathname, "/api/open/v1/teams/logs/histories");
    assert.equal(calls[0]!.url.searchParams.get("team_id"), String(TEAM));
    assert.equal(calls[0]!.url.searchParams.get("start_time"), "2026-11-07 12:00:00");
    assert.equal(calls[0]!.url.searchParams.get("end_time"), "2026-11-09 12:00:00");
  });

  it("reads policies and vulnerabilities", async () => {
    const policies = await read("splashtop_list_policies", {}, () => ok([{ id: 1, name: "Default" }]));
    assert.equal(policies.calls[0]!.url.pathname, `/api/open/v1/teams/${TEAM}/emm_policies`);
    const cves = await read("splashtop_list_vulnerabilities", { inCisaKev: true, orderBy: "cvss" }, () => json(200, {
      result: "success",
      data: { team_cves: [{ id: 1, cve_name: "CVE-2025-21418", cvss: 7.8, in_cisa_kev: true, ai_summary: "long text" }], pagination: { current_page: 1, total_pages: 2, total_count: 60 } },
    }));
    assert.equal(cves.calls[0]!.url.searchParams.get("in_cisa_kev"), "true");
    assert.equal(cves.calls[0]!.url.searchParams.get("order"), "desc");
    assert.deepEqual(cves.result.records, [{ id: 1, cve_name: "CVE-2025-21418", cvss: 7.8, in_cisa_kev: true }]);
    assert.deepEqual(cves.result.page.next, { page: 2 });
  });

  it("refuses bad params before anything is sent", async () => {
    for (const [tool, params] of [
      ["splashtop_list_computers", { limit: 500 }],
      ["splashtop_list_users", { status: "everyone" }],
      ["splashtop_get_inventory", { computerIds: [] }],
      ["splashtop_list_sessions", { days: 365 }],
      ["splashtop_list_computers", { nameContains: "x".repeat(65) }],
    ] as const) {
      const { calls, fetch } = recorder(() => ok([]));
      const api = new SplashtopApi({ region: "global", token: TOKEN_A, fetch });
      await assert.rejects(runSplashtopRead({ api, teamId: TEAM }, tool, params), (error: SplashtopApiError) => error.code === "refused" && /Nothing was sent/.test(error.message));
      assert.equal(calls.length, 0, tool);
    }
  });
});

describe("Splashtop change plans", () => {
  const plan = async (request: unknown) => {
    const { calls, fetch } = recorder(splashtopTeam);
    const api = new SplashtopApi({ region: "global", token: TOKEN_A, fetch });
    const built = await buildSplashtopChangePlan({ api, teamId: TEAM, teamLabel: "Woodgrove" }, validateSplashtopChangeRequest(request));
    return { built, calls };
  };

  it("reboots computers, one destructive action each, with a typed phrase", async () => {
    const { built, calls } = await plan({ kind: "reboot-computers", targetIds: [101, 102] });
    assert.equal(built.confirmationPhrase, "REBOOT 2 COMPUTERS");
    assert.deepEqual(built.actions.map((action) => action.label), ["Reboot DESK-01", "Reboot DESK-02"]);
    assert.ok(built.actions.every((action) => action.severity === "destructive" && action.kind === SPLASHTOP_WRITE_KIND));
    assert.deepEqual(built.actions[0]!.request, { method: "POST", path: `/api/open/v1/teams/${TEAM}/computers/reboot`, body: { server_ids: [101], reboot_option: "normal_reboot" } });
    assert.match(built.actions[1]!.description ?? "", /offline, last online 2026-10-01/);
    // Planning only reads; nothing is changed.
    assert.ok(calls.every((call) => call.init.method === "GET"));
  });

  it("deletes computers, disables users and ends sessions with their phrases", async () => {
    const deleted = await plan({ kind: "delete-computers", targetIds: [103] });
    assert.equal(deleted.built.confirmationPhrase, "DELETE 1 COMPUTER");
    assert.deepEqual(deleted.built.actions[0]!.request, { method: "DELETE", path: `/api/open/v1/teams/${TEAM}/computers/103` });
    const disabled = await plan({ kind: "disable-users", targetIds: [2] });
    assert.equal(disabled.built.confirmationPhrase, "DISABLE 1 USER");
    assert.deepEqual(disabled.built.actions[0]!.request, { method: "PATCH", path: `/api/open/v1/teams/${TEAM}/users/2/change_status`, body: { status: "disabled" } });
    assert.match(disabled.built.actions[0]!.description ?? "", /Status: enabled -> disabled/);
    const ended = await plan({ kind: "end-sessions", targetIds: [900] });
    assert.equal(ended.built.confirmationPhrase, "END 1 SESSION");
    assert.deepEqual(ended.built.actions[0]!.request, { method: "POST", path: "/api/open/v1/teams/logs/active_sessions/900/disconnect" });
  });

  it("renames computers as a non-destructive change that shows the old and new name", async () => {
    const { built } = await plan({ kind: "rename-computers", targetIds: [101], names: { "101": "FRONT-DESK" } });
    assert.equal(built.confirmationPhrase, "RENAME 1 COMPUTER");
    assert.equal(built.actions[0]!.severity, "default");
    assert.match(built.actions[0]!.description ?? "", /Name: DESK-01 -> FRONT-DESK/);
    assert.deepEqual(built.actions[0]!.request?.body, { name: "FRONT-DESK" });
  });

  it("refuses targets that are gone, already changed or cannot be changed", async () => {
    await assert.rejects(plan({ kind: "reboot-computers", targetIds: [999] }), /no computer with id 999.*Nothing was planned/);
    await assert.rejects(plan({ kind: "disable-users", targetIds: [1] }), /team owner/);
    await assert.rejects(plan({ kind: "disable-users", targetIds: [3] }), /already disabled/);
    await assert.rejects(plan({ kind: "end-sessions", targetIds: [901] }), /cannot be ended/);
    await assert.rejects(plan({ kind: "rename-computers", targetIds: [101], names: { "101": "DESK-01" } }), /already named/);
  });

  it("validates the request shape before reading anything", () => {
    assert.throws(() => validateSplashtopChangeRequest({ kind: "wipe-computers", targetIds: [1] }), /must be one of/);
    assert.throws(() => validateSplashtopChangeRequest({ kind: "reboot-computers", targetIds: [] }), /at least one/);
    assert.throws(() => validateSplashtopChangeRequest({ kind: "reboot-computers", targetIds: Array.from({ length: 51 }, (_, i) => i + 1) }), /at most 50/);
    assert.throws(() => validateSplashtopChangeRequest({ kind: "reboot-computers", targetIds: [-1] }), /whole positive/);
    assert.throws(() => validateSplashtopChangeRequest({ kind: "rename-computers", targetIds: [1], names: { "1": "bad:name" } }), /cannot contain/);
    assert.throws(() => validateSplashtopChangeRequest({ kind: "rename-computers", targetIds: [1], names: {} }), /new name/);
    assert.throws(() => validateSplashtopChangeRequest({ kind: "reboot-computers", targetIds: [1], rebootOption: "shutdown" }), /rebootOption/);
  });

  it("phrases count the targets", () => {
    assert.equal(splashtopConfirmationPhrase("reboot-computers", 12), "REBOOT 12 COMPUTERS");
    assert.equal(splashtopConfirmationPhrase("end-sessions", 3), "END 3 SESSIONS");
  });

  it("allows only planned request kinds for the connection's own team at apply", () => {
    const action = (method: string, path: string) => ({ id: "a", kind: SPLASHTOP_WRITE_KIND, label: "x", request: { method: method as "POST", path } });
    assert.equal(isPlannedSplashtopRequest(action("POST", `/api/open/v1/teams/${TEAM}/computers/reboot`), TEAM), true);
    assert.equal(isPlannedSplashtopRequest(action("POST", "/api/open/v1/teams/999/computers/reboot"), TEAM), false);
    assert.equal(isPlannedSplashtopRequest(action("DELETE", `/api/open/v1/teams/${TEAM}/users/2`), TEAM), false);
    assert.equal(isPlannedSplashtopRequest(action("PATCH", `/api/open/v1/teams/${TEAM}/users/2/change_role`), TEAM), false);
    assert.equal(isPlannedSplashtopRequest({ ...action("POST", `/api/open/v1/teams/${TEAM}/computers/reboot`), kind: "graph-write" }, TEAM), false);
  });
});

const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };

const woodgrove = {
  id: "11111111-1111-1111-1111-111111111111",
  displayName: "Woodgrove Bank",
  username: "admin@woodgrove.example",
  homeAccountId: "home-woodgrove",
  addedAt: "2026-09-01T08:00:00.000Z",
  connectionId: "connection-woodgrove",
  appRegistration: { kind: "openadminos", clientId: "d1de0a94-f67a-421d-8804-a235955ffd69" },
  grantedScopes: ["graph:User.Read"],
};

const fabrikam = {
  ...woodgrove,
  id: "22222222-2222-2222-2222-222222222222",
  displayName: "Fabrikam",
  username: "it@fabrikam.example",
  homeAccountId: "home-fabrikam",
  connectionId: "connection-fabrikam",
};

const WOODGROVE_ORG = `org-${woodgrove.id}`;
const FABRIKAM_ORG = `org-${fabrikam.id}`;

async function withStore(run: (input: {
  store: AppStateStore;
  tokens: MemorySplashtopTokenStore;
  calls: Call[];
  file: () => Promise<{ organizations?: OrganizationRecord[]; configurationAudit?: ConfigurationAuditEvent[]; runs: RunRecord[] }>;
  route: { current: (call: Call) => Response };
}) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-splashtop-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({
    activeProviderId: "ollama",
    installedAgents: [],
    runs: [],
    tenants: [woodgrove, fabrikam],
    activeTenantId: woodgrove.id,
    organizations: [],
  }));
  const tokens = new MemorySplashtopTokenStore();
  const route = { current: splashtopTeam };
  const { calls, fetch } = recorder((call) => route.current(call));
  const store = new AppStateStore({ filePath, tokenStore, statsApiUrl: "", userDataPath: dir, splashtopTokens: tokens, splashtopFetch: fetch });
  try {
    await run({ store, tokens, calls, route, file: async () => JSON.parse(await readFile(filePath, "utf8")) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function settled(store: AppStateStore, runId: string): Promise<RunRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await store.getRun(runId);
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) {
      // The finished run's delivery and history writes follow the snapshot; let them land before the folder goes.
      const serialize = (store as unknown as { serialize<T>(work: () => Promise<T>): Promise<T> }).serialize.bind(store);
      for (let pass = 0; pass < 3; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await serialize(async () => undefined);
      }
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The run did not finish.");
}

function chatContext(store: AppStateStore, tenant: object): Promise<SplashtopChatContext | undefined> {
  return (store as unknown as { splashtopChatContext(tenant: object): Promise<SplashtopChatContext | undefined> }).splashtopChatContext(tenant);
}

describe("Splashtop connection in app state", () => {
  it("connects after the check, stores the token for the organization only and audits it without the token", async () => {
    await withStore(async ({ store, tokens, calls, file }) => {
      const summary = await store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "eu", token: ` Bearer ${TOKEN_A} ` });
      assert.equal(summary.host, "webapi.splashtop.eu");
      assert.equal(summary.teamId, TEAM);
      assert.ok(summary.parts.find((part) => part.id === "splashtop.computers")?.on);
      assert.equal(calls[0]!.url.host, "webapi.splashtop.eu");
      assert.deepEqual([...tokens.tokens.entries()], [[WOODGROVE_ORG, TOKEN_A]]);
      const saved = await file();
      const record = saved.organizations?.find((organization) => organization.id === WOODGROVE_ORG)?.connections.splashtop;
      assert.equal(record?.region, "eu");
      const raw = JSON.stringify(saved);
      assert.doesNotMatch(raw, new RegExp(TOKEN_A));
      const event = saved.configurationAudit?.find((entry) => entry.type === "splashtop.connected");
      assert.deepEqual(event?.details, { region: "eu", host: "webapi.splashtop.eu", teamId: TEAM, account: "admin@woodgrove.example", reconnected: false });
      assert.equal(event?.organizationId, WOODGROVE_ORG);
      const state = await store.getAppState();
      assert.equal(state.splashtopConnections?.length, 1);
      assert.doesNotMatch(JSON.stringify(state), new RegExp(TOKEN_A));
    });
  });

  it("saves nothing when the check fails, and says why", async () => {
    await withStore(async ({ store, tokens, route, file }) => {
      route.current = () => json(401, {});
      await assert.rejects(store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "oceania", token: TOKEN_A }), /\(HTTP 401\) at webapi\.splashtop\.nr\..*another region/);
      assert.equal(tokens.tokens.size, 0);
      assert.equal(JSON.stringify((await file()).organizations ?? []).includes("splashtop"), false);
    });
  });

  it("connects only the active organization", async () => {
    await withStore(async ({ store, calls }) => {
      await assert.rejects(store.connectSplashtop({ organizationId: FABRIKAM_ORG, region: "global", token: TOKEN_B }), /active organization/);
      assert.equal(calls.length, 0);
    });
  });

  it("rotates the token after checking it on the same host, and refuses a token of another team", async () => {
    await withStore(async ({ store, tokens, calls, route, file }) => {
      await store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "eu", token: TOKEN_A });
      const rotated = await store.rotateSplashtopToken({ organizationId: WOODGROVE_ORG, token: "rotated-token-abcdef" });
      assert.equal(calls.at(-1)!.url.host, "webapi.splashtop.eu");
      assert.equal(authOf(calls.at(-1)!), "Bearer rotated-token-abcdef");
      assert.equal(tokens.tokens.get(WOODGROVE_ORG), "rotated-token-abcdef");
      assert.equal(rotated.region, "eu");
      assert.ok((await file()).configurationAudit?.some((entry) => entry.type === "splashtop.token-rotated"));
      route.current = () => ok({ scopes: { team_computers: { stb_team_id: 4242 } } });
      await assert.rejects(store.rotateSplashtopToken({ organizationId: WOODGROVE_ORG, token: "other-team-token-123" }), /team 4242, not team 11125.*Nothing was changed/);
      assert.equal(tokens.tokens.get(WOODGROVE_ORG), "rotated-token-abcdef");
    });
  });

  it("tests the stored token and disconnects with the token deleted and audited", async () => {
    await withStore(async ({ store, tokens, file }) => {
      await store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "global", token: TOKEN_A });
      const tested = await store.testSplashtop(WOODGROVE_ORG);
      assert.ok(tested.lastCheckedAt);
      await store.disconnectSplashtop(WOODGROVE_ORG);
      assert.equal(tokens.tokens.size, 0);
      const saved = await file();
      assert.ok(saved.configurationAudit?.some((entry) => entry.type === "splashtop.disconnected" && entry.details.organizationRemoved === false));
      assert.equal((await store.getAppState()).splashtopConnections?.length, 0);
      await assert.rejects(store.testSplashtop(WOODGROVE_ORG), /not connected for Woodgrove Bank/);
    });
  });

  it("keeps organizations apart: Chat for each tenant uses its own organization's token and host", async () => {
    await withStore(async ({ store, calls }) => {
      await store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "eu", token: TOKEN_A });
      await store.setActiveTenant(fabrikam.id);
      await store.connectSplashtop({ organizationId: FABRIKAM_ORG, region: "global", token: TOKEN_B });
      calls.length = 0;
      const woodgroveChat = await chatContext(store, woodgrove);
      const fabrikamChat = await chatContext(store, fabrikam);
      assert.equal(woodgroveChat?.host, "webapi.splashtop.eu");
      assert.equal(fabrikamChat?.host, "webapi.splashtop.com");
      await woodgroveChat!.read("splashtop_list_policies", {});
      await fabrikamChat!.read("splashtop_list_policies", {});
      assert.deepEqual(calls.map((call) => [call.url.host, authOf(call)]), [
        ["webapi.splashtop.eu", `Bearer ${TOKEN_A}`],
        ["webapi.splashtop.com", `Bearer ${TOKEN_B}`],
      ]);
      // A tenant whose organization has no Splashtop connection gets no tools.
      await store.disconnectSplashtop(WOODGROVE_ORG);
      assert.equal(await chatContext(store, woodgrove), undefined);
      // An answer that started before a disconnect sends nothing afterwards.
      const started = await chatContext(store, fabrikam);
      await store.disconnectSplashtop(FABRIKAM_ORG);
      calls.length = 0;
      await assert.rejects(started!.read("splashtop_list_policies", {}), /disconnected.*Nothing was sent/);
      assert.equal(calls.length, 0);
    });
  });

  it("offers Chat only the parts the token reaches", async () => {
    await withStore(async ({ store, route }) => {
      route.current = (call) => call.url.pathname.endsWith("basic_info") ? ok({ scopes: { logs: { stb_team_id: TEAM } } }) : ok([]);
      await store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "global", token: TOKEN_A });
      const chat = await chatContext(store, woodgrove);
      assert.deepEqual(chat?.tools, ["splashtop_list_sessions", "splashtop_list_team_history", "splashtop_list_policies", "splashtop_list_vulnerabilities"]);
    });
  });

  it("prepares a plan at the typed confirmation gate and applies it in order after the exact phrase", async () => {
    await withStore(async ({ store, calls }) => {
      await store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "eu", token: TOKEN_A });
      const run = await store.prepareSplashtopChange({ organizationId: WOODGROVE_ORG, kind: "reboot-computers", targetIds: [101, 103] });
      assert.equal(run.status, "awaiting-confirmation");
      assert.equal(run.origin, "splashtop-change");
      assert.equal(run.tenantId, woodgrove.id);
      assert.equal(run.plan?.confirmationPhrase, "REBOOT 2 COMPUTERS");
      assert.equal(calls.filter((call) => call.init.method !== "GET").length, 0, "planning sends no change");
      await assert.rejects(store.confirmRun(run.id, "REBOOT 2 COMPUTER", { activeOrganizationOnly: true }), /does not match/);
      assert.equal((await store.getRun(run.id))?.status, "awaiting-confirmation");
      calls.length = 0;
      await store.confirmRun(run.id, "REBOOT 2 COMPUTERS", { activeOrganizationOnly: true });
      const done = await settled(store, run.id);
      assert.equal(done.status, "completed", done.error);
      assert.equal(done.summary, "2 Splashtop changes applied.");
      assert.deepEqual(calls.map((call) => [call.init.method, call.url.host, call.url.pathname, bodyOf(call)]), [
        ["POST", "webapi.splashtop.eu", `/api/open/v1/teams/${TEAM}/computers/reboot`, { server_ids: [101], reboot_option: "normal_reboot" }],
        ["POST", "webapi.splashtop.eu", `/api/open/v1/teams/${TEAM}/computers/reboot`, { server_ids: [103], reboot_option: "normal_reboot" }],
      ]);
    });
  });

  it("stops at the first failed action and reports the exact count", async () => {
    await withStore(async ({ store, route, calls }) => {
      await store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "global", token: TOKEN_A });
      const run = await store.prepareSplashtopChange({ organizationId: WOODGROVE_ORG, kind: "delete-computers", targetIds: [101, 102, 103] });
      route.current = (call) => call.init.method === "DELETE" && call.url.pathname.endsWith("/102") ? json(403, {}) : splashtopTeam(call);
      calls.length = 0;
      await store.confirmRun(run.id, "DELETE 3 COMPUTERS", { activeOrganizationOnly: true });
      const done = await settled(store, run.id);
      assert.equal(done.status, "failed");
      assert.match(done.summary ?? "", /after applying 1 of 3/);
      assert.equal(calls.filter((call) => call.init.method === "DELETE").length, 2);
    });
  });

  it("refuses to apply a plan from another organization, and a plan edited to another request", async () => {
    await withStore(async ({ store, calls, file }) => {
      await store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "global", token: TOKEN_A });
      const run = await store.prepareSplashtopChange({ organizationId: WOODGROVE_ORG, kind: "disable-users", targetIds: [2] });
      await store.setActiveTenant(fabrikam.id);
      await assert.rejects(store.confirmRun(run.id, "DISABLE 1 USER", { activeOrganizationOnly: true }), /Woodgrove Bank/);
      assert.equal((await store.getRun(run.id))?.status, "awaiting-confirmation");
      await assert.rejects(store.prepareSplashtopChange({ organizationId: WOODGROVE_ORG, kind: "disable-users", targetIds: [2] }), /active organization/);

      // A plan tampered with in the state file never sends its request.
      await store.setActiveTenant(woodgrove.id);
      const saved = await file();
      const tampered = saved.runs.find((entry) => entry.id === run.id)!;
      tampered.plan!.actions[0]!.request = { method: "DELETE", path: `/api/open/v1/teams/${TEAM}/users/2` };
      const statePath = join((store as unknown as { filePath: string }).filePath);
      await writeFile(statePath, JSON.stringify(saved));
      calls.length = 0;
      await store.confirmRun(run.id, "DISABLE 1 USER", { activeOrganizationOnly: true });
      const done = await settled(store, run.id);
      assert.equal(done.status, "failed");
      assert.match(done.error ?? "", /not a Splashtop change OpenAdminOS plans/);
      assert.equal(calls.length, 0);
    });
  });

  it("disconnecting Splashtop stops an apply in flight and waits for it before the token is deleted", async () => {
    await withStore(async ({ store, tokens, route, calls }) => {
      await store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "global", token: TOKEN_A });
      const run = await store.prepareSplashtopChange({ organizationId: WOODGROVE_ORG, kind: "reboot-computers", targetIds: [101, 102, 103] });
      // The first reboot hangs until its request is aborted.
      let firstWriteStarted!: () => void;
      const started = new Promise<void>((resolve) => { firstWriteStarted = resolve; });
      route.current = (call) => {
        if (call.init.method === "POST" && call.url.pathname.endsWith("/computers/reboot")) {
          firstWriteStarted();
          return new Promise<Response>((_resolve, reject) => {
            call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          }) as unknown as Response;
        }
        return splashtopTeam(call);
      };
      calls.length = 0;
      await store.confirmRun(run.id, "REBOOT 3 COMPUTERS", { activeOrganizationOnly: true });
      await started;
      // The run's stored status at the moment the token is deleted.
      let statusWhenTokenRemoved: string | undefined;
      const remove = tokens.remove.bind(tokens);
      tokens.remove = async (organizationId: string) => {
        const statePath = (store as unknown as { filePath: string }).filePath;
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { runs: RunRecord[] };
        statusWhenTokenRemoved = state.runs.find((entry) => entry.id === run.id)?.status;
        return remove(organizationId);
      };
      await store.disconnectSplashtop(WOODGROVE_ORG);
      // The apply had stopped before disconnect returned.
      const stopped = await store.getRun(run.id);
      assert.equal(stopped?.status, "failed");
      assert.match(stopped?.error ?? "", /Splashtop was disconnected while this plan applied\. Nothing more was sent/);
      assert.match(stopped?.summary ?? "", /after applying 0 of 3/);
      // The apply had stopped and been recorded before the token went, and only one write was ever sent.
      assert.equal(statusWhenTokenRemoved, "failed");
      await settled(store, run.id);
      assert.equal(tokens.tokens.has(WOODGROVE_ORG), false);
      assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
    });
  });

  it("deletes the Splashtop token when its organization is disconnected", async () => {
    await withStore(async ({ store, tokens, file }) => {
      await store.connectSplashtop({ organizationId: WOODGROVE_ORG, region: "global", token: TOKEN_A });
      await store.disconnectTenant(woodgrove.id);
      assert.equal(tokens.tokens.has(WOODGROVE_ORG), false);
      assert.ok((await file()).configurationAudit?.some((entry) => entry.type === "splashtop.disconnected" && entry.details.organizationRemoved === true));
    });
  });
});
