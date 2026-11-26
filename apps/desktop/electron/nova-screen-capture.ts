import { BrowserWindow, desktopCapturer, screen, shell, systemPreferences, type WebContents } from "electron";
import { layoutScreenText, recognizeScreen } from "./nova-screen-ocr.js";
import { NOVA_SCREEN_TEXT_BYTES } from "@openadminos/agent-sdk";
import { clampScreenRegion, screenPixelRegion, type Region } from "./nova-screen-question.js";
import type { ScreenCapture } from "./nova-screen.js";



function selectRegion(display: Electron.Display, signal: AbortSignal): Promise<Region | undefined> {
  const overlay = new BrowserWindow({
    ...display.bounds, show: false, frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, enableLargerThanScreen: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  overlay.setContentProtection(true);
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
  <title>Select a screen area</title>
  <style>
    body{margin:0;background:#080c1570;color:white;font:16px system-ui;cursor:crosshair}
    #box{position:absolute;border:2px solid #83c9ff;background:#83c9ff33;pointer-events:none}
    header{position:fixed;top:24px;left:50%;transform:translateX(-50%);white-space:nowrap;background:#161d29;border:1px solid #62738a;border-radius:8px;padding:12px;z-index:1}
    button{margin-left:10px;padding:8px;cursor:pointer}
  </style>
  <header>Drag to select an area. Enter for the whole screen. Esc to cancel.<button autofocus>Whole screen</button><button>Cancel</button></header>
  <div id="box" hidden></div>
  <script>
    const finish = region => location.href = 'nova-screen-selection://region/' + encodeURIComponent(JSON.stringify(region));
    const whole = () => finish({x:0,y:0,width:innerWidth,height:innerHeight});
    const [all,cancel] = document.querySelectorAll('button');
    all.onclick = whole;
    cancel.onclick = () => finish(null);
    addEventListener('keydown', event => {
      if(event.key === 'Escape') finish(null);
      if(event.key === 'Enter' && event.target !== cancel) {event.preventDefault(); whole();}
    });
    const box = document.querySelector('#box');
    let start;
    const region = event => ({x:Math.min(start.x,event.clientX),y:Math.min(start.y,event.clientY),
      width:Math.abs(start.x-event.clientX),height:Math.abs(start.y-event.clientY)});
    addEventListener('pointerdown', event => {
      if(event.button !== 0 || event.target.closest('header')) return;
      start = {x:event.clientX,y:event.clientY};
      document.body.setPointerCapture(event.pointerId);
    });
    addEventListener('pointermove', event => {
      if(!start) return;
      const {x,y,width,height} = region(event);
      box.hidden = false;
      Object.assign(box.style,{left:x+'px',top:y+'px',width:width+'px',height:height+'px'});
    });
    addEventListener('pointerup', event => {
      if(!start) return;
      const selected = region(event);
      start = undefined;
      if(selected.width >= 4 && selected.height >= 4) finish(selected);
      else box.hidden = true;
    });
    addEventListener('pointercancel', () => {start = undefined; box.hidden = true;});
  </script></html>`;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => close(), 120_000);
    const close = () => { if (!overlay.isDestroyed()) overlay.destroy(); };
    signal.addEventListener("abort", close, { once: true });
    overlay.once("closed", () => { clearTimeout(deadline); signal.removeEventListener("abort", close); resolve(undefined); });
    overlay.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const prefix = "nova-screen-selection://region/";
      if (!url.startsWith(prefix)) return;
      let region: unknown;
      try {
        region = JSON.parse(decodeURIComponent(url.slice(prefix.length)));
      } catch {
        return;
      }
      resolve(clampScreenRegion(region, display.bounds));
      close();
    });
    overlay.once("ready-to-show", () => overlay.show());
    void overlay.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).catch(() => {
      if (!overlay.isDestroyed()) {
        reject(new Error("Nova could not open the screen selector. Try again."));
        close();
      }
    });
  });
}

export function novaScreenCapture(windows: () => (BrowserWindow | null | undefined)[], appleHelper: string): ScreenCapture {
  let requestedPermission = false;
  return {
    async openSettings() {
      if (process.platform === "darwin") await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    },
    async capture(sender: WebContents, signal: AbortSignal) {
      if (process.platform === "darwin") {
        const permission = systemPreferences.getMediaAccessStatus("screen");
        if (permission === "not-determined" && !requestedPermission) {
          requestedPermission = true;
          await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
        }
        if (systemPreferences.getMediaAccessStatus("screen") !== "granted") return { status: "permission" };
      }
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      signal.throwIfAborted();
      const region = await selectRegion(display, signal);
      if (!region || signal.aborted) return { status: "cancelled" };
      const visible = windows().filter((window): window is BrowserWindow => !!window && !window.isDestroyed() && window.isVisible());
      const ownerWindow = visible.find(window => window.webContents === sender);
      let captured: Electron.NativeImage;
      try {
        visible.forEach(window => window.hide());
        await new Promise(resolve => setTimeout(resolve, 125));
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } });
        const image = sources.find(source => source.display_id === String(display.id))?.thumbnail
          ?? (sources.length === 1 && screen.getAllDisplays().length === 1 ? sources[0]?.thumbnail : undefined);
        if (!image || image.isEmpty()) throw new Error("Nova could not capture this display. Check your screen sharing settings and try again.");
        const crop = screenPixelRegion(region, display.bounds, image.getSize());
        captured = image.crop(crop);
      } finally {
        visible.forEach(window => { if (!window.isDestroyed()) window.showInactive(); });
        if (ownerWindow && !ownerWindow.isDestroyed()) ownerWindow.focus();
      }
      const imageSize = captured.getSize();
      const longestSide = Math.max(imageSize.width, imageSize.height);
      const ocrImage = process.platform === "win32" && longestSide > 2500
        ? captured.resize({ width: Math.round(imageSize.width * 2500 / longestSide) })
        : captured;
      const png = ocrImage.toPNG();
      const { engine, lines } = await recognizeScreen(png, appleHelper).finally(() => png.fill(0));
      if (signal.aborted || sender.isDestroyed()) return { status: "cancelled" };
      return {
        status: "captured", region: imageSize, engine,
        text: layoutScreenText(lines, NOVA_SCREEN_TEXT_BYTES),
        thumbnail: captured.resize({ width: Math.min(imageSize.width, 640) }).toDataURL(),
      };
    },
  };
}
