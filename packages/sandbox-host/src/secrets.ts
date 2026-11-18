import { readPrivateFile } from "./files.js";
import { SandboxRefusal } from "./refusal.js";

/** Delivery secrets, kept in a file next to the config with mode 0600. */
export interface SandboxSecrets {
  slack?: { botToken: string };
  discord?: { webhookUrl: string };
}

const DISCORD_WEBHOOK = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

/**
 * Reads the secrets file. Refuses it when other users can read it or
 * another user owns it, and names the connector whose secret is missing.
 */
export function loadSandboxSecrets(path: string, needed: ReadonlySet<"slack" | "discord">): SandboxSecrets {
  if (needed.size === 0) return {};
  const text = readPrivateFile(path, "secrets file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SandboxRefusal("config-invalid", `The secrets file at ${path} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SandboxRefusal("config-invalid", `The secrets file at ${path} must hold an object.`);
  }
  const record = parsed as Record<string, unknown>;
  const secrets: SandboxSecrets = {};
  if (needed.has("slack")) {
    const token = (record.slack as { botToken?: unknown } | undefined)?.botToken;
    if (typeof token !== "string" || !token.startsWith("xoxb-")) {
      throw new SandboxRefusal("config-invalid", `The secrets file at ${path} has no Slack bot token in "slack.botToken" (it starts with xoxb-).`);
    }
    secrets.slack = { botToken: token };
  }
  if (needed.has("discord")) {
    const url = (record.discord as { webhookUrl?: unknown } | undefined)?.webhookUrl;
    if (typeof url !== "string" || !DISCORD_WEBHOOK.test(url)) {
      throw new SandboxRefusal("config-invalid", `The secrets file at ${path} has no Discord webhook URL in "discord.webhookUrl" (https://discord.com/api/webhooks/...).`);
    }
    secrets.discord = { webhookUrl: url };
  }
  return secrets;
}
