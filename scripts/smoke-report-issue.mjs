import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { IntelligenceSqliteStore } from "../apps/desktop/dist-electron/electron/intune-chat/sqlite-store.js";

const { formatSupportIssue, supportIssuePreviewDigest } = await tsImport(
  "../web/src/lib/support/issue-format.ts",
  import.meta.url,
);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = resolve(
  dirname(fileURLToPath(import.meta.resolve("vite/package.json"))),
  "bin/vite.js",
);
const port = process.env.OPENADMINOS_REPORT_SMOKE_PORT ?? "5175";
const rendererUrl = `http://127.0.0.1:${port}`;
const issueUrl = "https://github.com/OpenAdminOS/OpenAdminOS/issues/12345";
const userDataDir = await mkdtemp(join(tmpdir(), "openadminos-report-issue-smoke-"));
const externalUrlFile = join(userDataDir, "external-url.txt");
const supportBundleFile = join(userDataDir, "diagnostics.json");
const receivedSupportIssues = [];
const rejectedReports = [
  [409, "The server formatted the report differently. Update OpenAdminOS and review the report again."],
  [409, "A matching support issue was already submitted recently."],
  [413, "Diagnostics payload is too large."],
];
let renderer;
let electron;
let supportServer;
const electronEnv = { ...process.env };
delete electronEnv.ELECTRON_RUN_AS_NODE;

