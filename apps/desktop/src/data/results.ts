export interface DeviceRow {
  id: string;
  name: string;
  os: string;
  user: string;
  lastSync: string;
  daysInactive: number;
  recommendation: "retire" | "review" | "keep";
}

export const inactiveDevicesResult: DeviceRow[] = [
  { id: "DEV-A1F2", name: "LAP-DE-MUC-0142", os: "Windows 11", user: "marius.lutz@ugurlabs.com", lastSync: "2025-11-14", daysInactive: 178, recommendation: "retire" },
  { id: "DEV-7C90", name: "LAP-DE-BER-0073", os: "Windows 11", user: "anke.foerster@ugurlabs.com", lastSync: "2025-12-02", daysInactive: 159, recommendation: "retire" },
  { id: "DEV-2B41", name: "MAC-NL-AMS-0019", os: "macOS 14.6", user: "j.devries@ugurlabs.com", lastSync: "2025-09-18", daysInactive: 234, recommendation: "review" },
  { id: "DEV-9E03", name: "LAP-UK-LON-0241", os: "Windows 11", user: "harriet.j@ugurlabs.com", lastSync: "2025-12-19", daysInactive: 142, recommendation: "retire" },
  { id: "DEV-D7E8", name: "LAP-DE-HAM-0057", os: "Windows 10", user: "kerstin.bauer@ugurlabs.com", lastSync: "2026-01-04", daysInactive: 126, recommendation: "retire" },
  { id: "DEV-4F12", name: "MAC-FR-PAR-0008", os: "macOS 14.4", user: "marc.lefevre@ugurlabs.com", lastSync: "2025-10-22", daysInactive: 200, recommendation: "review" },
  { id: "DEV-A8B5", name: "LAP-DE-MUC-0301", os: "Windows 11", user: "thomas.kraus@ugurlabs.com", lastSync: "2026-01-22", daysInactive: 108, recommendation: "retire" },
  { id: "DEV-3D17", name: "LAP-DE-MUC-0227", os: "Windows 11", user: "lena.fischer@ugurlabs.com", lastSync: "2026-02-01", daysInactive: 98, recommendation: "retire" },
  { id: "DEV-6C29", name: "LAP-DE-BER-0118", os: "Windows 11", user: "(off-boarded)", lastSync: "2025-08-30", daysInactive: 253, recommendation: "retire" },
  { id: "DEV-B514", name: "MAC-IE-DUB-0014", os: "macOS 13.6", user: "siobhan.k@ugurlabs.com", lastSync: "2025-08-11", daysInactive: 272, recommendation: "review" },
];

export interface RunSummary {
  agentName: string;
  agentSlug: string;
  totalScanned: number;
  flagged: number;
  recommendRetire: number;
  recommendReview: number;
  durationSeconds: number;
  tokenCount: number;
  cost: string;
  costLabel: string;
  modelUsed: string;
  isLocal: boolean;
  tenant: string;
  startedBy: string;
  finishedAt: string;
}

export const sampleRunSummary: RunSummary = {
  agentName: "Find inactive devices",
  agentSlug: "find-inactive-devices",
  totalScanned: 1284,
  flagged: 47,
  recommendRetire: 31,
  recommendReview: 16,
  durationSeconds: 8.2,
  tokenCount: 3142,
  cost: "$0.00",
  costLabel: "Local · Ollama",
  modelUsed: "llama3.1:8b",
  isLocal: true,
  tenant: "UgurLabs",
  startedBy: "Ugur Koc",
  finishedAt: "2 minutes ago",
};

export interface DiffOperation {
  id: string;
  action: "retire" | "delete" | "modify";
  target: string;
  detail: string;
  before: string;
  after: string;
}

export const retireDevicesDiff: DiffOperation[] = [
  { id: "DEV-A1F2", action: "retire", target: "LAP-DE-MUC-0142", detail: "marius.lutz@ugurlabs.com · 178 days inactive", before: "Managed · Compliant", after: "Retired (wipe + remove)" },
  { id: "DEV-7C90", action: "retire", target: "LAP-DE-BER-0073", detail: "anke.foerster@ugurlabs.com · 159 days inactive", before: "Managed · Compliant", after: "Retired (wipe + remove)" },
  { id: "DEV-9E03", action: "retire", target: "LAP-UK-LON-0241", detail: "harriet.j@ugurlabs.com · 142 days inactive", before: "Managed · Compliant", after: "Retired (wipe + remove)" },
  { id: "DEV-D7E8", action: "retire", target: "LAP-DE-HAM-0057", detail: "kerstin.bauer@ugurlabs.com · 126 days inactive", before: "Managed · Non-compliant", after: "Retired (wipe + remove)" },
  { id: "DEV-A8B5", action: "retire", target: "LAP-DE-MUC-0301", detail: "thomas.kraus@ugurlabs.com · 108 days inactive", before: "Managed · Compliant", after: "Retired (wipe + remove)" },
];
