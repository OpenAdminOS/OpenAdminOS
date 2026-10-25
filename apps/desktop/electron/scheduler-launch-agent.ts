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

function unescapePlistValue(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function launchAgentProgramArguments(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!array) return [];
  return [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
    unescapePlistValue(match[1]),
  );
}

/**
 * Whether an installed app should take over a scheduler LaunchAgent that
 * another copy wrote. Only agents that cannot be the installed scheduler
 * qualify: one that runs a development checkout (Electron plus an app
 * path) or one whose binary no longer exists. An agent that launches
 * another installed copy stays, so opening the app from a mounted DMG or
 * a translocated download does not move the scheduler off /Applications.
 */
export function shouldRepointLaunchAgent(
  plist: string,
  binaryExists: (path: string) => boolean,
): boolean {
  const [binary, ...rest] = launchAgentProgramArguments(plist);
  if (!binary) return true;
  if (rest.length !== 1) return true;
  return !binaryExists(binary);
}
