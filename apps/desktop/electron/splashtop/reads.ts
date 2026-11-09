import { SPLASHTOP_API_PREFIX, type SplashtopReadToolName } from "@openadminos/agent-sdk";

import { SplashtopApiError, splashtopList, type SplashtopApi } from "./api.js";

/**
 * The read tools of the Splashtop service. Each takes the params a model
 * may write, checks them, makes at most two Open API calls and returns at
 * most one page of records. Splashtop lists computers, users, groups and
 * policies whole; OpenAdminOS pages those itself with `offset` and
 * `limit`. Session logs, team history and vulnerabilities are paged by
 * Splashtop with `page`.
 */

export const SPLASHTOP_PAGE_LIMIT = 50;
const DEFAULT_PAGE = 25;
const INVENTORY_COMPUTER_LIMIT = 20;
/** Splashtop's own page size for the logs and vulnerabilities it pages; its minimum is 50 for logs and 20 for CVEs. */
const SERVER_PAGE_SIZE = 50;

export interface SplashtopReadContext {
  api: SplashtopApi;
  teamId: number;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface SplashtopReadResult {
  tool: SplashtopReadToolName;
  records: Record<string, unknown>[];
  /** How the page was chosen and how to ask for the next one. */
  page: {
    offset?: number;
    limit?: number;
    page?: number;
    total?: number;
    totalPages?: number;
    /** Params for the next page, when there is one. */
    next?: Record<string, number>;
  };
}

export interface SplashtopReadToolDefinition {
  name: SplashtopReadToolName;
  description: string;
  params: Record<string, unknown>;
}

const OFFSET_LIMIT = {
  offset: { type: "number", description: "Records to skip. Defaults to 0." },
  limit: { type: "number", description: `Records to return, at most ${SPLASHTOP_PAGE_LIMIT}. Defaults to ${DEFAULT_PAGE}.` },
};

export const SPLASHTOP_READ_TOOLS: readonly SplashtopReadToolDefinition[] = [
  {
    name: "splashtop_list_computers",
    description: "List Splashtop computers of this organization's team with id, name, host name, OS, online state, last online, last session and Streamer version. Filter by online state or group id, or by part of the name.",
    params: { type: "object", properties: { online: { type: "string", enum: ["online", "offline"] }, groupId: { type: "number" }, nameContains: { type: "string", maxLength: 64 }, ...OFFSET_LIMIT } },
  },
  {
    name: "splashtop_get_inventory",
    description: `System and hardware inventory, and optionally installed software, for up to ${INVENTORY_COMPUTER_LIMIT} Splashtop computer ids from splashtop_list_computers. Splashtop allows 10 inventory calls per minute.`,
    params: { type: "object", required: ["computerIds"], properties: { computerIds: { type: "array", items: { type: "number" }, maxItems: INVENTORY_COMPUTER_LIMIT }, software: { type: "boolean", description: "Include installed software. Defaults to false." } } },
  },
  {
    name: "splashtop_list_users",
    description: "List Splashtop team users with id, email, name, role, status, two-step verification, last login and last session. Filter by status (enabled, disabled, invited, declined, quit) or role (owner, manager, member, group_admin).",
    params: { type: "object", properties: { status: { type: "string", enum: ["enabled", "disabled", "invited", "declined", "quit"] }, role: { type: "string", enum: ["owner", "manager", "member", "group_admin"] }, ...OFFSET_LIMIT } },
  },
  {
    name: "splashtop_list_groups",
    description: "List Splashtop user and computer groups with their member, computer and admin counts.",
    params: { type: "object", properties: { type: { type: "string", enum: ["member", "computer"] }, ...OFFSET_LIMIT } },
  },
  {
    name: "splashtop_list_sessions",
    description: "List Splashtop remote sessions: active ones, or finished ones in the last days (at most 90). Each has id, start, duration, who connected from where, the computer, the session kind and whether it can be ended.",
    params: { type: "object", properties: { state: { type: "string", enum: ["active", "finished"], description: "Defaults to finished." }, days: { type: "number", description: "Days back, 1 to 90. Defaults to 7." }, keyword: { type: "string", maxLength: 64, description: "Part of an account email or computer name." }, page: { type: "number", description: "Page of 50, from 1." } } },
  },
  {
    name: "splashtop_list_team_history",
    description: "List the Splashtop team history (audit log): users joining or leaving, failed logins and other team events, in the last days (at most 90).",
    params: { type: "object", properties: { days: { type: "number", description: "Days back, 1 to 90. Defaults to 7." }, page: { type: "number", description: "Page of 50, from 1." } } },
  },
  {
    name: "splashtop_list_policies",
    description: "List Splashtop endpoint management policies.",
    params: { type: "object", properties: { ...OFFSET_LIMIT } },
  },
  {
    name: "splashtop_list_vulnerabilities",
    description: "List CVEs Splashtop found on the team's computers with CVSS, CISA KEV status, affected computer count and remediation status. Filter by keyword (CVE id or OS version) or KEV only; sort by cvss, computers_count or published_date.",
    params: { type: "object", properties: { keyword: { type: "string", maxLength: 64 }, inCisaKev: { type: "boolean" }, orderBy: { type: "string", enum: ["cvss", "computers_count", "published_date", "risk_level"] }, page: { type: "number", description: "Page of 50, from 1." } } },
  },
];

export function isSplashtopReadTool(name: string): name is SplashtopReadToolName {
  return SPLASHTOP_READ_TOOLS.some((tool) => tool.name === name);
}

function invalid(message: string): SplashtopApiError {
  return new SplashtopApiError("refused", `${message} Nothing was sent to Splashtop.`, { sent: false });
}

function params(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function integer(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) {
    throw invalid(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

function optionalId(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return integer(value, name, 1, Number.MAX_SAFE_INTEGER, 0);
}

function text(value: unknown, name: string, max = 64): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || [...value].length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`${name} must be text of at most ${max} characters.`);
  }
  return value.trim() || undefined;
}

function choice<T extends string>(value: unknown, name: string, choices: readonly T[]): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !choices.includes(value as T)) throw invalid(`${name} must be one of ${choices.join(", ")}.`);
  return value as T;
}

