import { createHash } from "node:crypto";

export const BADGE_DOORS = 12;
export const GRAND_DOORS = 18;
export const REFERRAL_CAP = 5;

export type Candidate = { id: string; entries: number };
export type EligibilityRow = { id: string; completed: number; referrals: number };

export function earnsBadge(completed: number) {
  return completed >= BADGE_DOORS;
}

export function grandEntries(completed: number, referrals: number) {
  return completed >= GRAND_DOORS ? 1 + Math.min(REFERRAL_CAP, referrals) : 0;
}

export function eligibleList(rows: EligibilityRow[], kind: "daily" | "grand") {
  return rows.map(({ id, completed, referrals }) => ({
    id,
    entries: kind === "daily" ? (completed > 0 ? 1 : 0) : grandEntries(completed, referrals),
  })).filter(({ entries }) => entries > 0);
}

export function sortCandidates(candidates: Candidate[]) {
  return [...candidates].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function hashEligibleList(candidates: Candidate[]) {
  const canonical = sortCandidates(candidates).map(({ id, entries }) => `${id},${entries}\n`).join("");
  return createHash("sha256").update(canonical).digest("hex");
}

export function drawWinners(candidates: Candidate[], seed: Uint8Array, count: number) {
  const remaining = sortCandidates(candidates);
  const winners: string[] = [];
  let counter = 0;

  // For each prize, hash the 32-byte seed followed by a big-endian uint32 counter
  // starting at zero. Interpret the hash as an unsigned big-endian integer. Reject
  // values in the incomplete top interval to avoid modulo bias, incrementing the
  // counter on every hash. Walk the UUID-sorted list by entry weight, then remove
  // the winner and all their entries before selecting the next prize.
  while (winners.length < count && remaining.length > 0) {
    const weight = BigInt(remaining.reduce((sum, candidate) => sum + candidate.entries, 0));
    const space = 1n << 256n;
    const ceiling = space - space % weight;
    let value: bigint;
    do {
      const index = Buffer.alloc(4);
      index.writeUInt32BE(counter++);
      const digest = createHash("sha256").update(seed).update(index).digest("hex");
      value = BigInt(`0x${digest}`);
    } while (value >= ceiling);

    let ticket = Number(value % weight);
    const winner = remaining.findIndex(({ entries }) => (ticket -= entries) < 0);
    winners.push(remaining.splice(winner, 1)[0]!.id);
  }
  return winners;
}
