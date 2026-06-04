import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.OPENADMINOS_REPORT_SMOKE_PORT ?? "5175";
const rendererUrl = `http://127.0.0.1:${port}`;
const issueUrl = "https://github.com/OpenAdminOS/OpenAdminOS/issues/12345";
const userDataDir = await mkdtemp(join(tmpdir(), "openadminos-report-issue-smoke-"));
const externalUrlFile = join(userDataDir, "external-url.txt");
const supportBundleFile = join(userDataDir, "diagnostics.json");
const receivedSupportIssues = [];
let renderer;
let electron;
let supportServer;

try {
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
    resolve(root, "apps/desktop/node_modules/.bin/vite"),
    ["--host", "127.0.0.1", "--port", port, "--strictPort"],
    {
      cwd: join(root, "apps/desktop"),
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pipeProcess(renderer, "renderer");
  await waitForHttp(rendererUrl, 20_000);

  electron = spawn(resolve(root, "node_modules/.bin/electron"), ["apps/desktop"], {
    cwd: root,
    env: {
      ...process.env,
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

  const [externalUrl, supportBundle] = await Promise.all([
    readFile(externalUrlFile, "utf8"),
    readFile(supportBundleFile, "utf8"),
  ]);
  if (externalUrl.trim() !== issueUrl) {
    throw new Error(`Unexpected GitHub issue URL: ${externalUrl}`);
  }

  if (receivedSupportIssues.length !== 1) {
    throw new Error(`Expected one support issue submission, saw ${receivedSupportIssues.length}.`);
  }
  const submission = receivedSupportIssues[0];
  if (submission.confirmPublic !== true) {
    throw new Error("Support issue submission did not include public confirmation.");
  }
  if (submission.issue?.title !== "Smoke report issue") {
    throw new Error("Support issue submission did not preserve the title.");
  }
  if (submission.issue?.source !== "sidebar") {
    throw new Error("Support issue submission did not include the expected source.");
  }
  if (!submission.diagnostics) {
    throw new Error("Support issue submission did not include diagnostics.");
  }

  const submittedText = JSON.stringify(submission);
  for (const forbidden of [
    "Report Smoke Tenant",
    "admin@report-smoke.invalid",
    "report-smoke-agent",
    "report-smoke-run",
  ]) {
    if (submittedText.includes(forbidden)) {
      throw new Error(`Report smoke leaked ${forbidden} into the support issue payload.`);
    }
  }

  const parsedBundle = JSON.parse(supportBundle);
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
