import assert from "node:assert/strict";
import { it } from "node:test";
import { formatCacheRefreshTime, formatChatDateTime, formatDeviceSyncDate } from "../src/shared/chat-date-time.js";

const locale = "en-GB";
const timeZone = "Europe/Berlin";
const dateTimeFormat = new Intl.DateTimeFormat(locale, {
  timeZone, year: "numeric", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit",
});

it("returns no label for invalid timestamps", () => {
  assert.equal(formatChatDateTime(new Date(NaN)), undefined);
  assert.equal(formatCacheRefreshTime("invalid"), undefined);
  assert.equal(formatDeviceSyncDate("invalid"), undefined);
});

it("preserves the stale cache marker and hides never-synced device dates", () => {
  assert.equal(formatCacheRefreshTime("1970-01-01T00:00:00.000Z"), "before the last write");
  assert.equal(formatDeviceSyncDate("0001-01-01T00:00:00Z"), undefined);
});

it("falls back safely for an unsupported locale or time zone", () => {
  const date = new Date("2025-03-30T01:00:00Z");
  const year = "numeric";
  for (const invalidLocale of ["", "en_US", "xyz-XYZ"]) {
    assert.equal(formatChatDateTime(date, { locale: invalidLocale, timeZone, year }), formatChatDateTime(date, { timeZone, year }));
  }
  assert.equal(formatChatDateTime(date, { locale, timeZone: "Invalid/Zone", year }), formatChatDateTime(date, { locale, year }));
});

it("uses the zone's offset through the DST gap and the repeated hour", () => {
  const spring = ["2025-03-30T00:59:00Z", "2025-03-30T01:00:00Z"];
  const fall = ["2025-10-26T00:30:00Z", "2025-10-26T01:30:00Z"];
  for (const timestamp of [...spring, ...fall]) {
    assert.equal(formatCacheRefreshTime(timestamp, { locale, timeZone }), dateTimeFormat.format(new Date(timestamp)));
  }
  assert.notEqual(formatCacheRefreshTime(spring[0]!, { locale, timeZone }), formatCacheRefreshTime(spring[1]!, { locale, timeZone }));
  assert.equal(formatCacheRefreshTime(fall[0]!, { locale, timeZone }), formatCacheRefreshTime(fall[1]!, { locale, timeZone }));
});

it("uses the local date and includes the year for a previous year", () => {
  const timestamp = "2000-01-01T02:00:00Z";
  const timeZone = "America/Los_Angeles";
  assert.equal(formatDeviceSyncDate(timestamp, { locale, timeZone }), new Intl.DateTimeFormat(locale, {
    timeZone, year: "numeric", month: "short", day: "numeric",
  }).format(new Date(timestamp)));
  const now = new Date();
  assert.equal(formatDeviceSyncDate(now.toISOString(), { locale, timeZone }), new Intl.DateTimeFormat(locale, {
    timeZone, month: "short", day: "numeric",
  }).format(now));
});
