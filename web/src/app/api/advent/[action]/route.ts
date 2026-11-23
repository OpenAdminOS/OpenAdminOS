import { after, type NextRequest, NextResponse } from "next/server";

import { SITE_URL } from "~/app/seo";
import { drawCsv, drawOpens, recordDraw } from "~/lib/advent/admin";
import { SESSION_COOKIE, SESSION_SECONDS, signSession } from "~/lib/advent/auth";
import { hashAnswer, normalizeAnswer } from "~/lib/advent/answers";
import {
  adventEnabled, isAdventAdmin, MARKETING_CONSENT_VERSION, missingLoginConfig,
  REMINDERS_CONSENT_VERSION, rulesApproved, sessionSecret, storageConfig,
} from "~/lib/advent/config";
import { AdventStorageError, currentAdmin, currentParticipant, db, rpc } from "~/lib/advent/db";
import type { Participant } from "~/lib/advent/db";
import { validHandle } from "~/lib/advent/identity";
import { allowLoginEmail, consumeLogin, issueLoginLink, parseEmail, previewLogin } from "~/lib/advent/login";
import type { SignupConfirmation, SignupDraft } from "~/lib/advent/login";
import { CAMPAIGN_CLOSE, campaignNow, doorState, isOnTime, parseDay } from "~/lib/advent/time";
import { doors } from "~/content/advent/doors";

type RouteContext = { params: Promise<{ action: string }> };
type Payload = Record<string, unknown>;

const PRIVATE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const SIGN_IN_MESSAGE = "If that address can sign in, a link will arrive shortly. It expires in 15 minutes.";
const ANONYMOUS = new Set(["sign-in", "sign-up", "verify", "verify-preview"]);
const PARTICIPANT = new Set(["complete", "settings", "sign-out", "delete"]);
const ADMIN = new Set(["set-answers", "draw", "purge"]);

function success(message?: string, redirect?: string) {
  return NextResponse.json({ message, redirect }, { headers: PRIVATE });
}

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: PRIVATE });
}

function missing() {
  return fail(404, "Campaign endpoint not found.");
}

function value(body: Payload, key: string) {
  return typeof body[key] === "string" ? body[key] : "";
}

function trustedOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (process.env.NODE_ENV !== "production") {
    // Next normalizes a loopback request URL to localhost even when the browser used 127.0.0.1.
    const host = request.headers.get("host");
    return host && origin === `${request.nextUrl.protocol}//${host}` ? origin : null;
  }
  const preview = process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : null;
  return origin === SITE_URL || origin === preview ? origin : null;
}

function setSession(response: NextResponse, cookie: string, maxAge = SESSION_SECONDS) {
  response.cookies.set(SESSION_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge });
  return response;
}

