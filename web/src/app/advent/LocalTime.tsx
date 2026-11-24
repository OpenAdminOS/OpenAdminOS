"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

export function LocalTime({ timestamp, unlock = false, showYear = false }: { timestamp: number; unlock?: boolean; showYear?: boolean }) {
  const isBrowser = useSyncExternalStore(subscribe, () => true, () => false);
  const date = new Date(timestamp);
  const format = (timeZone: string | undefined) => new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: showYear ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: unlock ? undefined : "short",
    timeZone,
  }).format(date);
  const time = format(isBrowser ? undefined : "Europe/Berlin");
  // A visitor on Berlin time would otherwise read "06:00 · 06:00 CET".
  const sameAsBerlin = time === format("Europe/Berlin");
  return <time dateTime={date.toISOString()}>{time}{unlock ? (sameAsBerlin ? " CET" : " · 06:00 CET") : ""}</time>;
}