try {
  const store = new IntelligenceSqliteStore(join(userDataDir, "openadminos.db"));
  try {
    const now = new Date().toISOString();
    store.setGraphCacheRefreshSchedule({
      tenantId: "report-smoke-tenant", enabled: true, intervalMinutes: 60, now,
    });
    store.markGraphCacheRefreshScheduleRun({
      tenantId: "report-smoke-tenant", success: true, startedAt: now,
    });
    store.replaceGraphResources({
      tenantId: "report-smoke-tenant",
      resource: "managedDevices",
      label: "Managed devices",
      scopeSet: [],
      rows: Array.from({ length: 137 }, (_, index) => ({ id: `report-smoke-device-${index}` })),
      pageCount: 14,
      pageLimitReached: true,
      refreshedAt: now,
    });
  } finally {
    store.close();
  }

  supportServer = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/api/support-issues") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    try {
      const raw = await readRequest(req, 120_000);
      const parsed = JSON.parse(raw);
      receivedSupportIssues.push(parsed);
      const rejection = rejectedReports[receivedSupportIssues.length - 1];
      if (rejection) {
        const [status, error] = rejection;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issueUrl, issueNumber: 12345 }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
  const supportApiUrl = await listen(supportServer);

  renderer = spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", port, "--strictPort"],
    {
      cwd: join(root, "apps/desktop"),
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pipeProcess(renderer, "renderer");
  await waitForHttp(rendererUrl, 20_000);

  const electronArgs = ["apps/desktop"];
  // Linux CI containers cannot install Electron's helper as root-owned setuid.
  // This flag is confined to the synthetic smoke process, never the packaged app.
  if (process.platform === "linux") electronArgs.push("--no-sandbox");
  if (process.env.OPENADMINOS_REPORT_SMOKE_SCREENSHOTS) {
    electronArgs.push("--force-prefers-reduced-motion");
  }
  electron = spawn(resolve(root, "node_modules/.bin/electron"), electronArgs, {
    cwd: root,
    env: {
      ...electronEnv,
      VITE_DEV_SERVER_URL: rendererUrl,
      OPENADMINOS_REPORT_ISSUE_SMOKE: "1",
      OPENADMINOS_REPORT_ISSUE_SMOKE_USER_DATA: userDataDir,
      OPENADMINOS_CAPTURE_EXTERNAL_URL: externalUrlFile,
      OPENADMINOS_SUPPORT_BUNDLE_EXPORT_PATH: supportBundleFile,
      OPENAGENTS_STATS_API: supportApiUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipeProcess(electron, "electron");

  const code = await waitForExit(electron, 35_000);
  if (code !== 0) {
    throw new Error(`Electron report issue smoke exited with code ${code}.`);
  }

  const [externalUrl, supportBundle, rawPreview] = await Promise.all([
    readFile(externalUrlFile, "utf8"),
    readFile(supportBundleFile, "utf8"),
    readFile(join(userDataDir, "preview.json"), "utf8"),
  ]);
  if (externalUrl.trim() !== issueUrl) {
    throw new Error(`Unexpected GitHub issue URL: ${externalUrl}`);
  }

  assert.equal(receivedSupportIssues.length, rejectedReports.length + 1,
    "Only the three rejected reports and the successful report should reach the server.");
  const submission = receivedSupportIssues.at(-1);
  if (submission.confirmPublic !== true) {
    throw new Error("Support issue submission did not include public confirmation.");
  }
  if (submission.issue?.title !== "Smoke report issue") {
    throw new Error("Support issue submission did not preserve the title.");
  }
  if (submission.issue?.source !== "settings-about") {
    throw new Error("Support issue submission did not include the expected source.");
  }
  if (!submission.diagnostics) {
    throw new Error("Support issue submission did not include diagnostics.");
  }

  const formatted = formatSupportIssue(submission);
  assert.ok("payload" in formatted, "The web formatter must accept the submitted report.");
  const { title, body } = formatted.payload;
  assert.deepEqual(JSON.parse(rawPreview), { title, body });
  assert.equal(submission.previewDigest, supportIssuePreviewDigest(title, body));

  const submittedText = JSON.stringify(submission);
  for (const forbidden of [
    "Report Smoke Tenant",
    "admin@report-smoke.invalid",
    "report-smoke-agent",
    "report-smoke-run",
    "report-smoke-device",
  ]) {
    if (submittedText.includes(forbidden)) {
      throw new Error(`Report smoke leaked ${forbidden} into the support issue payload.`);
    }
  }

  const parsedBundle = JSON.parse(supportBundle);
  for (const diagnostics of [parsedBundle, submission.diagnostics]) {
    assert.equal(diagnostics.schemaVersion, 2);
    assert.match(diagnostics.createdAt, /^\d{4}-\d{2}-\d{2}$/);
    const { graphCache, scheduler, tenants, runs, recentFailures } = diagnostics.state;
    const devices = graphCache.resources.find(({ resource }) => resource === "managedDevices");
    assert.ok(devices);
    assert.equal(devices.rows, "101-1000");
    assert.equal(devices.pages, "11-100");
    assert.equal(devices.pageLimitReached, true);
    assert.equal(devices.refreshedAt, "<1h");
    assert.equal(graphCache.schedule.intervalMinutes, "11-100");
    assert.equal(graphCache.schedule.updatedAt, "<1h");
    assert.equal(graphCache.schedule.lastRunAt, "<1h");
    assert.equal(graphCache.schedule.lastSuccessAt, "<1h");
    assert.equal(graphCache.schedule.nextRunAt, "future");
    assert.equal(scheduler.lastWakeAt, "<1h");
    assert.equal(scheduler.lastSuccessAt, "1-7d");
    assert.equal(tenants.connectedCount, "1-10");
    assert.equal(runs.total, "1-10");
    assert.equal(runs.byStatus.failed, "1-10");
    assert.equal(runs.latestRunAt, "<1h");
    assert.equal(recentFailures[0].queuedAt, "<1h");
    assert.equal(recentFailures[0].finishedAt, "<1h");
    assert.equal(recentFailures[0].agentSlug, "local");
    assert.equal(recentFailures[0].errorCategory, "ollama");
    assert.equal(recentFailures[0].failedStepCount, "0");
    const json = JSON.stringify(diagnostics);
    assert.doesNotMatch(json, /"(?:agentSlugHash|runIdHash|detailHash|errorHash|\w+ErrorHash|titleLength|descriptionLength)":/);
    assert.doesNotMatch(json, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  }
  if (parsedBundle.privacy?.automaticUploadByOpenAdminOS !== false) {
    throw new Error("Diagnostics bundle did not declare automaticUploadByOpenAdminOS=false.");
  }
  if (parsedBundle.privacy?.publicIssueSubmissionRequiresConfirmation !== true) {
    throw new Error("Diagnostics bundle did not declare confirmation-required submission.");
  }
  console.log("[smoke:report-issue] passed");
} finally {
  if (electron && electron.exitCode === null) electron.kill("SIGTERM");
  if (renderer && renderer.exitCode === null) renderer.kill("SIGTERM");
  if (supportServer) {
    await closeServer(supportServer);
  }
  await rm(userDataDir, { recursive: true, force: true });
}

function pipeProcess(child, label) {
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectExit(new Error("Timed out waiting for Electron report issue smoke."));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code ?? 1);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("Support smoke server did not expose a TCP address."));
        return;
      }
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

function readRequest(req, maxBytes) {
  return new Promise((resolveRead, rejectRead) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectRead(new Error("request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolveRead(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", rejectRead);
  });
}
