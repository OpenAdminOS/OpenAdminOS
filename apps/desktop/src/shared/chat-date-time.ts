export interface ChatDateTimeLocale {
  locale?: string;
  timeZone?: string;
}

interface ChatDateTimeOptions extends ChatDateTimeLocale {
  dateOnly?: boolean;
  year?: "numeric";
}

export function supportedChatLocale(locale: string): string | undefined {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(locale)[0];
  } catch {
    return undefined;
  }
}

export function formatChatDateTime(
  date: Date,
  { locale, timeZone, dateOnly, year }: ChatDateTimeOptions = {},
): string | undefined {
  if (!Number.isFinite(date.getTime())) return undefined;
  if (locale !== undefined) locale = supportedChatLocale(locale);
  const yearOptions = { timeZone, year: "numeric" } as const;
  let calendarYear: Intl.DateTimeFormat;
  try {
    calendarYear = new Intl.DateTimeFormat(locale, yearOptions);
  } catch {
    timeZone = undefined;
    calendarYear = new Intl.DateTimeFormat(locale, { year: "numeric" });
  }
  const showYear = year ?? (calendarYear.format(date) !== calendarYear.format(new Date()) ? "numeric" : undefined);

  // Two instants in the repeated hour at the end of DST can share a label.
  // The original timestamp remains available in the machine data.
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: showYear,
    month: "short",
    day: "numeric",
    ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(date);
}

export function formatDeviceSyncDate(
  timestamp: string,
  options?: ChatDateTimeLocale,
): string | undefined {
  const date = new Date(timestamp);
  // Intune uses a year-one timestamp for a device that never synced.
  if (date.getUTCFullYear() < 1971) return undefined;
  return formatChatDateTime(date, { ...options, dateOnly: true });
}

export function formatCacheRefreshTime(
  timestamp: string,
  options?: ChatDateTimeLocale,
): string | undefined {
  const date = new Date(timestamp);
  // The cache marks a snapshot stale after a write by setting its time to the epoch.
  if (date.getTime() === 0) return "before the last write";
  return formatChatDateTime(date, { ...options, year: "numeric" });
}