export async function POST(request: NextRequest, context: RouteContext) {
  if (!adventEnabled()) return missing();
  const requestedAt = new Date().toISOString();
  const { action } = await context.params;
  if (!ANONYMOUS.has(action) && !PARTICIPANT.has(action) && !ADMIN.has(action)) return missing();
  const origin = trustedOrigin(request);
  if (!origin) return fail(403, "Open this form on the campaign site and try again.");

  try {
    let account: Participant | null = null;
    if (!ANONYMOUS.has(action)) {
      account = await currentParticipant();
      if (ADMIN.has(action) && (!account || !isAdventAdmin(account.email))) return missing();
      if (!account) return fail(401, "Sign in to Advent of Admin and try again.");
    }

    let body: Payload;
    try {
      const raw = await request.text();
      if (raw.length > 64_000) return fail(413, "This form is too long. Shorten it and submit again.");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
      body = parsed as Payload;
    } catch {
      return fail(400, "The form data could not be read. Reload the page and try again.");
    }

    const now = campaignNow(process.env.ADVENT_NOW);
    if (account) {
      switch (action) {
        case "complete": return await completeDoor(account, body, now);
        case "settings": return await updateSettings(account, body);
        case "sign-out":
          await rpc<void>("advent_sign_out", { p_id: account.id, p_version: account.session_version });
          return setSession(success(undefined, "/advent"), "", 0);
        case "delete": return await deleteAccount(account, body);
        case "set-answers": return await setAnswers(body);
        case "draw": return await runDraw(account, body, now);
        case "purge": {
          const removed = await rpc<number | null>("advent_purge", { p_now: new Date(now).toISOString() });
          return removed === null
            ? fail(409, "Purge opens 90 days after the grand draw.")
            : success(`Accounts removed: ${removed}.`);
        }
        default: return missing();
      }
    }

    const secret = sessionSecret();
    if (!secret || !storageConfig()) return fail(503, "Campaign accounts are not configured yet.");
    if (action === "verify-preview") {
      const preview = await previewLogin(value(body, "token"), secret);
      if (!preview) return fail(400, "This link is expired or already used. Request a new sign-in link.");
      return NextResponse.json({ preview }, { headers: PRIVATE });
    }
    if (action === "verify") {
      let intent: "signin" | SignupConfirmation;
      if (body.intent === "signin") {
        intent = "signin";
      } else if (body.intent === "signup") {
        const handle = value(body, "handle").trim();
        if (!validHandle(handle)) return fail(400, "Choose a handle using 3 to 24 lowercase letters, digits or internal hyphens. Some names are reserved.");
        if (body.age !== "on" || body.rules !== "on") {
          return fail(400, "Confirm that you are 18 or older and accept the campaign rules.");
        }
        intent = {
          handle,
          discardReferral: body.discard_referral === "on",
          marketing: body.marketing === "on",
          reminders: body.reminders === "on",
        };
      } else {
        return fail(400, "Review the link details and confirm to continue.");
      }

      const result = await consumeLogin(value(body, "token"), secret, now, rulesApproved() && now < CAMPAIGN_CLOSE, intent);
      if (!result || result.status === "invalid") return fail(400, "This link is expired or already used. Request a new sign-in link.");
      if (result.status === "confirmation_required") return fail(400, "Review the link details and confirm to continue.");
      if (result.status === "signup_closed") return fail(409, "Campaign registration is closed or unavailable.");
      if (result.status === "handle_taken") return fail(409, "That handle is taken. Choose a different handle and try again.");
      if (result.status !== "ok") return fail(503, "A referral code could not be assigned. Try the link again.");
      return setSession(success(undefined, "/advent/me"), signSession(result.id, result.version, Date.now(), secret));
    }

    const configuration = missingLoginConfig();
    if (configuration) return fail(503, configuration);

    const email = parseEmail(value(body, "email"));
    if (!email) return fail(400, "Enter a valid email address.");
    let signup: SignupDraft | undefined;
    if (action === "sign-up") {
      if (!rulesApproved()) return fail(409, "Rules are being finalised. Registration will open once they are available.");
      if (now >= CAMPAIGN_CLOSE) return fail(409, "Campaign registration is closed.");
      const handle = value(body, "handle").trim();
      if (!validHandle(handle)) return fail(400, "Choose a handle using 3 to 24 lowercase letters, digits or internal hyphens. Some names are reserved.");
      if (body.age !== "on" || body.rules !== "on") return fail(400, "Confirm that you are 18 or older and accept the campaign rules.");
      signup = {
        handle,
        ref: value(body, "ref"),
        marketing: body.marketing === "on",
        reminders: body.reminders === "on",
      };
    }

    try {
      if (!(await allowLoginEmail(request, email, secret))) {
        return fail(429, "Too many sign-in links were requested. Try again in an hour.");
      }
    } catch {
      return fail(503, "Sign-in rate limiting is temporarily unavailable. Try again later.");
    }
    after(async () => {
      try {
        if (!(await issueLoginLink(origin, email, secret, requestedAt, signup))) {
          console.error("[advent] Sign-in email could not be sent");
        }
      } catch {
        console.error("[advent] Sign-in link could not be issued");
      }
    });
    return success(SIGN_IN_MESSAGE);
  } catch (error) {
    if (error instanceof AdventStorageError) {
      return fail(503, "Campaign storage is temporarily unavailable. Try again later.");
    }
    console.error("[advent] Request failed", action);
    return fail(500, "The campaign request could not be processed. Reload the page and try again.");
  }
}

async function completeDoor(account: Participant, body: Payload, now: number) {
  const day = parseDay(value(body, "day"));
  if (!day) return fail(400, "Choose a door from 1 to 24.");
  const state = doorState(day, now);
  if (state === "locked") return fail(409, "This door has not opened yet.");
  if (state === "closed") return fail(409, "Completions closed on 31 December.");
  const answer = value(body, "answer");
  const feedback = value(body, "feedback").trim();
  if (day === 22 && (feedback.length < 1 || feedback.length > 2000)) {
    return fail(400, "Enter feedback using 1 to 2,000 characters.");
  }
  if (day !== 22 && day !== 24 && (answer.length > 256 || !normalizeAnswer(answer))) {
    return fail(400, "Enter the check answer using 1 to 256 characters.");
  }

  const result = await rpc<{ status: string; remaining?: number }>("advent_complete_door", {
    p_id: account.id,
    p_day: day,
    p_now: new Date(now).toISOString(),
    p_on_time: isOnTime(day, now),
    p_hash: day === 22 || day === 24 ? null : hashAnswer(day, answer),
    p_feedback: day === 22 ? feedback : null,
  });
  switch (result.status) {
    case "done": return success(undefined, `/advent/day/${day}#check`);
    case "private_badge": return fail(409, "Set your badge to public in My Advent, then try again.");
    case "no_answers": return fail(409, "The check for this door is being prepared. Try again later.");
    case "signed_out": return fail(401, "Sign in to Advent of Admin and try again.");
    case "limited": return fail(429, "Too many wrong answers for this door. Try again in an hour.");
    case "wrong": {
      const hint = doors[day - 1]?.hint ?? "That is not what the app shows. Check the answer in the app.";
      const remaining = result.remaining ?? 0;
      if (!remaining) return fail(429, `${hint} No attempts left. Try again in an hour.`);
      return fail(422, `${hint} ${remaining} ${remaining === 1 ? "attempt" : "attempts"} left.`);
    }
    default: return fail(503, "The completion could not be saved. Try again later.");
  }
}

