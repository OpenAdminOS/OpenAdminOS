/** Development-only capture, called behind the unpackaged screenshot guard. */
import type { BrowserWindow } from "electron";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

type CaptureRoute = (
  route: string,
  waitFor: string[],
  prepare?: "chat-empty" | "write-confirmation",
) => Promise<unknown>;

export async function captureWebsiteDemo(
  window: BrowserWindow,
  outDir: string,
  navigate: CaptureRoute,
) {
  const screens: Array<{
    id: string;
    route: string;
    label: string;
    wait: string[];
    prepare?: "chat-empty" | "write-confirmation";
    click?: string;
  }> = [
    {
      id: "chat",
      route: "/chat",
      label: "Chat",
      wait: ["What do you want to inspect?"],
      prepare: "chat-empty" as const,
      click: "Devices",
    },
    { id: "team", route: "/agents/office", label: "Team office", wait: ["Team office"] },
    {
      id: "team-paused",
      route: "/agents/office",
      label: "Team office, motion paused",
      wait: ["Team office"],
    },
    {
      id: "agents",
      route: "/agents",
      label: "Installed agents",
      wait: ["Search installed agents"],
    },
    {
      id: "hub",
      route: "/agents?source=hub",
      label: "Agents: Hub",
      wait: ["Search hub"],
    },
    {
      id: "schedules",
      route: "/agents?filter=scheduled",
      label: "Scheduled agents",
      wait: ["Scheduled only"],
    },
    {
      id: "agent-details",
      route: "/agents/find-inactive-devices",
      label: "Find inactive devices",
      wait: ["Find inactive devices"],
    },
    { id: "changes", route: "/changes", label: "Changes", wait: ["Changes"] },
    {
      id: "review",
      route: "/runs/screenshot-write-run",
      label: "Write confirmation",
      wait: ["Write operation paused for confirmation"],
      prepare: "write-confirmation" as const,
    },
    {
      id: "fleet",
      route: "/changes?scope=all",
      label: "Changes: All tenants",
      wait: ["Changes"],
    },
    { id: "cache", route: "/settings/data", label: "Data", wait: ["Tenant cache"] },
    {
      id: "settings",
      route: "/settings",
      label: "Provider settings",
      wait: ["Providers"],
    },
    {
      id: "tenants",
      route: "/settings/tenants",
      label: "Tenant settings",
      wait: ["Tenants"],
    },
    {
      id: "chat-settings",
      route: "/settings/chat",
      label: "Chat settings",
      wait: ["Chat investigation mode"],
    },
    {
      id: "gateway",
      route: "/settings/gateway",
      label: "Gateway settings",
      wait: ["Local MCP gateway"],
    },
    {
      id: "appearance",
      route: "/settings/appearance",
      label: "Appearance",
      wait: ["Graphite dark"],
    },
    {
      id: "privacy",
      route: "/settings/privacy",
      label: "Privacy settings",
      wait: ["Tenant telemetry"],
    },
    {
      id: "about",
      route: "/settings/about",
      label: "About OpenAdminOS",
      wait: ["Readiness diagnostics"],
    },
    {
      id: "workspaces",
      route: "/workspaces",
      label: "Workspaces",
      wait: ["Workspaces"],
    },
    {
      id: "connectors",
      route: "/settings/connectors",
      label: "Connectors",
      wait: ["Connectors"],
    },
    {
      id: "history",
      route: "/runs",
      label: "Runs",
      wait: ["Runs"],
    },
    {
      id: "compliance-details",
      route: "/agents/compliance-overview",
      label: "Compliance overview",
      wait: ["Compliance overview"],
    },
    {
      id: "offboarding-details",
      route: "/agents/offboarding-agent",
      label: "Offboarding agent",
      wait: ["Offboarding agent"],
    },
    {
      id: "evidence-details",
      route: "/agents/team-evidence-review",
      label: "Team evidence review",
      wait: ["Team evidence review"],
    },
    {
      id: "script-details",
      route: "/agents/team-script-draft",
      label: "Team PowerShell draft",
      wait: ["Team PowerShell draft"],
    },
    {
      id: "team-add",
      route: "/agents?add=teammate",
      label: "Add teammate",
      wait: ["Add teammate"],
    },
    {
      id: "workspace-add",
      route: "/workspaces",
      label: "Create workspace",
      wait: ["Workspaces"],
      click: "Create workspace",
    },
    {
      id: "baselines",
      route: "/changes",
      label: "Change baselines",
      wait: ["Changes"],
      click: "Baselines",
    },
    {
      id: "compare",
      route: "/changes",
      label: "Compare changes",
      wait: ["Changes"],
      click: "Compare",
    },
    {
      id: "chat-users",
      route: "/chat",
      label: "Chat user prompts",
      wait: ["Chat"],
      click: "Users",
    },
    {
      id: "chat-apps",
      route: "/chat",
      label: "Chat app prompts",
      wait: ["Chat"],
      click: "Apps",
    },
    {
      id: "chat-policies",
      route: "/chat",
      label: "Chat policy prompts",
      wait: ["Chat"],
      click: "Policies",
    },
    {
      id: "chat-signins",
      route: "/chat",
      label: "Chat sign-in prompts",
      wait: ["Chat"],
      click: "Sign-ins",
    },
    {
      id: "chat-identity",
      route: "/chat",
      label: "Chat identity prompts",
      wait: ["Chat"],
      click: "Identity",
    },
    {
      id: "chat-security",
      route: "/chat",
      label: "Chat security prompts",
      wait: ["Chat"],
      click: "Security",
    },
    {
      id: "quick-search",
      route: "/chat",
      label: "Quick search",
      wait: ["Chat"],
      click: "Quick search",
    },
  ];
  await mkdir(outDir, { recursive: true });
  window.setContentSize(1600, 1000);
  window.webContents.setBackgroundThrottling(false);
  await window.webContents.executeJavaScript(`(async () => {
    const state = await window.openAdminOS.getAppState();
    if (state.office.personas.length) return;
    for (const [name, avatar, color, agentSlugs, responsibility] of [
      ['Chief of Staff', 'robot', 'amber', ['compliance-overview','team-evidence-review'], 'Coordinate checks and review findings.'],
      ['Policy Watcher', 'fox', 'sage', ['compliance-overview'], 'Review compliance posture and flag changes.'],
      ['Device Investigator', 'owl', 'blue', ['find-inactive-devices'], 'Investigate inactive devices and stale inventory.'],
    ]) await window.openAdminOS.saveOfficePersona({name,avatar,color,agentSlugs,responsibility,tenantId:state.activeTenantId,providerId:'ollama',intervalMinutes:null,maxMinutes:30,enabled:true});
  })()`);
  const loaded = new Promise<void>((resolve) =>
    window.webContents.once("did-finish-load", () => resolve()),
  );
  window.webContents.reload();
  await loaded;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await window.webContents.executeJavaScript(
    'window.openAdminOS.setAppearance("light")',
  );
  await window.webContents.executeJavaScript(
    'localStorage.setItem("openadminos:appearance:v1","light");window.dispatchEvent(new StorageEvent("storage",{key:"openadminos:appearance:v1"}));',
  );
  const only = process.env.OPENADMINOS_WEBSITE_CAPTURE_ONLY;
  const manifest = only
    ? JSON.parse(await readFile(join(outDir, "screens.json"), "utf8"))
    : [];
  for (const tenant of [
    { key: "contoso" },
    { key: "dev" },
    { key: "customer" },
  ]) {
    if (tenant.key !== "contoso") {
      await window.webContents.executeJavaScript(`(() => {
        if (!document.querySelector('[role="menu"]')) document.querySelector('button[aria-haspopup="menu"]')?.click();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await window.webContents.executeJavaScript(`(() => {
        const choice = [...document.querySelectorAll('button[role="menuitem"]')].find(b => b.textContent.includes(${JSON.stringify(`admin@${tenant.key}.invalid`)}));
        if (!choice) throw new Error('Tenant choice missing');
        choice.click();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const screen of [
      ...screens,
      {
        id: "tenant-menu",
        route: "/chat",
        label: "Tenant selector",
        wait: ["Chat"],
        click: "__tenant_menu__",
      },
    ]) {
      if (only && !only.split(",").includes(screen.id)) continue;
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await window.webContents.executeJavaScript(
        `document.querySelector('.fixed button[aria-label="Close"]')?.click()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 180));
      await navigate(screen.route, screen.wait, screen.prepare);
      const heading =
        screen.route === "/workspaces"
          ? "No workspace selected"
          : screen.route === "/agents/office"
            ? "Team office"
          : screen.route.startsWith("/settings")
              ? "Settings"
              : screen.route.startsWith("/agents")
                ? "Agents"
                : screen.route.startsWith("/runs/")
                  ? "Offboarding agent"
                  : screen.wait[0];
      await window.webContents.executeJavaScript(
        `(async () => { const start=Date.now(); while(Date.now()-start<8000) { const ready=${JSON.stringify(screen.route)} === '/chat' ? !!document.querySelector('#intune-chat-composer') : [...document.querySelectorAll('h1,h2')].some(h=>(h.textContent||'').includes(${JSON.stringify(heading)})); if(ready)return;await new Promise(r=>setTimeout(r,100)); } throw new Error('Screen heading not ready'); })()`,
      );
      if (screen.click === "__tenant_menu__") {
        await window.webContents.executeJavaScript(
          `document.querySelector('button[aria-haspopup="menu"]')?.click()`,
        );
        await new Promise((resolve) => setTimeout(resolve, 350));
      } else if (screen.click) {
        const missing = await window.webContents.executeJavaScript(
          `(() => { const button = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim().replace(/\\s+/g,' ').startsWith( ${JSON.stringify(screen.click)}) || b.getAttribute('aria-label') === ${JSON.stringify(screen.click)}); if (!button) return [...document.querySelectorAll('button')].map(b=>b.textContent).join(' | '); button.click(); return null; })()`,
        );
        if (missing) throw new Error(`Missing ${screen.click}: ${missing}`);
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (screen.id === "team" || screen.id === "team-paused") {
        await window.webContents.executeJavaScript(`(() => {
          document.documentElement.removeAttribute('data-reduced-motion');
          const expand = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Expand office');
          expand?.click();
          [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Resume motion')?.click();
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 700));
        const count = await window.webContents.executeJavaScript(
          `document.querySelectorAll('.scene-persona').length`,
        );
        if (screen.id === "team-paused") {
          await window.webContents.executeJavaScript(
            `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Pause motion')?.click()`,
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (count !== 3)
          throw new Error(`Expected three teammates, got ${count}`);
      }
      await window.webContents.executeJavaScript("document.fonts.ready");
      window.webContents.invalidate();
      await window.webContents.capturePage();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const hotspots = await window.webContents.executeJavaScript(
        `(${readHotspots.toString()})()`,
      );
      const menuBounds =
        screen.id === "tenant-menu"
          ? await window.webContents.executeJavaScript(
              `(() => { const r=document.querySelector('[role="menu"]').getBoundingClientRect(); return {x:r.x/innerWidth*100,y:r.y/innerHeight*100,width:r.width/innerWidth*100,height:r.height/innerHeight*100}; })()`,
            )
          : null;
      const screenshot = await window.webContents.capturePage();
      const id =
        tenant.key === "contoso" ? screen.id : `${screen.id}--${tenant.key}`;
      await writeFile(join(outDir, `${id}.png`), screenshot.toPNG());
      const officeBounds =
        screen.id === "team"
          ? await window.webContents.executeJavaScript(
              `(() => {const r=document.querySelector('.scene-viewport').getBoundingClientRect();return {x:r.x/innerWidth*100,y:r.y/innerHeight*100,width:r.width/innerWidth*100,height:r.height/innerHeight*100};})()`,
            )
          : null;
      if (screen.id === "team" && tenant.key === "contoso")
        await captureOfficeMotion(window, outDir);
      const entry = {
        officeBounds,
        id,
        baseId: screen.id,
        tenant: tenant.key,
        menuBounds,
        route: screen.route,
        label: screen.label,
        width: screenshot.getSize().width,
        height: screenshot.getSize().height,
        hotspots,
      };
      const previous = manifest.findIndex(
        (item: { id: string }) => item.id === id,
      );
      if (previous >= 0) manifest[previous] = entry;
      else manifest.push(entry);
      console.log(
        `[website-demo] captured ${screen.id}: ${hotspots.length} controls`,
      );
    }
  }
  await writeFile(
    join(outDir, "screens.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

function readHotspots() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      'a,button,input,textarea,select,summary,[role="button"]',
    ),
  ).flatMap((element) => {
    if (element.classList.contains("scene-persona")) return [];
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      rect.width < 2 ||
      rect.height < 2 ||
      style.visibility === "hidden" ||
      style.display === "none"
    )
      return [];
    const left = Math.max(0, rect.left),
      top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right),
      bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return [];
    const hit = document.elementFromPoint(
      (left + right) / 2,
      (top + bottom) / 2,
    );
    if (!hit || !(element === hit || element.contains(hit))) return [];
    const label = (
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.innerText ||
      element.getAttribute("placeholder") ||
      element.getAttribute("name") ||
      "Open control"
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 160);
    return [
      {
        label,
        href: element.getAttribute("href"),
        disabled: element.matches(":disabled"),
        x: (left / innerWidth) * 100,
        y: (top / innerHeight) * 100,
        width: ((right - left) / innerWidth) * 100,
        height: ((bottom - top) / innerHeight) * 100,
      },
    ];
  });
}

async function captureOfficeMotion(window: BrowserWindow, outDir: string) {
  const framesDir = await mkdtemp(join(tmpdir(), "openadminos-office-"));
  try {
    const rect = await window.webContents.executeJavaScript(
      `(() => {const r=document.querySelector('.scene-viewport').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};})()`,
    );
    const start = Date.now();
    let frames = 0;
    while (Date.now() - start < 76000) {
      const frame = await window.webContents.capturePage(rect);
      await writeFile(
        join(framesDir, `${String(frames++).padStart(4, "0")}.jpg`),
        frame.toJPEG(90),
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, start + frames * 100 - Date.now())),
      );
    }
    const fps = frames / ((Date.now() - start) / 1000);
    await new Promise<void>((resolve, reject) => {
      const encoder = spawn(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-framerate",
          String(fps),
          "-i",
          join(framesDir, "%04d.jpg"),
          "-vf",
          "scale=trunc(iw/2)*2:trunc(ih/2)*2",
          "-c:v",
          "libx264",
          "-crf",
          "22",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          join(outDir, "office-motion.mp4"),
        ],
        { stdio: "inherit" },
      );
      encoder.once("error", reject);
      encoder.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Office video encoding exited ${code}`)),
      );
    });
  } finally {
    await rm(framesDir, { recursive: true, force: true });
  }
}
