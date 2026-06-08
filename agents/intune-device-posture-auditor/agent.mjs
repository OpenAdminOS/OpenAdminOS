import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const SELECT_FIELDS = [
  "id",
  "deviceName",
  "userPrincipalName",
  "operatingSystem",
  "osVersion",
  "complianceState",
  "lastSyncDateTime",
  "enrolledDateTime",
  "managedDeviceOwnerType",
  "deviceEnrollmentType",
  "managementState",
];

const resultPath = readArg("--result");
if (!resultPath) {
  throw new Error("Missing required --result path.");
}

const brokerDir = process.env.OPENADMINOS_BROKER_DIR;
const rl = brokerDir
  ? undefined
  : readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
const responses = [];
rl?.on("line", (line) => {
  responses.push(line);
});

let nextId = 1;

await log("info", "MXC device posture auditor started.");

const graphPayload = await brokerRequest("graph.request", {
  method: "GET",
  path: "/deviceManagement/managedDevices",
  query: {
    $select: SELECT_FIELDS.join(","),
    $top: "999",
  },
});

const devices = unwrapCollection(graphPayload).map(normalizeDevice);
const audit = buildAudit(devices);
await log("info", `Analyzed ${devices.length} managed device records inside MXC.`);

const llm = await brokerRequest("llm.complete", {
  system:
    "You are an Intune device posture auditor. Be concise, factual, and conservative. Use only the supplied figures. Do not recommend destructive cleanup from this read-only report.",
  prompt: buildPrompt(audit),
  temperature: 0.2,
  maxTokens: 420,
});

const llmText =
  typeof llm?.text === "string" && llm.text.trim().length > 0
    ? llm.text.trim()
    : fallbackSummary(audit);

await writeFile(
  resultPath,
  JSON.stringify(
    {
      summary: llmText,
      result: {
        llmSummary: llmText,
        llmModel: typeof llm?.model === "string" ? llm.model : undefined,
        totalDevices: audit.totalDevices,
        compliance: audit.compliance,
        byOperatingSystem: audit.byOperatingSystem,
        byOwnership: audit.byOwnership,
        byEnrollmentType: audit.byEnrollmentType,
        byManagementState: audit.byManagementState,
        staleSync: audit.staleSync,
        missingPrimaryUser: audit.missingPrimaryUser,
        duplicateNames: audit.duplicateNames,
      },
    },
    null,
    2,
  ),
  "utf8",
);

await log("info", "MXC device posture auditor completed.");
rl?.close();
if (rl) {
  process.stdin.pause();
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function brokerRequest(method, params) {
  const id = `request-${nextId++}`;
  if (brokerDir) {
    const response = await fileBrokerRequest(brokerDir, { id, method, params });
    return unwrapBrokerResponse(method, response, id);
  }

  process.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  const response = await readResponseLine();
  return unwrapBrokerResponse(method, response, id);
}

async function fileBrokerRequest(directory, request) {
  const requestPath = brokerFilePath(directory, request.id, "request");
  const responsePath = brokerFilePath(directory, request.id, "response");
  const tempPath = `${requestPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(request), "utf8");
  await rename(tempPath, requestPath);

  while (true) {
    try {
      const response = JSON.parse(await readFile(responsePath, "utf8"));
      await unlink(responsePath).catch(() => undefined);
      await unlink(requestPath).catch(() => undefined);
      return response;
    } catch (error) {
      if (error?.code === "ENOENT") {
        await delay(10);
        continue;
      }
      throw new Error(`Invalid broker response JSON: ${error.message}`);
    }
  }
}

function brokerFilePath(directory, id, kind) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) {
    throw new Error(`Invalid broker request id "${id}".`);
  }
  return path.join(directory, `${id}.${kind}.json`);
}

function unwrapBrokerResponse(method, response, id) {
  if (response.id !== id) {
    throw new Error(`Broker response id mismatch. Expected ${id}, got ${response.id}.`);
  }
  if (!response.ok) {
    const message = response.error?.message ?? "Broker request failed.";
    throw new Error(`${method}: ${message}`);
  }
  return response.result;
}

async function log(level, message, metadata) {
  await brokerRequest("log", {
    level,
    message,
    ...(metadata ? { metadata } : {}),
  });
}

async function readResponseLine() {
  while (responses.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const line = responses.shift();
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid broker response JSON: ${error.message}`);
  }
}

function unwrapCollection(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.value)) {
    return payload.value;
  }
  return [];
}

