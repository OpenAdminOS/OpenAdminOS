import type { RunStep } from "../types";

export const sampleRunSteps: RunStep[] = [
  {
    id: "s1",
    label: "Authenticate to tenant",
    state: "done",
    detail: "Reused cached token · 1.3s",
  },
  {
    id: "s2",
    label: "Fetch managed devices",
    state: "done",
    detail: "Retrieved 1,284 device records · 4.1s",
  },
  {
    id: "s3",
    label: "Filter by lastSyncDateTime",
    state: "done",
    detail: "47 candidates older than 90 days",
  },
  {
    id: "s4",
    label: "Summarise with LLM",
    state: "active",
    detail: "Streaming · llama3.1:8b · local",
  },
  {
    id: "s5",
    label: "Format result",
    state: "pending",
  },
];

export const sampleReasoning = `Looking at the 47 candidates, I'm grouping them by last sync date and OS. Most fall into two clusters: 31 Windows devices last seen 90–180 days ago — these likely belong to off-boarded users or devices in storage. The remaining 16 are macOS devices with a sync gap of 180+ days, which is unusual for active users; worth confirming with the device owner before retiring.`;

export const sampleActivity: Array<{
  time: string;
  text: string;
  tone?: "default" | "soft" | "accent";
}> = [
  { time: "00:00", text: "Run started by Ugur Koc", tone: "soft" },
  { time: "00:01", text: "Tenant scope: UgurLabs (read-only)", tone: "soft" },
  { time: "00:03", text: "Querying /deviceManagement/managedDevices" },
  { time: "00:07", text: "1,284 records returned" },
  { time: "00:08", text: "Filter applied: lastSyncDateTime < 90d → 47 results" },
  { time: "00:09", text: "Sending context to llama3.1:8b (local)", tone: "accent" },
];
