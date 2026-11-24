import { createHmac, randomUUID } from "node:crypto";

import { getRedis, keys } from "../stats/redis";
import { clientIp } from "./client-ip";

const HOUR_MS = 60 * 60 * 1000;
// This budget is shared across accounts and doors, including offices behind one IP.
const WRONG_ANSWERS_PER_IP_PER_HOUR = 100;

const RESERVE_ANSWER_SLOT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return 1
`;

export async function reserveWrongAnswer(request: Request, pepper: string) {
  const redis = getRedis();
  const ipHash = createHmac("sha256", pepper).update(`advent-answer-ip:${clientIp(request)}`).digest("hex");
  const key = keys.adventWrongAnswerRate(ipHash);
  const member = randomUUID();

  // Reserve before checking so concurrent submissions cannot overspend the budget.
  // Keep the slot only for a wrong answer or an indeterminate database response.
  const allowed = await redis.eval<unknown[], number>(
    RESERVE_ANSWER_SLOT, [key], [Date.now(), HOUR_MS, WRONG_ANSWERS_PER_IP_PER_HOUR, member],
  );
  return allowed === 1 ? { release: () => redis.zrem(key, member) } : null;
}
