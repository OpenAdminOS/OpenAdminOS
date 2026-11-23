export interface ChatDateTimeLocale {
  locale?: string;
  timeZone?: string;
}

interface ChatDateTimeOptions extends ChatDateTimeLocale {
  year?: "numeric";
}

export function formatChatDateTime(
  date: Date,
  { locale, timeZone, year }: ChatDateTimeOptions = {},
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatCacheRefreshTime(
  timestamp: string,
  options?: ChatDateTimeLocale,
): string | undefined {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  // The cache marks a snapshot stale after a write by setting its time to the epoch.
  if (date.getTime() === 0) return "before the last write";
  return formatChatDateTime(date, { ...options, year: "numeric" });
}
