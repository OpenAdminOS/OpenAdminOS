import { loadSandboxConfig, type SandboxConfig } from "./config.js";
import { assertSupportedPlatform, describe } from "./files.js";
import { SandboxHost, type SandboxHostDeps } from "./host.js";
import { createLineLogger, type SandboxLogger } from "./log.js";
import { isSandboxRefusal } from "./refusal.js";

export const EXIT_OK = 0;
export const EXIT_RUN_REFUSED = 1;
export const EXIT_CONFIG = 2;
export const EXIT_ALREADY_RUNNING = 3;

const USAGE = "Usage: openadminos-sandbox --config <path> [--once <agentId>]";

export interface ParsedArgs {
  configPath: string;
  once?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let configPath: string | undefined;
  let once: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--config" && value && !value.startsWith("--")) {
      configPath = value;
      index += 1;
    } else if (arg === "--once" && value && !value.startsWith("--")) {
      once = value;
      index += 1;
    } else {
      throw new Error(`${arg} is not a known option. ${USAGE}`);
    }
  }
  if (!configPath) throw new Error(`--config is required. ${USAGE}`);
  return { configPath, ...(once ? { once } : {}) };
}

/**
 * The service entry point. Without `--once` it runs the schedule until
 * SIGINT or SIGTERM. With `--once <agentId>` it is a setup check: the
 * preflight and one run, then an exit code that says how it went.
 */
export async function main(
  argv: readonly string[],
  options: { log?: SandboxLogger; deps?: SandboxHostDeps; waitForSignal?: () => Promise<void> } = {},
): Promise<number> {
  const log = options.log ?? createLineLogger();
  let args: ParsedArgs;
  let config: SandboxConfig;
  try {
    assertSupportedPlatform(options.deps?.platform);
    args = parseArgs(argv);
    config = loadSandboxConfig(args.configPath);
  } catch (error) {
    log("error", describe(error), { reason: isSandboxRefusal(error) ? error.reason : "usage" });
    return EXIT_CONFIG;
  }
  let host: SandboxHost;
  try {
    host = new SandboxHost(config, { ...options.deps, log });
    host.open();
  } catch (error) {
    log("error", describe(error), { reason: isSandboxRefusal(error) ? error.reason : "startup-failed" });
    return isSandboxRefusal(error) && error.reason === "already-running" ? EXIT_ALREADY_RUNNING : EXIT_CONFIG;
  }
  log("info", "Sandbox host started.", { sandbox: config.sandbox.id, agents: config.agents.length, mode: args.once ? "once" : "service" });

  if (args.once) {
    const agent = config.agents.find((candidate) => candidate.id === args.once);
    try {
      if (!agent) {
        log("error", `${args.once} is not in the sandbox config. Add it under agents with its templateSha256.`, { reason: "agent-not-found" });
        return EXIT_CONFIG;
      }
      const outcome = await host.runAgent(agent, "person");
      if (outcome.kind === "completed") {
        log("info", "Setup check passed.", { agent: agent.id, run: outcome.run.id });
        return EXIT_OK;
      }
      log("error", "Setup check did not pass.", { agent: agent.id, reason: outcome.reason });
      return EXIT_RUN_REFUSED;
    } finally {
      await host.close();
    }
  }

  host.startSchedule();
  await (options.waitForSignal ?? waitForStopSignal)();
  log("info", "Stopping: runs in progress are stopped and recorded.", { sandbox: config.sandbox.id });
  await host.close();
  log("info", "Sandbox host stopped.", { sandbox: config.sandbox.id });
  return EXIT_OK;
}

function waitForStopSignal(): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const onSignal = () => {
      if (stopping) process.exit(130);
      stopping = true;
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}
