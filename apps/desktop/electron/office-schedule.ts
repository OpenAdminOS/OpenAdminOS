import type { OfficePersonaInput } from "@openadminos/agent-sdk";

type Schedule = Pick<
  OfficePersonaInput,
  "intervalMinutes" | "calendar" | "quietHours"
>;
const clocks = new Map<string, Intl.DateTimeFormat>();
function parts(now: number, zone: string) {
  if (typeof zone !== "string" || !zone.trim())
    throw new Error("A time zone is required.");
  let clock = clocks.get(zone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    if (clocks.size > 64) clocks.clear();
    clocks.set(zone, clock);
  }
  const p = Object.fromEntries(
    clock.formatToParts(now).map((p) => [p.type, p.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    hour: Number(p.hour),
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
  };
}
export function validateOfficeSchedule(p: Schedule) {
  if (p.calendar) {
    const c = p.calendar;
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.time) ||
      !Array.isArray(c.weekdays) ||
      !c.weekdays.length ||
      c.weekdays.length > 7 ||
      c.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    )
      throw new Error("Choose a valid local time and at least one weekday.");
    try {
      parts(Date.now(), c.timeZone);
    } catch {
      throw new Error("Choose a valid IANA time zone, such as Europe/Berlin.");
    }
  }
  if (p.quietHours) {
    const q = p.quietHours;
    if (
      ![q.start, q.end].every(
        (h) => Number.isInteger(h) && h >= 0 && h <= 23,
      ) ||
      q.start === q.end
    )
      throw new Error(
        "Quiet hours need different start and end hours between 0 and 23.",
      );
    try {
      parts(Date.now(), q.timeZone);
    } catch {
      throw new Error("Choose a valid time zone for quiet hours.");
    }
  }
}
export function officeQuiet(p: Schedule, now: number) {
  if (!p.quietHours) return false;
  const q = p.quietHours,
    h = parts(now, q.timeZone).hour;
  return q.start < q.end
    ? h >= q.start && h < q.end
    : h >= q.start || h < q.end;
}
/** UTC iteration handles DST gaps and repeated local hours without constructing ambiguous local dates.
 * Run once after wake; the next slot is strictly after now, with no catch-up burst. */
export function nextOfficeRun(p: Schedule, now: number): string | undefined {
  if (!p.calendar && p.intervalMinutes === null) return undefined;
  let next = p.calendar
    ? Math.floor(now / 60000) * 60000 + 60000
    : now + p.intervalMinutes! * 60000;
  for (let i = 0; i < 8 * 24 * 60; i++, next += 60000) {
    if (officeQuiet(p, next)) continue;
    if (p.calendar) {
      const local = parts(next, p.calendar.timeZone);
      if (
        !p.calendar.weekdays.includes(local.day) ||
        local.time !== p.calendar.time
      )
        continue;
      // A repeated DST hour belongs to the same local calendar date: suppress its second occurrence.
      let repeated = false;
      for (let minutes = 1; minutes <= 180; minutes++) {
        const previous = parts(next - minutes * 60000, p.calendar.timeZone);
        if (previous.date === local.date && previous.time === local.time) {
          repeated = true;
          break;
        }
      }
      if (repeated) continue;
    }
    return new Date(next).toISOString();
  }
  throw new Error(
    "The calendar schedule is entirely inside quiet hours. Choose another time.",
  );
}
