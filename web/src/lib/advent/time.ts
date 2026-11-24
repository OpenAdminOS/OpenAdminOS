export const DOOR_COUNT = 24;
export const CAMPAIGN_ZONE = "Europe/Berlin";

const offsetFormatter = new Intl.DateTimeFormat("en", {
  timeZone: CAMPAIGN_ZONE,
  timeZoneName: "longOffset",
});

function berlinTime(day: number, hour: number) {
  const wallTime = Date.UTC(2026, 11, day, hour);
  const offset = offsetFormatter.formatToParts(wallTime)
    .find((part) => part.type === "timeZoneName")?.value;
  if (offset === "GMT") return wallTime;

  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset ?? "");
  if (!match) throw new Error("Could not resolve the campaign time zone.");
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return wallTime - (match[1] === "+" ? minutes : -minutes) * 60_000;
}

export const CAMPAIGN_CLOSE = berlinTime(32, 0);
const campaignDayFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: CAMPAIGN_ZONE, day: "numeric" });

export function campaignDoorForDate(now: number) {
  if (now < berlinTime(1, 0) || now >= berlinTime(DOOR_COUNT + 1, 0)) return null;
  return Number(campaignDayFormatter.format(now));
}

export function reminderDoorAt(now: number) {
  const day = campaignDoorForDate(now);
  return day !== null && now >= doorUnlock(day) ? day : null;
}

export function parseDay(value: string) {
  return /^(?:[1-9]|1[0-9]|2[0-4])$/.test(value) ? Number(value) : null;
}

export function doorUnlock(day: number) {
  return berlinTime(day, 6);
}

export function doorWindowEnd(day: number) {
  return doorUnlock(day + 1);
}

export function doorState(day: number, now: number) {
  if (now < doorUnlock(day)) return "locked";
  if (now >= CAMPAIGN_CLOSE) return "closed";
  return "open";
}

export function isOnTime(day: number, now: number) {
  return now >= doorUnlock(day) && now < doorWindowEnd(day);
}

export function campaignNow(override?: string, environment = process.env.NODE_ENV) {
  if (environment !== "production" && override && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(override)) {
    const timestamp = Date.parse(override);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Date.now();
}


const berlinDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAMPAIGN_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

export function berlinDateKey(now: number) {
  const parts = berlinDateFormatter.formatToParts(now);
  return ["year", "month", "day"].map((name) => parts.find((part) => part.type === name)?.value).join("-");
}

export function validDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
