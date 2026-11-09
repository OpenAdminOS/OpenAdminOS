import {
  isSplashtopChangeKind,
  SPLASHTOP_API_PREFIX,
  SPLASHTOP_CHANGE_TARGET_LIMIT,
  splashtopChangeDestructive,
  splashtopComputerNameProblem,
  splashtopConfirmationPhrase,
  type SplashtopChangeKind,
  type SplashtopChangeRequest,
  type WriteAction,
  type WritePlan,
} from "@openadminos/agent-sdk";

import { SplashtopApiError, splashtopList, type SplashtopApi, type SplashtopMethod } from "./api.js";

/**
 * Builds a Splashtop change plan. Every target is read from Splashtop
 * again first, so the plan shows each one's current name and state next
 * to the change, and a target that is gone, already changed or cannot be
 * changed is refused before anything is planned. The plan holds the exact
 * requests; nothing is rendered again at apply time.
 */

export const SPLASHTOP_WRITE_KIND = "splashtop-write";

export interface SplashtopPlanContext {
  api: SplashtopApi;
  teamId: number;
  teamLabel: string;
  signal?: AbortSignal;
}

function refuse(message: string): SplashtopApiError {
  return new SplashtopApiError("refused", `${message} Nothing was planned.`, { sent: false });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Checks the request shape. Throws a designed message; never sends anything. */
export function validateSplashtopChangeRequest(raw: unknown): SplashtopChangeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw refuse("The change request is empty.");
  const input = raw as Record<string, unknown>;
  if (!isSplashtopChangeKind(input.kind)) {
    throw refuse("The change must be one of reboot-computers, delete-computers, disable-users, end-sessions or rename-computers.");
  }
  const kind = input.kind;
  const ids = Array.isArray(input.targetIds) ? input.targetIds : [];
  if (ids.length === 0) throw refuse("Name at least one target id.");
  if (ids.length > SPLASHTOP_CHANGE_TARGET_LIMIT) throw refuse(`One plan changes at most ${SPLASHTOP_CHANGE_TARGET_LIMIT} targets.`);
  const targetIds: number[] = [];
  for (const id of ids) {
    const number = typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) throw refuse("Target ids are whole positive numbers from Splashtop.");
    if (!targetIds.includes(number)) targetIds.push(number);
  }
  const request: SplashtopChangeRequest = { kind, targetIds };
  if (kind === "rename-computers") {
    const names = input.names && typeof input.names === "object" && !Array.isArray(input.names) ? (input.names as Record<string, unknown>) : {};
    const checked: Record<string, string> = {};
    for (const id of targetIds) {
      const name = names[String(id)];
      if (typeof name !== "string") throw refuse(`Give a new name for computer ${id}.`);
      const problem = splashtopComputerNameProblem(name);
      if (problem) throw refuse(`${problem} (computer ${id})`);
      checked[String(id)] = name.trim();
    }
    request.names = checked;
  }
  if (kind === "reboot-computers") {
    const option = input.rebootOption ?? "normal_reboot";
    if (option !== "normal_reboot" && option !== "restart_streamer") throw refuse("rebootOption is normal_reboot or restart_streamer.");
    request.rebootOption = option;
  }
  return request;
}

function label(record: Record<string, unknown> | undefined, fallback: string): string {
  const value = record?.name ?? record?.host_name ?? record?.email ?? record?.member_name;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : fallback;
}

async function readComputers(ctx: SplashtopPlanContext, ids: readonly number[]): Promise<Map<number, Record<string, unknown>>> {
  const records = splashtopList(await ctx.api.request({
    method: "GET",
    path: `${SPLASHTOP_API_PREFIX}teams/${ctx.teamId}/computers`,
    query: { ids: ids.join(","), customized_fields: "id,name,host_name,online_status,last_online,os" },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }));
  return new Map(records.map((record) => [Number(record.id), record]));
}

async function readUsers(ctx: SplashtopPlanContext, ids: readonly number[]): Promise<Map<number, Record<string, unknown>>> {
  const records = splashtopList(await ctx.api.request({
    method: "GET",
    path: `${SPLASHTOP_API_PREFIX}teams/${ctx.teamId}/users`,
    query: { ids: ids.join(","), customized_fields: "id,email,member_name,role,status,super_admin" },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }));
  return new Map(records.map((record) => [Number(record.id), record]));
}