function normalizeDevice(input) {
  const record = input && typeof input === "object" ? input : {};
  return {
    id: stringValue(record.id),
    deviceName: stringValue(record.deviceName) || "(unnamed)",
    userPrincipalName: stringValue(record.userPrincipalName),
    operatingSystem: stringValue(record.operatingSystem) || "(unknown)",
    osVersion: stringValue(record.osVersion) || "(unknown)",
    complianceState: stringValue(record.complianceState) || "unknown",
    lastSyncDateTime: stringValue(record.lastSyncDateTime),
    enrolledDateTime: stringValue(record.enrolledDateTime),
    managedDeviceOwnerType: stringValue(record.managedDeviceOwnerType) || "(unknown)",
    deviceEnrollmentType: stringValue(record.deviceEnrollmentType) || "(unknown)",
    managementState: stringValue(record.managementState) || "(unknown)",
  };
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function buildAudit(devices) {
  const duplicateGroups = [...groupBy(devices, (device) => device.deviceName).entries()]
    .filter(([name, group]) => name !== "(unnamed)" && group.length > 1)
    .map(([deviceName, group]) => ({
      deviceName,
      count: group.length,
      samples: group.slice(0, 5).map(compactDevice),
    }))
    .slice(0, 10);

  const staleDevices = devices
    .map((device) => ({ ...device, inactiveDays: daysSince(device.lastSyncDateTime) }))
    .filter((device) => typeof device.inactiveDays === "number")
    .sort((left, right) => (right.inactiveDays ?? 0) - (left.inactiveDays ?? 0));

  const missingPrimaryUser = devices
    .filter((device) => device.userPrincipalName.length === 0)
    .slice(0, 10)
    .map(compactDevice);

  return {
    totalDevices: devices.length,
    compliance: countBy(devices, (device) => device.complianceState, [
      "compliant",
      "noncompliant",
      "unknown",
    ]),
    byOperatingSystem: countBy(devices, (device) => device.operatingSystem),
    byOwnership: countBy(devices, (device) => device.managedDeviceOwnerType),
    byEnrollmentType: countBy(devices, (device) => device.deviceEnrollmentType),
    byManagementState: countBy(devices, (device) => device.managementState),
    staleSync: {
      days30: staleDevices.filter((device) => (device.inactiveDays ?? 0) >= 30).length,
      days60: staleDevices.filter((device) => (device.inactiveDays ?? 0) >= 60).length,
      days90: staleDevices.filter((device) => (device.inactiveDays ?? 0) >= 90).length,
      oldest: staleDevices.slice(0, 10).map((device) => ({
        ...compactDevice(device),
        inactiveDays: device.inactiveDays,
      })),
    },
    missingPrimaryUser: {
      count: devices.filter((device) => device.userPrincipalName.length === 0).length,
      samples: missingPrimaryUser,
    },
    duplicateNames: {
      count: duplicateGroups.length,
      groups: duplicateGroups,
    },
  };
}

function buildPrompt(audit) {
  return [
    `Total managed devices: ${audit.totalDevices}`,
    `Compliance counts: ${JSON.stringify(audit.compliance)}`,
    `Operating systems: ${JSON.stringify(audit.byOperatingSystem)}`,
    `Ownership: ${JSON.stringify(audit.byOwnership)}`,
    `Enrollment types: ${JSON.stringify(audit.byEnrollmentType)}`,
    `Management states: ${JSON.stringify(audit.byManagementState)}`,
    `Stale sync counts: ${JSON.stringify(audit.staleSync)}`,
    `Missing primary user: ${audit.missingPrimaryUser.count}`,
    `Duplicate device-name groups: ${audit.duplicateNames.count}`,
    "",
    "Write a compact report with these sections:",
    "1. Main finding.",
    "2. Device posture risks.",
    "3. Review queue.",
    "",
    "Do not invent policy names or remediation actions. Mention that this is read-only.",
  ].join("\n");
}

function fallbackSummary(audit) {
  return `Reviewed ${audit.totalDevices} managed devices. Noncompliant: ${audit.compliance.noncompliant ?? 0}; unknown: ${audit.compliance.unknown ?? 0}; stale >= 30 days: ${audit.staleSync.days30}.`;
}

function countBy(items, readKey, buckets = []) {
  const counts = Object.fromEntries(buckets.map((bucket) => [bucket, 0]));
  for (const item of items) {
    const key = readKey(item) || "(unknown)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function groupBy(items, readKey) {
  const groups = new Map();
  for (const item of items) {
    const key = readKey(item) || "(unknown)";
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function daysSince(iso) {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

function compactDevice(device) {
  return {
    id: device.id,
    deviceName: device.deviceName,
    userPrincipalName: device.userPrincipalName || undefined,
    operatingSystem: device.operatingSystem,
    osVersion: device.osVersion,
    complianceState: device.complianceState,
    lastSyncDateTime: device.lastSyncDateTime || undefined,
    managedDeviceOwnerType: device.managedDeviceOwnerType,
    deviceEnrollmentType: device.deviceEnrollmentType,
    managementState: device.managementState,
  };
}
