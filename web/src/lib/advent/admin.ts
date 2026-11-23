import { randomBytes } from "node:crypto";

import { db, rpc } from "./db";
import type { Draw } from "./db";
import { drawWinners, eligibleList, hashEligibleList, sortCandidates } from "./eligibility";
import type { Candidate, EligibilityRow } from "./eligibility";
import { CAMPAIGN_CLOSE, doorWindowEnd } from "./time";

export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function drawOpens(day: number | null) {
  return day === null ? CAMPAIGN_CLOSE : doorWindowEnd(day);
}

export function draws() {
  return db<Draw[]>("advent_draws", { order: "created_at.desc" });
}

export async function candidates(day: number | null) {
  const rows = await rpc<EligibilityRow[]>("advent_draw_candidates", { p_day: day });
  return sortCandidates(eligibleList(rows, day === null ? "grand" : "daily"));
}

export async function recordDraw(day: number | null, now: number, email: string) {
  const eligible = await candidates(day);
  const seed = randomBytes(32);
  await db("advent_draws", {}, {
    method: "POST",
    body: {
      kind: day === null ? "grand" : "daily",
      day,
      created_at: new Date(now).toISOString(),
      eligible_count: eligible.length,
      eligible_list: eligible,
      eligible_list_sha256: hashEligibleList(eligible),
      random_bytes_hex: seed.toString("hex"),
      winner_participant_ids: drawWinners(eligible, seed, day === null ? 3 : 1),
      created_by_email: email,
    },
  });
}

export async function drawCsv(day: number | null, list: "eligible" | "winners") {
  const [record] = await db<Pick<Draw, "eligible_list" | "winner_participant_ids">[]>("advent_draws", {
    day: day === null ? "is.null" : `eq.${day}`,
    select: "eligible_list,winner_participant_ids",
  });
  if (!record && list === "winners") return null;
  let eligible = record?.eligible_list ?? await candidates(day);
  if (list === "winners") {
    const entries = new Map(eligible.map((candidate) => [candidate.id, candidate]));
    eligible = record!.winner_participant_ids.map((id) => entries.get(id)!);
  }
  return makeCsv(eligible);
}

function csvCell(value: string) {
  const escaped = /^[=+\-@\s]/u.test(value) ? `'${value}` : value;
  return `"${escaped.replaceAll('"', '""')}"`;
}

async function makeCsv(eligible: Candidate[]) {
  const accounts = new Map<string, { email: string; handle: string }>();
  // Keep each PostgREST filter URL short and stay below its result row limit.
  for (let offset = 0; offset < eligible.length; offset += 100) {
    const ids = eligible.slice(offset, offset + 100).map(({ id }) => id);
    const rows = await db<{ id: string; email: string; handle: string }[]>("advent_participants", {
      select: "id,email,handle",
      id: `in.(${ids.join(",")})`,
    });
    for (const row of rows) accounts.set(row.id, row);
  }
  const csv = ["email,handle,entries"];
  for (const { id, entries } of eligible) {
    const account = accounts.get(id);
    if (account) csv.push(`${csvCell(account.email)},${csvCell(account.handle)},${entries}`);
  }
  return csv.join("\r\n") + "\r\n";
}
