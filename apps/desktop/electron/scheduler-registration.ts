import { join } from "node:path";

function escapePlistValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Renders the per-user LaunchAgent that wakes the scheduler. The output is
 * deterministic so the app can compare it with the file on disk and tell
 * whether the registered agent still launches this copy of the app.
 */
export function macosSchedulerPlist({
  label,
  programArguments,
  logDir,
}: {
  label: string;
  programArguments: string[];
  logDir: string;
}): string {
  const args = programArguments
    .map((arg) => `    <string>${escapePlistValue(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlistValue(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${escapePlistValue(join(logDir, "scheduler.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlistValue(join(logDir, "scheduler.error.log"))}</string>
</dict>
</plist>
`;
}

export type SchedulerRegistrationState = "missing" | "stale" | "registered";

function unescapeXmlValue(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

/**
 * "stale" covers registrations that cannot be the installed scheduler: one
 * that runs a development checkout (Electron plus an app path) or one whose
 * binary no longer exists. Any other registration is "registered", even
 * when it launches a different installed copy, so opening the app from a
 * mounted DMG, a translocated download, or a second install location does
 * not move the scheduler away from the copy that registered it.
 */
function classifySchedulerCommand(
  args: string[],
  binaryExists: (path: string) => boolean,
): SchedulerRegistrationState {
  const [binary, ...rest] = args;
  if (!binary || rest.length !== 1 || !binaryExists(binary)) return "stale";
  return "registered";
}

function launchAgentProgramArguments(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!array) return [];
  return [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
    unescapeXmlValue(match[1]),
  );
}

/** Classifies the scheduler LaunchAgent on disk (`undefined` when there is none). */
export function launchAgentState(
  plist: string | undefined,
  binaryExists: (path: string) => boolean,
): SchedulerRegistrationState {
  if (plist === undefined) return "missing";
  return classifySchedulerCommand(launchAgentProgramArguments(plist), binaryExists);
}

function windowsTaskCommand(xml: string): string[] {
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(xml);
  if (!command) return [];
  const binary = unescapeXmlValue(command[1]).trim().replace(/^"(.*)"$/, "$1");
  const argumentsText = unescapeXmlValue(/<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)?.[1] ?? "");
  const args = [...argumentsText.matchAll(/"([^"]*)"|(\S+)/g)].map(
    (match) => match[1] ?? match[2],
  );
  return [binary, ...args];
}

/**
 * Classifies the Windows scheduler task from `schtasks /Query /XML` output
 * (`undefined` when the task does not exist).
 */
export function windowsTaskState(
  xml: string | undefined,
  binaryExists: (path: string) => boolean,
): SchedulerRegistrationState {
  if (xml === undefined) return "missing";
  return classifySchedulerCommand(windowsTaskCommand(xml), binaryExists);
}

/** The executable a stale Windows task launches, so startup can wait for it to exit. */
export function windowsTaskBinary(xml: string): string | undefined {
  return windowsTaskCommand(xml)[0] || undefined;
}
