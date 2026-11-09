import {
  SPLASHTOP_API_PREFIX,
  type SplashtopChangeKind,
  type SplashtopChangeTarget,
} from "@openadminos/agent-sdk";

import { splashtopList, type SplashtopApi } from "./api.js";

/** At most this many targets are listed in Plan a change; a narrower filter is for Chat. */
export const SPLASHTOP_TARGET_LIST_LIMIT = 200;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : undefined;
}

function online(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1" || value === "online") return true;
  if (value === false || value === 0 || value === "0" || value === "offline") return false;
  return undefined;
}

/**
 * What a change can target now, as Splashtop lists it: computers for
 * reboot, delete and rename; enabled users other than the owner for
 * disable; active sessions that can be ended. The plan reads each picked
 * target again, so this list is only for choosing.
 */
export async function listSplashtopChangeTargets(
  ctx: { api: SplashtopApi; teamId: number; signal?: AbortSignal },
  kind: SplashtopChangeKind,
): Promise<SplashtopChangeTarget[]> {
  const signal = ctx.signal ? { signal: ctx.signal } : {};
  const team = `${SPLASHTOP_API_PREFIX}teams/${ctx.teamId}`;
  const ids = (records: Record<string, unknown>[]) =>
    records.map((record) => ({ record, id: Number(record.id) })).filter(({ id }) => Number.isSafeInteger(id) && id > 0);

  if (kind === "disable-users") {
    const users = ids(splashtopList(await ctx.api.request({ method: "GET", path: `${team}/users`, query: { status: "enabled" }, ...signal })));
    return users
      .filter(({ record }) => record.role !== "owner")
      .slice(0, SPLASHTOP_TARGET_LIST_LIMIT)
      .map(({ record, id }) => ({
        id,
        label: text(record.email) ?? `User ${id}`,
        ...(text(record.role) ? { detail: text(record.role)! } : {}),
      }));
  }
  if (kind === "end-sessions") {
    const sessions = ids(splashtopList(await ctx.api.request({
      method: "POST",
      path: `${SPLASHTOP_API_PREFIX}teams/logs/active_sessions`,
      body: { team_id: ctx.teamId, per_page_size: "500", fields: "id,created_at,src_user_email,srs_name,service_kind,can_force_disconnect" },
      ...signal,
    })));
    return sessions
      .filter(({ record }) => record.can_force_disconnect !== false && record.can_force_disconnect !== 0)
      .slice(0, SPLASHTOP_TARGET_LIST_LIMIT)
      .map(({ record, id }) => ({
        id,
        label: `${text(record.src_user_email) ?? "Unknown account"} on ${text(record.srs_name) ?? "unknown computer"}`,
        ...(text(record.created_at) ? { detail: `started ${text(record.created_at)}` } : {}),
      }));
  }
  const computers = ids(splashtopList(await ctx.api.request({ method: "GET", path: `${team}/computers`, ...signal })));
  return computers.slice(0, SPLASHTOP_TARGET_LIST_LIMIT).map(({ record, id }) => {
    const state = online(record.online_status);
    const lastOnline = text(record.last_online);
    const detail = [
      text(record.host_name),
      state === true ? "online" : state === false ? (lastOnline ? `offline, last online ${lastOnline}` : "offline") : undefined,
    ].filter(Boolean).join(" · ");
    return { id, label: text(record.name) ?? `Computer ${id}`, ...(detail ? { detail } : {}) };
  });
}
