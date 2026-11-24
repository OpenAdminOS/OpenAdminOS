import { cookies } from "next/headers";

import { SESSION_COOKIE, verifySession } from "./auth";
import { isAdventAdmin, sessionSecret, storageConfig } from "./config";
import type { Candidate } from "./eligibility";

export type Participant = {
  id: string;
  email: string;
  handle: string;
  ref_code: string;
  badge_public: boolean;
  marketing_opt_in: boolean;
  reminders_opt_in: boolean;
  session_version: number;
};

export type Completion = { day: number; completed_at: string; on_time: boolean };
export type DoorStat = { day: number; completed: number; on_time: number; answer_count: number };
export type Draw = {
  id: string;
  kind: "daily" | "grand" | "replacement";
  day: number | null;
  created_at: string;
  eligible_count: number;
  eligible_list_sha256: string;
  eligible_list: Candidate[];
  random_bytes_hex: string;
  winner_participant_ids: string[];
  created_by_email: string;
  original_draw_id: string | null;
  replaces_draw_id: string | null;
  prize_slot: number | null;
};

export class AdventStorageError extends Error {
  status: number;
  code?: string;

  constructor(status: number, code?: string) {
    super("The campaign database could not complete the request.");
    this.status = status;
    this.code = code;
  }
}

export async function db<T>(
  relation: string,
  query: Record<string, string> = {},
  init: { method?: string; body?: object; prefer?: string } = {},
): Promise<T> {
  const config = storageConfig();
  if (!config) throw new AdventStorageError(503);

  const url = new URL(`/rest/v1/${relation}`, config.origin);
  url.search = new URLSearchParams(query).toString();
  const headers: Record<string, string> = { apikey: config.key, "Content-Type": "application/json" };
  if (!config.key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${config.key}`;
  if (init.prefer) headers.Prefer = init.prefer;

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      body: init.body ? JSON.stringify(init.body) : undefined,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AdventStorageError(503);
  }
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { code?: string } | null;
    throw new AdventStorageError(response.status, problem?.code);
  }
  try {
    const body = await response.text();
    return body ? JSON.parse(body) as T : undefined as T;
  } catch {
    throw new AdventStorageError(503);
  }
}

export function rpc<T>(name: string, body: object = {}) {
  return db<T>(`rpc/${name}`, {}, { method: "POST", body });
}

export async function currentParticipant() {
  const secret = sessionSecret();
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const verified = secret && session ? verifySession(session, Date.now(), secret) : null;
  if (!verified) return null;
  const [account] = await db<Participant[]>("advent_participants", {
    select: "id,email,handle,ref_code,badge_public,marketing_opt_in,reminders_opt_in,session_version",
    id: `eq.${verified.id}`,
    session_version: `eq.${verified.version}`,
  });
  return account?.session_version === verified.version ? account : null;
}

export async function currentAdmin() {
  const account = await currentParticipant();
  return account && isAdventAdmin(account.email) ? account : null;
}

export function completions(id: string) {
  return db<Completion[]>("advent_completions", {
    select: "day,completed_at,on_time",
    participant_id: `eq.${id}`,
    order: "day.asc",
  });
}

export function doorStats() {
  return rpc<DoorStat[]>("advent_door_stats");
}

export async function publicProfile(handle: string) {
  const [account] = await db<{ id: string; handle: string }[]>("advent_participants", {
    select: "id,handle",
    handle: `eq.${handle}`,
    badge_public: "eq.true",
  });
  if (!account) return null;
  const count = (await completions(account.id)).length;
  return { handle: account.handle, count };
}
