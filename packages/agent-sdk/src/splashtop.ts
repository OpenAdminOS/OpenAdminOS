/**
 * Splashtop Open API as a vendor service of an organization. It is not a
 * Microsoft Graph service, so it is not part of `SERVICES` in
 * `services.ts`: it has no Graph scopes, and its parts are switched on by
 * what the API token's `users/basic_info` answer says it may reach.
 *
 * The connection record holds no secret. The API token stays in the OS
 * secure storage under the organization id and is sent only to the host
 * of the region chosen at connect.
 */

export type SplashtopRegion = "global" | "eu" | "oceania";

export interface SplashtopRegionInfo {
  id: SplashtopRegion;
  label: string;
  host: string;
}

/** The three regional Open API hosts, as Splashtop's API reference lists them (verified 2026-11-09). */
export const SPLASHTOP_REGIONS: readonly SplashtopRegionInfo[] = [
  { id: "global", label: "Global / US", host: "webapi.splashtop.com" },
  { id: "eu", label: "EU", host: "webapi.splashtop.eu" },
  { id: "oceania", label: "Oceania", host: "webapi.splashtop.nr" },
];

export const SPLASHTOP_API_PREFIX = "/api/open/v1/";

/** Where an admin creates the token, for the connect step and the docs. */
export const SPLASHTOP_TOKEN_LOCATION = "my.splashtop.com > Account Settings > Web API Tokens";

export function isSplashtopRegion(value: unknown): value is SplashtopRegion {
  return SPLASHTOP_REGIONS.some((region) => region.id === value);
}

export function splashtopRegion(id: SplashtopRegion): SplashtopRegionInfo {
  return SPLASHTOP_REGIONS.find((region) => region.id === id)!;
}

// TODO(ugur): agents cannot declare Splashtop yet. `services` is typed as the
// Microsoft `ServiceId` across manifests, gating, QA and the schema; how a
// manifest names a vendor service (a wider `services`, or its own field) is
// open.

/** Chat read tools of the Splashtop service. */
export type SplashtopReadToolName =
  | "splashtop_list_computers"
  | "splashtop_get_inventory"
  | "splashtop_list_users"
  | "splashtop_list_groups"
  | "splashtop_list_sessions"
  | "splashtop_list_team_history"
  | "splashtop_list_policies"
  | "splashtop_list_vulnerabilities";

export type SplashtopChatToolName = SplashtopReadToolName;

export type SplashtopPartId =
  | "splashtop.computers"
  | "splashtop.inventory"
  | "splashtop.people"
  | "splashtop.sessions"
  | "splashtop.security";

export interface SplashtopPart {
  id: SplashtopPartId;
  title: string;
  summary: string;
  /**
   * Keys of `data.scopes` in the `users/basic_info` answer that prove this
   * part. Empty when the answer does not say: such a part is on, and a
   * call the token may not make gets the designed 403.
   */
  tokenScopes: readonly string[];
  tools: readonly SplashtopReadToolName[];
  chatExamples: readonly string[];
}

export interface SplashtopServiceDefinition {
  id: "splashtop";
  title: string;
  summary: string;
  parts: readonly SplashtopPart[];
  roles: readonly { name: string; why: string }[];
  licences: readonly string[];
}

