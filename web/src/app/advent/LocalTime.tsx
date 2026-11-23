"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

export function LocalTime({ timestamp, unlock = false, showYear = false }: { timestamp: number; unlock?: boolean; showYear?: boolean }) {
  const isBrowser = useSyncExternalStore(subscribe, () => true, () => false);
  const date = new Date(timestamp);
  const time = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: showYear ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: unlock ? undefined : "short",
    timeZone: isBrowser ? undefined : "Europe/Berlin",
  }).format(date);
  return <time dateTime={date.toISOString()}>{time}{unlock ? " · 06:00 CET" : ""}</time>;
}
