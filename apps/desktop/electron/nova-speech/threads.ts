import { execFileSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";

function physicalCores(): number {
  if (process.platform === "darwin") {
    return Number(execFileSync("sysctl", ["-n", "hw.physicalcpu"], { encoding: "utf8", timeout: 2000 }));
  }
  if (process.platform === "linux") {
    const records = readFileSync("/proc/cpuinfo", "utf8").split(/\n\n/);
    const ids = records.flatMap(record => {
      const socket = /^physical id\s*:\s*(\d+)/m.exec(record)?.[1];
      const core = /^core id\s*:\s*(\d+)/m.exec(record)?.[1];
      return socket !== undefined && core !== undefined ? [socket + ":" + core] : [];
    });
    return new Set(ids).size;
  }
  return 0;
}

let count: number | undefined;
export function speechThreads(): number {
  if (count !== undefined) return count;
  const available = availableParallelism();
  let physical = 0;
  try { physical = physicalCores(); } catch { /* Use the scheduler's count when topology is unavailable. */ }
  return count = Math.min(8, available, physical > 0 ? physical : available);
}
