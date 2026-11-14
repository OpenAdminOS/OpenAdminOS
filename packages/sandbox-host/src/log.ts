export type LogLevel = "info" | "warn" | "error";

/**
 * One line per event on stdout: time, level, message and key=value pairs.
 * Callers pass ids, reason codes and counts only, never tokens, secrets
 * or tenant data.
 */
export type SandboxLogger = (level: LogLevel, message: string, fields?: Record<string, string | number | boolean | undefined>) => void;

export function createLineLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`), now: () => Date = () => new Date()): SandboxLogger {
  return (level, message, fields) => {
    const pairs = Object.entries(fields ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${formatValue(value as string | number | boolean)}`);
    write([now().toISOString(), level.toUpperCase(), message.replace(/[\r\n]+/g, " "), ...pairs].join(" "));
  };
}

function formatValue(value: string | number | boolean): string {
  const text = String(value).replace(/[\r\n]+/g, " ");
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}
