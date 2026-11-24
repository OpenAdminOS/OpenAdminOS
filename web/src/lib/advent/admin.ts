import { randomBytes } from "node:crypto";

import { db, rpc } from "./db";
import type { Draw } from "./db";
import { drawWinners, eligibleList, hashEligibleList, sortCandidates } from "./eligibility";
import type { Candidate, EligibilityRow } from "./eligibility";
import { berlinDateKey, CAMPAIGN_CLOSE, doorWindowEnd } from "./time";

export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const DELETED_WINNER = "Account deleted after the draw. Run a replacement draw.";

export type Retention = { prizes_fulfilled_at: string | null; winners_deleted_at: string | null };
export type DrawAccount = { id: string; email: string; handle: string };
type DrawStatus = "ok" | "stale" | "invalid" | "occupied" | "empty" | "fulfilled";
type ReplacementOffer = { status: "ok"; eligible: Candidate[]; predecessor: string }
  | { status: Exclude<DrawStatus, "ok"> };

export function drawOpens(day: number | null) {
  return day === null ? CAMPAIGN_CLOSE : doorWindowEnd(day);
}

export function draws() {
  return db<Draw[]>("advent_draws", { order: "created_at.desc,id.asc" });
}

export async function retention() {
  const [status] = await db<Retention[]>("advent_retention", {
    select: "prizes_fulfilled_at,winners_deleted_at",
    campaign: "eq.true",
  });
  return status ?? null;
}

async function candidates(day: number | null) {
  const rows = await rpc<EligibilityRow[]>("advent_draw_candidates", { p_day: day });
  return eligibleList(rows, day === null ? "grand" : "daily");
}

function drawRecord(eligible: Candidate[], now: number, email: string, prizes: number) {
  const snapshot = sortCandidates(eligible);
  const seed = randomBytes(32);
  return {
    created_at: new Date(now).toISOString(),
    eligible_count: snapshot.length,
    eligible_list: snapshot,
    eligible_list_sha256: hashEligibleList(snapshot),
    random_bytes_hex: seed.toString("hex"),
    winner_participant_ids: drawWinners(snapshot, seed, prizes),
    created_by_email: email,
  };
}

export async function recordDraw(day: number | null, now: number, email: string) {
  const eligible = await candidates(day);
  return rpc<DrawStatus>("advent_record_draw", {
    p_record: {
      ...drawRecord(eligible, now, email, day === null ? 3 : 1),
      kind: day === null ? "grand" : "daily",
      day,
    },
  });
}

export async function recordReplacement(originalId: string, slot: number, now: number, email: string) {
  const offer = await rpc<ReplacementOffer>("advent_replacement_offer", {
    p_original_id: originalId,
    p_slot: slot,
    p_now: new Date(now).toISOString(),
  });
  if (offer.status !== "ok") return offer.status;
  return rpc<DrawStatus>("advent_record_draw", {
    p_record: {
      ...drawRecord(offer.eligible, now, email, 1),
      kind: "replacement",
      original_draw_id: originalId,
      replaces_draw_id: offer.predecessor,
      prize_slot: slot,
    },
  });
}

export function winnerSlots(original: Draw, records: Draw[]) {
  return original.winner_participant_ids.map((winner, index) => {
    const slot = index + 1;
    const replacements = records.filter((record) => record.original_draw_id === original.id && record.prize_slot === slot);
    const history: Draw[] = [];
    let latest = original;
    for (let index = 0; index < replacements.length; index++) {
      const replacement = replacements.find((record) => record.replaces_draw_id === latest.id);
      if (!replacement) break;
      history.push(replacement);
      latest = replacement;
    }
    if (latest !== original) winner = latest.winner_participant_ids[0]!;
    const entries = latest.eligible_list.find(({ id }) => id === winner)?.entries;
    return { slot, id: winner, entries, history };
  });
}

export function winnerAccounts(records: Draw[]) {
  return lookupAccounts(records.flatMap(({ winner_participant_ids }) => winner_participant_ids));
}

export async function drawCsv(day: number | null, list: "eligible" | "winners", now: number) {
  const kind = day === null ? "grand" : "daily";
  const [original] = await db<Draw[]>("advent_draws", {
    kind: `eq.${kind}`,
    day: day === null ? "is.null" : `eq.${day}`,
  });

  if (list === "eligible") {
    const eligible = original?.eligible_list ?? sortCandidates(await candidates(day));
    const accounts = await lookupAccounts(eligible.map(({ id }) => id));
    const csv = ["email,handle,entries"];
    for (const { id, entries } of eligible) {
      const account = accounts.get(id);
      if (account) csv.push(`${csvCell(account.email)},${csvCell(account.handle)},${entries}`);
    }
    return csv.join("\r\n") + "\r\n";
  }

  if (!original) return null;
  const [replacements, retentionState] = await Promise.all([
    db<Draw[]>("advent_draws", { original_draw_id: `eq.${original.id}` }),
    retention(),
  ]);
  const winners = winnerSlots(original, replacements);
  const accounts = await lookupAccounts(winners.map(({ id }) => id));
  const csv = ["email,handle,entries,prize_slot,status"];
  const finalized = Boolean(retentionState?.prizes_fulfilled_at && retentionState.prizes_fulfilled_at <= berlinDateKey(now));
  const missing = retentionState?.winners_deleted_at ? "Winner records deleted after prize fulfilment."
    : finalized ? "Account deleted after the draw." : DELETED_WINNER;
  for (const { id, entries, slot } of winners) {
    const account = accounts.get(id);
    const status = account ? "Winner" : missing;
    csv.push(`${csvCell(account?.email ?? "")},${csvCell(account?.handle ?? "")},${entries ?? ""},${slot},${csvCell(status)}`);
  }
  return csv.join("\r\n") + "\r\n";
}

function csvCell(value: string) {
  const escaped = /^[=+\-@\s]/u.test(value) ? `'${value}` : value;
  return `"${escaped.replaceAll('"', '""')}"`;
}

async function lookupAccounts(accountIds: string[]) {
  const uniqueIds = [...new Set(accountIds)];
  const accounts = new Map<string, DrawAccount>();
  // Keep each filter URL short and below the PostgREST result row limit.
  for (let offset = 0; offset < uniqueIds.length; offset += 100) {
    const ids = uniqueIds.slice(offset, offset + 100);
    const rows = await db<DrawAccount[]>("advent_participants", {
      select: "id,email,handle",
      id: `in.(${ids.join(",")})`,
    });
    for (const row of rows) accounts.set(row.id, row);
  }
  return accounts;
}