async function updateSettings(account: Participant, body: Payload) {
  const handle = value(body, "handle").trim();
  if (!validHandle(handle)) return fail(400, "Choose a handle using 3 to 24 lowercase letters, digits or internal hyphens. Some names are reserved.");
  try {
    const marketing = body.marketing === "on";
    const reminders = body.reminders === "on";
    const saved = await rpc<boolean>("advent_update_settings", {
      p_id: account.id,
      p_handle: handle,
      p_badge: body.badge === "on",
      p_marketing: marketing === (body.marketing_initial === "on") ? null : marketing,
      p_consent_version: MARKETING_CONSENT_VERSION,
      p_reminders: reminders === (body.reminders_initial === "on") ? null : reminders,
      p_reminders_consent_version: REMINDERS_CONSENT_VERSION,
    });
    if (!saved) return fail(401, "Sign in to Advent of Admin and try again.");
  } catch (error) {
    if (error instanceof AdventStorageError && error.code === "23505") return fail(409, "That handle is taken. Choose another.");
    throw error;
  }
  return success(undefined, "/advent/me#settings");
}

async function deleteAccount(account: Participant, body: Payload) {
  const handle = value(body, "confirm");
  if (handle !== account.handle) return fail(400, "Type your current handle exactly to delete the account.");
  const deleted = await db<{ id: string }[]>("advent_participants", {
    id: `eq.${account.id}`,
    handle: `eq.${handle}`,
    select: "id",
  }, { method: "DELETE", prefer: "return=representation" });
  if (!deleted.length) return fail(409, "Your account changed. Reload My Advent and try again.");
  return setSession(success(undefined, "/advent"), "", 0);
}

async function setAnswers(body: Payload) {
  const day = parseDay(value(body, "day"));
  if (!day || day === 22 || day === 24) return fail(400, "Choose a door that uses a written check answer.");
  const answers = value(body, "answers").split(/\r?\n/).filter((answer) => normalizeAnswer(answer));
  if (answers.length > 50 || answers.some((answer) => answer.length > 256)) {
    return fail(400, "Enter up to 50 accepted answers, one per line, with at most 256 characters each.");
  }
  const hashes = [...new Set(answers.map((answer) => hashAnswer(day, answer)))];
  await db("advent_answers", { on_conflict: "day" }, {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: { day, accepted_hashes: hashes },
  });
  return success(undefined, "/advent/admin#answers");
}

async function runDraw(account: Participant, body: Payload, now: number) {
  const target = value(body, "draw");
  const day = parseDay(target);
  if (!day && target !== "grand") return fail(400, "Choose a daily draw or the grand draw.");
  if (now < drawOpens(day)) return fail(409, "The eligibility window for this draw is still open.");
  try {
    await recordDraw(day, now, account.email);
  } catch (error) {
    if (error instanceof AdventStorageError && error.code === "23505") return fail(409, "This draw already has an audit record. Reload to see it.");
    throw error;
  }
  return success(undefined, "/advent/admin#draws");
}

export async function GET(request: NextRequest, context: RouteContext) {
  if (!adventEnabled() || (await context.params).action !== "export") return missing();
  try {
    if (!(await currentAdmin())) return missing();
    const target = request.nextUrl.searchParams.get("draw") ?? "";
    const list = request.nextUrl.searchParams.get("list");
    const day = parseDay(target);
    if ((!day && target !== "grand") || (list !== "eligible" && list !== "winners")) return missing();
    if (campaignNow(process.env.ADVENT_NOW) < drawOpens(day)) {
      return fail(409, "The eligibility window for this draw is still open.");
    }
    const csv = await drawCsv(day, list);
    if (csv === null) return fail(404, "This draw has no winners export yet.");
    return new Response(csv, {
      headers: {
        ...PRIVATE,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="advent-${target}-${list}.csv"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return fail(503, "The campaign export is temporarily unavailable. Try again later.");
  }
}
