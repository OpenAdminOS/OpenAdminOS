import { BrowserWindow, desktopCapturer, screen, shell, systemPreferences, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { activeModelProvider, resolveProviderDefaultModel, type NovaScreenRequest, type NovaScreenResponse } from "@openadminos/agent-sdk";
import { layoutScreenText, recognizeScreen } from "./nova-screen-ocr.js";
import { prepareScreenQuestion, requireScreenConsent, screenAudit, screenPolicyRefusal } from "./nova-screen-question.js";
import type { AppStateStore } from "./state.js";

interface Region { x: number; y: number; width: number; height: number }

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
    const close = () => { if (!overlay.isDestroyed()) overlay.destroy(); };
    signal.addEventListener("abort", close, { once: true });
    overlay.once("closed", () => { signal.removeEventListener("abort", close); resolve(undefined); });
    overlay.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const prefix = "nova-screen-selection://region/";
      if (!url.startsWith(prefix)) return;
      let region: Region | null;
      try {
        region = JSON.parse(decodeURIComponent(url.slice(prefix.length))) as Region | null;
      } catch {
        return;
      }
      resolve(region ?? undefined);
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

type ScreenQuestionStore = Pick<AppStateStore,
  "getAppState" | "novaProfile" | "novaProviderEndpoint" | "retrieveDocumentation" | "novaPublicModel" | "recordNovaScreenShare">;

export function createNovaScreenHandler(store: ScreenQuestionStore, windows: () => (BrowserWindow | null | undefined)[], appleHelper: string) {
  const pending = new Map<number, { id: string; scope: string; region: Region; engine: string; needsConsent: boolean; expires: number }>();
  let selecting = false;
  async function settings() {
    const [state, profile] = await Promise.all([store.getAppState(), store.novaProfile()]);
    const raw = state.providers.find(provider => provider.id === state.activeProviderId);
    const provider = activeModelProvider(raw, state.activeModelByProviderId);
    const local = provider?.isLocal === true;
    const refusal = screenPolicyRefusal(profile.policy?.values.novaScreen, profile.effective.capabilities.screenQuestions, local);
    if (refusal) throw new Error(refusal);
    if (provider?.status !== "connected") throw new Error("Connect a reasoning provider in Settings before asking about the screen.");
    const model = resolveProviderDefaultModel(raw, state.activeModelByProviderId).model;
    const endpoint = await store.novaProviderEndpoint(provider.id);
    return { provider, model, endpoint, local, hostedVoice: profile.effective.voiceMode === "openai",
      scope: JSON.stringify([state.activeTenantId, provider.id, model, endpoint, local, profile.effective.voiceMode]) };
  }
  return async (sender: WebContents, request: NovaScreenRequest): Promise<NovaScreenResponse> => {
    if (!windows().some(window => window && !window.isDestroyed() && window.webContents === sender)) throw new Error("Open Nova to ask a screen question.");
    const owner = sender.id;
    switch (request?.action) {
      case "settings":
        if (process.platform === "darwin") await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
        return { status: "cancelled" };
      case "discard":
        if (pending.get(owner)?.id === request.id) pending.delete(owner);
        return { status: "cancelled" };
      case "capture": {
        if (selecting) throw new Error("Finish the open screen selection first.");
        selecting = true;
        pending.delete(owner);
        const controller = new AbortController();
        const destroyed = () => { controller.abort(); pending.delete(owner); };
        sender.once("destroyed", destroyed);
        try {
          const current = await settings();
          if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted")
            return { status: "permission" };
          const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
          controller.signal.throwIfAborted();
          const region = await selectRegion(display, controller.signal);
          if (!region || controller.signal.aborted) return { status: "cancelled" };
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
            const size = image.getSize();
            const scaleX = size.width / display.size.width;
            const scaleY = size.height / display.size.height;
            const x = Math.max(0, Math.floor(region.x * scaleX));
            const y = Math.max(0, Math.floor(region.y * scaleY));
            captured = image.crop({ x, y, width: Math.min(size.width - x, Math.ceil(region.width * scaleX)),
              height: Math.min(size.height - y, Math.ceil(region.height * scaleY)) });
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
          if (controller.signal.aborted || sender.isDestroyed()) return { status: "cancelled" };
          const id = randomUUID();
          const needsConsent = !current.local || current.hostedVoice || request.hostedVoice === true;
          pending.set(owner, { id, scope: current.scope, region: { ...region, ...imageSize }, engine, needsConsent, expires: Date.now() + 300_000 });
          const width = Math.min(imageSize.width, 640);
          return { status: "preview", id, thumbnail: captured.resize({ width }).toDataURL(),
            text: layoutScreenText(lines, 1400), needsConsent,
            destination: current.local ? "Screen text stays on this device" : `Screen text goes to ${current.provider.name} for reasoning` };
        } finally {
          sender.removeListener("destroyed", destroyed);
          selecting = false;
        }
      }
      case "send": {
        const preview = pending.get(owner);
        if (!preview || preview.id !== request.id || preview.expires < Date.now()) throw new Error("This screen preview expired. Select the area again.");
        requireScreenConsent(preview.needsConsent, request.consent);
        if (typeof request.question !== "string" || !request.question.trim() || Buffer.byteLength(request.question) > 600 ||
            typeof request.text !== "string" || Buffer.byteLength(request.text) > 3000)
          throw new Error("Shorten the question or edited screen text and try again.");
        pending.delete(owner);
        const current = await settings();
        if (current.scope !== preview.scope) throw new Error("Nova's provider or organization changed. Select the screen area again.");
        const prepared = await prepareScreenQuestion(request.question, request.text, question => store.retrieveDocumentation(question));
        const llm = await store.novaPublicModel(current.provider.id, current.model, current.endpoint, current.local);
        if (sender.isDestroyed() || (await settings()).scope !== preview.scope) throw new Error("Nova's session changed. Select the screen area again.");
        try {
          store.recordNovaScreenShare(preview.needsConsent, screenAudit(current.local ? "local" : current.provider.id, preview.region, preview.engine, prepared.textLength));
        } catch {
          throw new Error("Nova could not record screen sharing in the audit log. Check the audit log in Settings and try again.");
        }
        try {
          const result = await llm.complete({ ...prepared.input, signal: AbortSignal.timeout(120000) });
          if (!result.text.trim()) throw new Error();
          return { status: "answered", text: result.text };
        } catch {
          throw new Error("Nova's provider could not answer the screen question. Check the provider in Settings and capture again.");
        }
      }
      default: throw new Error("Open Nova and start a new screen question.");
    }
  };
}
