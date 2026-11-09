/**
 * A Microsoft 365 service as a two-letter mark (mockup 32). A service that
 * is not connected is always dashed with muted letters, wherever it shows.
 */
const LETTERS: Readonly<Record<string, string>> = { intune: "In", entra: "En", defender: "De" };

/** The two letters a service is marked with. */
export function serviceLetters(service: string, title: string): string {
  return LETTERS[service] ?? title.slice(0, 2);
}

export function ServiceMark({ service, title, size = 22, off = false }: { service: string; title: string; size?: 17 | 22 | 30; off?: boolean }) {
  const letters = serviceLetters(service, title);
  return (
    <span
      aria-hidden="true"
      data-off={off ? "true" : undefined}
      className="service-mark inline-flex shrink-0 items-center justify-center font-medium"
      style={{ width: size, height: size, fontSize: size >= 30 ? 12 : size >= 22 ? 11 : 9, borderRadius: size >= 30 ? 8 : 6 }}
    >
      {letters}
    </span>
  );
}