export const SPLASHTOP_SERVICE: SplashtopServiceDefinition = {
  id: "splashtop",
  title: "Splashtop",
  summary: "Computers, inventory, users and groups, session and team logs, endpoint policies and vulnerabilities from the Splashtop Open API.",
  parts: [
    {
      id: "splashtop.computers",
      title: "Computers",
      summary: "Computers on the team, their online state, last session and agent version. Rename, reboot and delete with your confirmation.",
      tokenScopes: ["team_computers"],
      tools: ["splashtop_list_computers"],
      chatExamples: ["Which Splashtop computers have been offline for more than 30 days?"],
    },
    {
      id: "splashtop.inventory",
      title: "Inventory",
      summary: "System, hardware and installed software of computers.",
      tokenScopes: ["inventory"],
      tools: ["splashtop_get_inventory"],
      chatExamples: ["What hardware and serial number does this Splashtop computer report?"],
    },
    {
      id: "splashtop.people",
      title: "Users and groups",
      summary: "Team users, their role and status, and groups. Disable a user with your confirmation.",
      tokenScopes: ["team_users", "team_groups"],
      tools: ["splashtop_list_users", "splashtop_list_groups"],
      chatExamples: ["Which Splashtop users are disabled or still invited?"],
    },
    {
      id: "splashtop.sessions",
      title: "Sessions and logs",
      summary: "Active and finished remote sessions and team history. End an active session with your confirmation.",
      tokenScopes: ["logs"],
      tools: ["splashtop_list_sessions", "splashtop_list_team_history"],
      chatExamples: ["Who connected to remote computers in the last 7 days?"],
    },
    {
      id: "splashtop.security",
      title: "Policies and vulnerabilities",
      summary: "Endpoint management policies and the team's CVE list with remediation status.",
      tokenScopes: [],
      tools: ["splashtop_list_policies", "splashtop_list_vulnerabilities"],
      chatExamples: ["Which vulnerabilities in CISA KEV affect the most Splashtop computers?"],
    },
  ],
  roles: [{ name: "Team Owner or Super Admin", why: "Only they can create a Web API token in my.splashtop.com." }],
  licences: ["Splashtop Enterprise (the Open API is not available on other plans)"],
};

/** Stored in `OrganizationRecord.connections.splashtop`. Never holds the token. */
export interface SplashtopConnectionRecord {
  region: SplashtopRegion;
  teamId: number;
  /** The Splashtop account the token belongs to, from `users/basic_info`. */
  account?: string;
  connectedAt: string;
  /** When the current token was saved; changes on rotate. */
  tokenSetAt: string;
  lastCheckedAt?: string;
  /** Keys of `data.scopes` the last check returned. */
  tokenScopes: string[];
}

/** What the renderer sees of one organization's Splashtop connection. */
export interface SplashtopConnectionSummary {
  organizationId: string;
  region: SplashtopRegion;
  host: string;
  teamId: number;
  account?: string;
  connectedAt: string;
  tokenSetAt: string;
  lastCheckedAt?: string;
  parts: { id: SplashtopPartId; title: string; on: boolean }[];
}

export interface ConnectSplashtopInput {
  organizationId: string;
  region: SplashtopRegion;
  /** Sent to the main process once and never returned. */
  token: string;
}

export interface RotateSplashtopTokenInput {
  organizationId: string;
  token: string;
}

export function isPositiveIntegerId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A stored connection record, or undefined when it is missing or malformed. */
export function sanitizeSplashtopConnection(raw: unknown): SplashtopConnectionRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (!isSplashtopRegion(record.region) || !isPositiveIntegerId(record.teamId)) return undefined;
  if (typeof record.connectedAt !== "string" || typeof record.tokenSetAt !== "string") return undefined;
  return {
    region: record.region,
    teamId: record.teamId,
    ...(typeof record.account === "string" && record.account.length <= 320 ? { account: record.account } : {}),
    connectedAt: record.connectedAt,
    tokenSetAt: record.tokenSetAt,
    ...(typeof record.lastCheckedAt === "string" ? { lastCheckedAt: record.lastCheckedAt } : {}),
    tokenScopes: Array.isArray(record.tokenScopes)
      ? record.tokenScopes.filter((scope): scope is string => typeof scope === "string" && /^[a-z_]{1,64}$/.test(scope)).slice(0, 64)
      : [],
  };
}

/** The organization's Splashtop connection, read defensively from its connections. */
export function splashtopConnectionOf(organization: { connections: Record<string, unknown> } | undefined): SplashtopConnectionRecord | undefined {
  return organization ? sanitizeSplashtopConnection(organization.connections.splashtop) : undefined;
}