async function readActiveSessions(ctx: SplashtopPlanContext, ids: readonly number[]): Promise<Map<number, Record<string, unknown>>> {
  const records = splashtopList(await ctx.api.request({
    method: "POST",
    path: `${SPLASHTOP_API_PREFIX}teams/logs/active_sessions`,
    body: { team_id: ctx.teamId, ids: ids.join(","), per_page_size: "500", fields: "id,created_at,src_user_email,srs_name,service_kind,status,can_force_disconnect" },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }));
  return new Map(records.map((record) => [Number(record.id), record]));
}

function onlineText(computer: Record<string, unknown>): string {
  const status = computer.online_status;
  if (status === true || status === 1 || status === "1" || status === "online") return "online";
  if (status === false || status === 0 || status === "0" || status === "offline") {
    return typeof computer.last_online === "string" ? `offline, last online ${computer.last_online}` : "offline";
  }
  return "online state not reported";
}

function action(input: {
  id: string;
  label: string;
  description: string;
  destructive: boolean;
  method: SplashtopMethod;
  path: string;
  body?: unknown;
  targetId: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}): WriteAction {
  return {
    id: input.id,
    kind: SPLASHTOP_WRITE_KIND,
    label: input.label,
    description: input.description,
    severity: input.destructive ? "destructive" : "default",
    metadata: { service: "splashtop", targetId: input.targetId, before: input.before, after: input.after },
    request: {
      method: input.method as "POST" | "PUT" | "PATCH" | "DELETE",
      path: input.path,
      ...(input.body !== undefined ? { body: input.body } : {}),
    },
  };
}

export async function buildSplashtopChangePlan(ctx: SplashtopPlanContext, request: SplashtopChangeRequest): Promise<WritePlan> {
  const { kind, targetIds } = request;
  const team = `${SPLASHTOP_API_PREFIX}teams/${ctx.teamId}`;
  const destructive = splashtopChangeDestructive(kind);
  const actions: WriteAction[] = [];

  if (kind === "reboot-computers" || kind === "delete-computers" || kind === "rename-computers") {
    const computers = await readComputers(ctx, targetIds);
    for (const id of targetIds) {
      const computer = computers.get(id);
      if (!computer) throw refuse(`Splashtop has no computer with id ${id} in ${ctx.teamLabel}.`);
      const name = label(computer, `Computer ${id}`);
      const state = onlineText(computer);
      if (kind === "reboot-computers") {
        const option = request.rebootOption ?? "normal_reboot";
        actions.push(action({
          id: `splashtop-reboot-${id}`,
          label: option === "restart_streamer" ? `Restart the Splashtop Streamer on ${name}` : `Reboot ${name}`,
          description: option === "restart_streamer"
            ? `Computer ${id}, now ${state}. Restarts the Streamer service; open remote sessions drop.`
            : `Computer ${id}, now ${state}. Restarts the computer; signed-in users lose unsaved work. An offline computer reboots when it comes online.`,
          destructive,
          method: "POST",
          path: `${team}/computers/reboot`,
          body: { server_ids: [id], reboot_option: option },
          targetId: id,
          before: { name, state },
          after: { reboot: option },
        }));
      } else if (kind === "delete-computers") {
        actions.push(action({
          id: `splashtop-delete-${id}`,
          label: `Delete ${name} from the team`,
          description: `Computer ${id}, now ${state}. Removes it from the Splashtop team; it cannot be reached until the Streamer is deployed to the team again.`,
          destructive,
          method: "DELETE",
          path: `${team}/computers/${id}`,
          targetId: id,
          before: { name, state },
          after: { deleted: true },
        }));
      } else {
        const next = request.names?.[String(id)];
        if (!next) throw refuse(`Give a new name for computer ${id}.`);
        if (next === name) throw refuse(`Computer ${id} is already named ${name}.`);
        actions.push(action({
          id: `splashtop-rename-${id}`,
          label: `Rename ${name} to ${next}`,
          description: `Computer ${id}. Name: ${name} -> ${next}. Only the name shown in Splashtop changes; the host name stays.`,
          destructive,
          method: "PUT",
          path: `${team}/computers/${id}/rename`,
          body: { name: next },
          targetId: id,
          before: { name },
          after: { name: next },
        }));
      }
    }
  } else if (kind === "disable-users") {
    const users = await readUsers(ctx, targetIds);
    for (const id of targetIds) {
      const user = users.get(id);
      if (!user) throw refuse(`Splashtop has no user with id ${id} in ${ctx.teamLabel}.`);
      const name = label(user, `User ${id}`);
      if (user.role === "owner") throw refuse(`${name} is the team owner, who cannot be disabled.`);
      if (user.status === "disabled") throw refuse(`${name} is already disabled.`);
      const status = typeof user.status === "string" ? user.status : "status not reported";
      actions.push(action({
        id: `splashtop-disable-${id}`,
        label: `Disable ${name}`,
        description: `User ${id}${typeof user.role === "string" ? `, ${user.role}` : ""}. Status: ${status} -> disabled. They can no longer sign in to Splashtop or start sessions until enabled again.`,
        destructive,
        method: "PATCH",
        path: `${team}/users/${id}/change_status`,
        body: { status: "disabled" },
        targetId: id,
        before: { name, status },
        after: { status: "disabled" },
      }));
    }
  } else {
    const sessions = await readActiveSessions(ctx, targetIds);
    for (const id of targetIds) {
      const session = sessions.get(id);
      if (!session) throw refuse(`Splashtop has no active session with id ${id}. It may have ended already.`);
      if (session.can_force_disconnect === false || session.can_force_disconnect === 0) {
        throw refuse(`Splashtop says session ${id} cannot be ended from the API.`);
      }
      const who = typeof session.src_user_email === "string" ? session.src_user_email : "an unknown account";
      const where = typeof session.srs_name === "string" ? session.srs_name : "an unknown computer";
      actions.push(action({
        id: `splashtop-end-${id}`,
        label: `End the session of ${who} on ${where}`,
        description: `Session ${id}${typeof session.created_at === "string" ? `, started ${session.created_at}` : ""}. Disconnects it now; unsaved work in the remote session can be lost.`,
        destructive,
        method: "POST",
        path: `${SPLASHTOP_API_PREFIX}teams/logs/active_sessions/${id}/disconnect`,
        targetId: id,
        before: { user: who, computer: where },
        after: { ended: true },
      }));
    }
  }

  return {
    summary: summaryFor(kind, actions.length, ctx.teamLabel),
    confirmationPhrase: splashtopConfirmationPhrase(kind, actions.length),
    actions,
  };
}

