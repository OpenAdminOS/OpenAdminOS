import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextOfficeRun,
  officeQuiet,
  validateOfficeSchedule,
} from "./office-schedule.js";
const daily = {
  intervalMinutes: null,
  calendar: {
    time: "09:00",
    timeZone: "Europe/Berlin",
    weekdays: [1, 2, 3, 4, 5],
  },
};
test("calendar uses local weekdays and adjusts UTC execution across DST", () => {
  assert.equal(
    nextOfficeRun(daily, Date.parse("2026-03-27T09:00:00Z")),
    "2026-03-30T07:00:00.000Z",
  );
  assert.equal(
    nextOfficeRun(daily, Date.parse("2026-10-23T09:00:00Z")),
    "2026-10-26T08:00:00.000Z",
  );
});
test("DST gaps skip and repeated local times run once", () => {
  const p = {
    intervalMinutes: null,
    calendar: { time: "02:30", timeZone: "Europe/Berlin", weekdays: [0] },
  };
  assert.equal(
    nextOfficeRun(p, Date.parse("2026-03-28T12:00:00Z")),
    "2026-04-05T00:30:00.000Z",
  );
  assert.equal(
    nextOfficeRun(p, Date.parse("2026-10-25T00:31:00Z")),
    "2026-11-01T01:30:00.000Z",
  );
});
test("quiet hours defer intervals, reject impossible calendars, and validate zones", () => {
  const p = {
    intervalMinutes: 5,
    quietHours: { start: 18, end: 8, timeZone: "UTC" },
  };
  assert.equal(
    nextOfficeRun(p, Date.parse("2026-09-11T17:58:00Z")),
    "2026-09-12T08:00:00.000Z",
  );
  assert.equal(officeQuiet(p, Date.parse("2026-09-11T19:00:00Z")), true);
  assert.throws(
    () =>
      nextOfficeRun(
        {
          ...daily,
          quietHours: { start: 8, end: 10, timeZone: "Europe/Berlin" },
        },
        Date.now(),
      ),
    /entirely inside/,
  );
  assert.throws(
    () =>
      validateOfficeSchedule({
        ...daily,
        calendar: { ...daily.calendar, timeZone: "unknown-zone" },
      }),
    /valid IANA/,
  );
});

test("half-hour daylight-saving overlaps do not repeat a local calendar slot", () => {
  const p = {
    intervalMinutes: null,
    calendar: { time: "01:45", timeZone: "Australia/Lord_Howe", weekdays: [0] },
  };
  assert.equal(
    nextOfficeRun(p, Date.parse("2026-04-04T14:46:00Z")),
    "2026-04-11T15:15:00.000Z",
  );
});