export function splashtopPartOn(part: SplashtopPart, tokenScopes: readonly string[]): boolean {
  return part.tokenScopes.every((scope) => tokenScopes.includes(scope));
}

export function splashtopConnectionSummary(organizationId: string, record: SplashtopConnectionRecord): SplashtopConnectionSummary {
  return {
    organizationId,
    region: record.region,
    host: splashtopRegion(record.region).host,
    teamId: record.teamId,
    ...(record.account ? { account: record.account } : {}),
    connectedAt: record.connectedAt,
    tokenSetAt: record.tokenSetAt,
    ...(record.lastCheckedAt ? { lastCheckedAt: record.lastCheckedAt } : {}),
    parts: SPLASHTOP_SERVICE.parts.map((part) => ({ id: part.id, title: part.title, on: splashtopPartOn(part, record.tokenScopes) })),
  };
}

/** The Splashtop changes OpenAdminOS can plan. */
export type SplashtopChangeKind =
  | "reboot-computers"
  | "delete-computers"
  | "disable-users"
  | "end-sessions"
  | "rename-computers";

export const SPLASHTOP_CHANGE_KINDS: readonly SplashtopChangeKind[] = [
  "reboot-computers",
  "delete-computers",
  "disable-users",
  "end-sessions",
  "rename-computers",
];

/** At most this many targets in one Splashtop change plan. */
export const SPLASHTOP_CHANGE_TARGET_LIMIT = 50;

export function isSplashtopChangeKind(value: unknown): value is SplashtopChangeKind {
  return SPLASHTOP_CHANGE_KINDS.includes(value as SplashtopChangeKind);
}

/** Rename is the only change that can be undone by another rename. */
export function splashtopChangeDestructive(kind: SplashtopChangeKind): boolean {
  return kind !== "rename-computers";
}

const PHRASE: Record<SplashtopChangeKind, { verb: string; one: string; many: string }> = {
  "reboot-computers": { verb: "REBOOT", one: "COMPUTER", many: "COMPUTERS" },
  "delete-computers": { verb: "DELETE", one: "COMPUTER", many: "COMPUTERS" },
  "disable-users": { verb: "DISABLE", one: "USER", many: "USERS" },
  "end-sessions": { verb: "END", one: "SESSION", many: "SESSIONS" },
  "rename-computers": { verb: "RENAME", one: "COMPUTER", many: "COMPUTERS" },
};

/** The phrase the admin types to apply a plan, for example `REBOOT 12 COMPUTERS`. */
export function splashtopConfirmationPhrase(kind: SplashtopChangeKind, count: number): string {
  const words = PHRASE[kind];
  return `${words.verb} ${count} ${count === 1 ? words.one : words.many}`;
}

/** A change the admin asks the host to plan. The host reads every target again before planning. */
export interface SplashtopChangeRequest {
  kind: SplashtopChangeKind;
  /** Computer ids, user ids or active session ids, by kind. */
  targetIds: number[];
  /** Only for `rename-computers`: the new name per computer id. */
  names?: Record<string, string>;
  /** Only for `reboot-computers`. Defaults to a normal reboot. */
  rebootOption?: "normal_reboot" | "restart_streamer";
}

/** Splashtop's naming rule for computers: not blank, at most 64 characters, none of <>,;:"*+=\|? */
export function splashtopComputerNameProblem(name: string): string | undefined {
  if (name.trim().length === 0) return "A computer name cannot be blank.";
  if ([...name].length > 64) return "A computer name has at most 64 characters.";
  if (/[<>,;:"*+=\\|?]/.test(name)) return 'A computer name cannot contain any of < > , ; : " * + = \\ | ?';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "A computer name cannot contain control characters.";
  return undefined;
}

/** One target an admin can pick in Plan a change, as Splashtop lists it now. */
export interface SplashtopChangeTarget {
  id: number;
  label: string;
  detail?: string;
}

export interface PrepareSplashtopChangeInput extends SplashtopChangeRequest {
  organizationId: string;
}
