/** Development-only capture, called behind the unpackaged screenshot guard. */
import type { BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
    { id: "team", route: "/office", label: "Agent Team", wait: ["Agent Team"] },
    {
      id: "agents",
      route: "/agents",
      label: "Installed agents",
      wait: ["Search installed agents"],
    },
    {
      id: "hub",
      route: "/agents/hub",
      label: "Agent Hub",
      wait: ["Search agents"],
    },
    {
      id: "schedules",
      route: "/agents/schedules",
      label: "Schedules",
      wait: ["Schedules"],
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
    { id: "fleet", route: "/fleet", label: "Fleet", wait: ["Fleet"] },
    { id: "cache", route: "/cache", label: "Cache", wait: ["Cache"] },
    {
      id: "settings",
      route: "/settings",
      label: "Provider settings",
      wait: ["LLM Providers"],
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
      wait: ["Settings"],
    },
    {
      id: "gateway",
      route: "/settings/gateway",
      label: "Gateway settings",
      wait: ["Settings"],
    },
    {
      id: "appearance",
      route: "/settings/general",
      label: "General and appearance",
      wait: ["Graphite dark"],
    },
    {
      id: "privacy",
      route: "/settings/privacy",
      label: "Privacy settings",
      wait: ["Settings"],
    },
    {
      id: "about",
      route: "/settings/about",
      label: "About OpenAdminOS",
      wait: ["Settings"],
    },
    {
      id: "workspaces",
      route: "/workspaces",
      label: "Workspaces",
      wait: ["Workspaces"],
    },
    {
      id: "connectors",
      route: "/connectors",
      label: "Connectors",
      wait: ["Connectors"],
    },
    {
      id: "history",
      route: "/activity",
      label: "Run history",
      wait: ["Run history"],
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
      route: "/office",
      label: "Add teammate",
      wait: ["Agent Team"],
      click: "Add teammate",
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
      if (only && screen.id !== only) continue;
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
          : screen.route === "/connectors"
            ? "Connector routing"
            : screen.route.startsWith("/settings")
              ? "Settings"
              : screen.route.startsWith("/agents/hub") ||
                  screen.route === "/agents/schedules" ||
                  screen.route === "/agents"
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
      const entry = {
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