function summaryFor(kind: SplashtopChangeKind, count: number, team: string): string {
  switch (kind) {
    case "reboot-computers":
      return `Reboot ${plural(count, "Splashtop computer", "Splashtop computers")} in ${team}.`;
    case "delete-computers":
      return `Delete ${plural(count, "computer", "computers")} from the Splashtop team ${team}.`;
    case "disable-users":
      return `Disable ${plural(count, "Splashtop user", "Splashtop users")} in ${team}.`;
    case "end-sessions":
      return `End ${plural(count, "active Splashtop session", "active Splashtop sessions")} in ${team}.`;
    case "rename-computers":
      return `Rename ${plural(count, "Splashtop computer", "Splashtop computers")} in ${team}.`;
  }
}

const WRITE_PATHS: ReadonlyArray<{ method: SplashtopMethod; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/api\/open\/v1\/teams\/(\d+)\/computers\/reboot$/ },
  { method: "DELETE", pattern: /^\/api\/open\/v1\/teams\/(\d+)\/computers\/\d+$/ },
  { method: "PUT", pattern: /^\/api\/open\/v1\/teams\/(\d+)\/computers\/\d+\/rename$/ },
  { method: "PATCH", pattern: /^\/api\/open\/v1\/teams\/(\d+)\/users\/\d+\/change_status$/ },
  { method: "POST", pattern: /^\/api\/open\/v1\/teams\/logs\/active_sessions\/\d+\/disconnect$/ },
];

/**
 * True when a stored action is one this host plans, for this team. Checked
 * again at apply, so a plan edited in the state file cannot send any other
 * request with the token.
 */
export function isPlannedSplashtopRequest(action: WriteAction, teamId: number): boolean {
  if (action.kind !== SPLASHTOP_WRITE_KIND || !action.request) return false;
  const { method, path } = action.request;
  return WRITE_PATHS.some((entry) => {
    if (entry.method !== method) return false;
    const match = entry.pattern.exec(path);
    if (!match) return false;
    return match[1] === undefined || Number(match[1]) === teamId;
  });
}