function flag(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalid(`${name} must be true or false.`);
  return value;
}

/** Keeps listed fields only, so a page carries what the tool promises and nothing else. */
function pickFields(record: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) if (record[field] !== undefined) picked[field] = record[field];
  return picked;
}

function slicePage(records: Record<string, unknown>[], offset: number, limit: number): SplashtopReadResult["page"] & { slice: Record<string, unknown>[] } {
  const slice = records.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    offset,
    limit,
    total: records.length,
    ...(nextOffset < records.length ? { next: { offset: nextOffset, limit } } : {}),
    slice,
  };
}

function offsetLimit(input: Record<string, unknown>): { offset: number; limit: number } {
  return {
    offset: integer(input.offset, "offset", 0, 100_000, 0),
    limit: integer(input.limit, "limit", 1, SPLASHTOP_PAGE_LIMIT, DEFAULT_PAGE),
  };
}

/** `YYYY-MM-DD HH:MM:SS` in UTC, as Splashtop's log endpoints take it. */
export function splashtopTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function serverPage(data: unknown, page: number): SplashtopReadResult["page"] {
  const record = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const pagination = record.pagination && typeof record.pagination === "object" ? (record.pagination as Record<string, unknown>) : record;
  const totalPages = Number(pagination.total_pages);
  const total = Number(pagination.total_entries ?? pagination.total_count);
  return {
    page,
    ...(Number.isFinite(total) ? { total } : {}),
    ...(Number.isFinite(totalPages) ? { totalPages } : {}),
    ...(Number.isFinite(totalPages) && page < totalPages ? { next: { page: page + 1 } } : {}),
  };
}

