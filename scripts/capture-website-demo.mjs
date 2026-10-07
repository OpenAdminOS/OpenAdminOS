// Run `npm run build -w @openadminos/desktop` first. Captures the built app, not Vite.
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "apps/desktop/dist");
const { createServer } = await import("node:http");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  try {
    const file = resolve(
      dist,
      "." +
        decodeURIComponent(
          new URL(req.url, "http://localhost").pathname === "/"
            ? "/index.html"
            : new URL(req.url, "http://localhost").pathname,
        ),
    );
    if (!file.startsWith(dist + sep)) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader(
      "Content-Type",
      mime[extname(file)] ?? "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const userData = await mkdtemp(join(tmpdir(), "openadminos-website-capture-"));
const env = {
  ...process.env,
  OPENADMINOS_SCREENSHOT_CAPTURE: "1",
  OPENADMINOS_WEBSITE_CAPTURE: "1",
  OPENADMINOS_SCREENSHOT_CAPTURE_USER_DATA: userData,
  OPENADMINOS_SCREENSHOT_OUT_DIR: join(root, "web/public/product-demo"),
};
delete env.ELECTRON_RUN_AS_NODE;
env.VITE_DEV_SERVER_URL = `http://127.0.0.1:${server.address().port}`;
try {
  const child = spawn(
    join(root, "node_modules/.bin/electron"),
    ["apps/desktop", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    { cwd: root, env, stdio: "inherit" },
  );
  const timeout = setTimeout(() => child.kill("SIGTERM"), 180000);
  try {
    await new Promise((res, rej) => {
      child.once("error", rej);
      child.once("exit", (code) =>
        code === 0 ? res() : rej(new Error(`Capture exited ${code}`)),
      );
    });
  } finally {
    clearTimeout(timeout);
  }
} finally {
  server.close();
  await rm(userData, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
