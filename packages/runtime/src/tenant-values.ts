import { TenantValueIndex, type TenantValueKind } from "./tenant-value-index.js";

export { TenantValueIndex };

/**
 * Free-text display name keys. A value under one of these is skipped when it
 * is only numbers and stopwords, because names like "Windows 11" or "All
 * Users" identify nothing. givenName and surname count only as a full name.
 */
const TENANT_NAME_KEYS = new Set([
  "displayName", "name", "userDisplayName",
  // Splashtop Open API records (snake_case): computer, owner and account names.
  "member_name", "srs_name", "src_name", "srs_owner_name", "computer_name", "group_name",
]);

/**
 * Descriptive keys. Their values are often ordinary words ("Sales",
 * "Building 2"), so a value made only of common words is skipped.
 */
const TENANT_LABEL_KEYS = new Set(["companyName", "department", "officeLocation"]);

/**
 * Identifier keys. Their values are always indexed, whatever their words,
 * as is every key ending in Id, ID, Ids or IDs.
 */
const TENANT_IDENTIFIER_KEYS = new Set([
  "id", "userPrincipalName", "mail", "email", "emailAddress", "userName", "onPremisesSamAccountName",
  "mailNickname", "groupTag", "hostName", "deviceName", "managedDeviceName",
  "serialNumber", "imei", "meid", "wiFiMacAddress", "ethernetMacAddress", "phoneNumber", "mobilePhone",
  "businessPhones", "otherMails", "proxyAddresses", "onPremisesDomainName", "domainName", "iccid", "udid",
  // Splashtop Open API records (snake_case): hosts, accounts, addresses and hardware identifiers.
  "host_name", "hostname", "src_user_email", "user_email", "os_user", "os_domain", "user_name", "username",
  "uuid", "srs_uuid", "rds_uuid", "client_ip_addr", "server_ip_addr", "pubip", "local_ip", "ip_address",
  "mac_address", "mac", "serial_number", "bios_serial_number", "motherboard_serial_number",
]);
/** Graph's camelCase ids (deviceId, userIds) and Splashtop's snake_case ones (group_id, server_ids). */
const ID_KEY = /(?:I[dD]|_ids?)s?$/;

/**
 * Subtrees that hold property names and change details, not identities:
 * audit events list "Description", "Platform" or "Assignments" under
 * displayName there. They are skipped.
 */
const PROPERTY_NAME_SUBTREES = new Set(["modifiedProperties", "additionalDetails"]);

/** Collects identity values from a tenant tool result or a cached Graph row. */
export function collectTenantValues(value: unknown, into: TenantValueIndex, depth = 0): void {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectTenantValues(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.givenName === "string" && typeof record.surname === "string") {
    into.add(`${record.givenName} ${record.surname}`, "name");
  }
  for (const [key, child] of Object.entries(record)) {
    if (PROPERTY_NAME_SUBTREES.has(key)) continue;
    const kind: TenantValueKind | undefined = TENANT_NAME_KEYS.has(key)
      ? "name"
      : TENANT_LABEL_KEYS.has(key)
        ? "label"
        : TENANT_IDENTIFIER_KEYS.has(key) || ID_KEY.test(key) ? "identifier" : undefined;
    if (typeof child === "string") {
      if (kind) into.add(child, kind);
    } else if (kind && Array.isArray(child) && child.every((item) => typeof item === "string")) {
      into.addAll(child, kind);
    } else {
      collectTenantValues(child, into, depth + 1);
    }
  }
}