const COMPUTER_FIELDS = ["id", "uuid", "name", "host_name", "os", "online_status", "last_online", "last_session", "version", "group_id", "os_logon", "os_user", "os_domain"] as const;
const USER_FIELDS = ["id", "email", "member_name", "role", "status", "super_admin", "group_id", "enable_2fa", "last_login_at", "last_session_at", "license_type"] as const;
const GROUP_FIELDS = ["id", "name", "group_type", "members_count", "computers_count", "admins_count"] as const;
const SESSION_FIELDS = "id,created_at,duration,src_user_email,src_name,srs_name,service_kind,status,can_force_disconnect,srs_uuid,client_ip_addr";
const CVE_FIELDS = ["id", "cve_name", "cvss", "cvss_level", "risk_level", "in_cisa_kev", "published_on", "computers_count", "remediation_status", "remediation_deadline"] as const;

export async function runSplashtopRead(ctx: SplashtopReadContext, tool: SplashtopReadToolName, raw: unknown): Promise<SplashtopReadResult> {
  const input = params(raw);
  const team = `${SPLASHTOP_API_PREFIX}teams/${ctx.teamId}`;
  const signal = ctx.signal ? { signal: ctx.signal } : {};
  const now = ctx.now ?? (() => new Date());

  switch (tool) {
    case "splashtop_list_computers": {
      const online = choice(input.online, "online", ["online", "offline"] as const);
      const groupId = optionalId(input.groupId, "groupId");
      const nameContains = text(input.nameContains, "nameContains")?.toLowerCase();
      const { offset, limit } = offsetLimit(input);
      const overview = splashtopList(await ctx.api.request({
        method: "GET",
        path: `${team}/computers`,
        query: { online_status: online === undefined ? undefined : online === "online" ? 1 : 0, group_id: groupId },
        ...signal,
      }));
      const matching = nameContains
        ? overview.filter((computer) => [computer.name, computer.host_name].some((value) => typeof value === "string" && value.toLowerCase().includes(nameContains)))
        : overview;
      const { slice, ...page } = slicePage(matching, offset, limit);
      const ids = slice.map((computer) => Number(computer.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
      // The overview carries few fields; one more call reads the details of this page only.
      const details = ids.length > 0
        ? splashtopList(await ctx.api.request({ method: "GET", path: `${team}/computers`, query: { ids: ids.join(","), customized_fields: COMPUTER_FIELDS.join(",") }, ...signal }))
        : [];
      const byId = new Map(details.map((computer) => [Number(computer.id), computer]));
      return {
        tool,
        records: slice.map((computer) => pickFields({ ...computer, ...byId.get(Number(computer.id)) }, COMPUTER_FIELDS)),
        page,
      };
    }
    case "splashtop_get_inventory": {
      const ids = Array.isArray(input.computerIds) ? input.computerIds : [];
      if (ids.length === 0 || ids.length > INVENTORY_COMPUTER_LIMIT) throw invalid(`computerIds takes 1 to ${INVENTORY_COMPUTER_LIMIT} computer ids.`);
      const computerIds = ids.map((id) => integer(id, "computerIds", 1, Number.MAX_SAFE_INTEGER, 0));
      const software = flag(input.software, "software") ?? false;
      const data = await ctx.api.request({
        method: "POST",
        path: `${team}/inventory`,
        body: { ids: computerIds.map(String), fields: software ? ["system", "hardware", "software"] : ["system", "hardware"] },
        ...signal,
      });
      const records = splashtopList(data);
      return { tool, records: records.length > 0 ? records : data && typeof data === "object" ? [data as Record<string, unknown>] : [], page: { total: computerIds.length } };
    }
    case "splashtop_list_users": {
      const status = choice(input.status, "status", ["enabled", "disabled", "invited", "declined", "quit"] as const);
      const role = choice(input.role, "role", ["owner", "manager", "member", "group_admin"] as const);
      const { offset, limit } = offsetLimit(input);
      const overview = splashtopList(await ctx.api.request({ method: "GET", path: `${team}/users`, query: { status, roles: role }, ...signal }));
      const { slice, ...page } = slicePage(overview, offset, limit);
      const ids = slice.map((user) => Number(user.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
      const details = ids.length > 0
        ? splashtopList(await ctx.api.request({ method: "GET", path: `${team}/users`, query: { ids: ids.join(","), customized_fields: USER_FIELDS.join(",") }, ...signal }))
        : [];
      const byId = new Map(details.map((user) => [Number(user.id), user]));
      return { tool, records: slice.map((user) => pickFields({ ...user, ...byId.get(Number(user.id)) }, USER_FIELDS)), page };
    }
    case "splashtop_list_groups": {
      const type = choice(input.type, "type", ["member", "computer"] as const);
      const { offset, limit } = offsetLimit(input);
      const groups = splashtopList(await ctx.api.request({
        method: "GET",
        path: `${team}/groups`,
        query: { members_count: true, computers_count: true, admins_count: true, group_type: type },
        ...signal,
      }));
      const { slice, ...page } = slicePage(groups, offset, limit);
      return { tool, records: slice.map((group) => pickFields(group, GROUP_FIELDS)), page };
    }
    case "splashtop_list_sessions": {
      const state = choice(input.state, "state", ["active", "finished"] as const) ?? "finished";
      const days = integer(input.days, "days", 1, 90, 7);
      const keyword = text(input.keyword, "keyword");
      const page = integer(input.page, "page", 1, 10_000, 1);
      const data = await ctx.api.request({
        method: "POST",
        path: `${SPLASHTOP_API_PREFIX}teams/logs/${state === "active" ? "active_sessions" : "closed_sessions"}`,
        body: {
          team_id: ctx.teamId,
          date_range: String(days),
          page: String(page),
          per_page_size: String(SERVER_PAGE_SIZE),
          fields: SESSION_FIELDS,
          ...(keyword ? { keyword } : {}),
        },
        ...signal,
      });
      return { tool, records: splashtopList(data), page: serverPage(data, page) };
    }
    case "splashtop_list_team_history": {
      const days = integer(input.days, "days", 1, 90, 7);
      const page = integer(input.page, "page", 1, 10_000, 1);
      const end = now();
      const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
      const data = await ctx.api.request({
        method: "GET",
        path: `${SPLASHTOP_API_PREFIX}teams/logs/histories`,
        query: { team_id: ctx.teamId, start_time: splashtopTime(start), end_time: splashtopTime(end), page, per_page_size: SERVER_PAGE_SIZE },
        ...signal,
      });
      return { tool, records: splashtopList(data), page: serverPage(data, page) };
    }
    case "splashtop_list_policies": {
      const { offset, limit } = offsetLimit(input);
      const policies = splashtopList(await ctx.api.request({ method: "GET", path: `${team}/emm_policies`, ...signal }));
      const { slice, ...page } = slicePage(policies, offset, limit);
      return { tool, records: slice, page };
    }
    case "splashtop_list_vulnerabilities": {
      const keyword = text(input.keyword, "keyword");
      const inCisaKev = flag(input.inCisaKev, "inCisaKev");
      const orderBy = choice(input.orderBy, "orderBy", ["cvss", "computers_count", "published_date", "risk_level"] as const);
      const page = integer(input.page, "page", 1, 10_000, 1);
      const data = await ctx.api.request({
        method: "GET",
        path: `${team}/vulnerabilities`,
        query: { keyword, in_cisa_kev: inCisaKev, order_by: orderBy, order: orderBy ? "desc" : undefined, page, page_size: SERVER_PAGE_SIZE },
        ...signal,
      });
      return { tool, records: splashtopList(data).map((cve) => pickFields(cve, CVE_FIELDS)), page: serverPage(data, page) };
    }
  }
}
