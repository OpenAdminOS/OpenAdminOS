import type { BrowserWindow, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { activeModelProvider, resolveProviderDefaultModel, NOVA_SCREEN_TEXT_BYTES, NOVA_SCREEN_QUESTION_BYTES, type NovaScreenRequest, type NovaScreenResponse } from "@openadminos/agent-sdk";
import { prepareScreenQuestion, requireScreenConsent, screenAudit, screenPolicyRefusal, screenDestination } from "./nova-screen-question.js";
import type { AppStateStore } from "./state.js";

type ScreenQuestionStore = Pick<AppStateStore,
  "getAppState" | "novaProfile" | "novaProviderEndpoint" | "retrieveDocumentation" | "novaPublicModel" | "recordNovaScreenShare">;

export interface ScreenCapture {
  openSettings(): Promise<void>;
  capture(sender: WebContents, signal: AbortSignal): Promise<
    { status: "cancelled" | "permission" } |
    { status: "captured"; text: string; thumbnail: string; region: { width: number; height: number }; engine: string }
  >;
}

export function createNovaScreenHandler(store: ScreenQuestionStore, windows: () => (BrowserWindow | null | undefined)[], capture: ScreenCapture, now = Date.now) {
  const pending = new Map<number, { id: string; scope: string; region: { width: number; height: number }; engine: string; needsConsent: boolean; expires: number }>();
  let selecting = false;
  const sending = new Set<number>();
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
    return { provider, model, endpoint, local, destination: screenDestination(provider, model),
      scope: JSON.stringify([state.activeOrganizationId, state.activeTenantId, provider.id, model, endpoint, local]) };
  }
  return async (sender: WebContents, request: NovaScreenRequest): Promise<NovaScreenResponse> => {
    if (!windows().some(window => window && !window.isDestroyed() && window.webContents === sender)) throw new Error("Open Nova to ask a screen question.");
    const owner = sender.id;
    switch (request?.action) {
      case "settings":
        await capture.openSettings();
        return { status: "cancelled" };
      case "discard":
        if (pending.get(owner)?.id === request.id) pending.delete(owner);
        return { status: "cancelled" };
      case "capture": {
        if (selecting) throw new Error("Finish the open screen selection first.");
        const previous = pending.get(owner);
        if (previous && previous.expires <= now()) pending.delete(owner);
        if (pending.has(owner) || sending.has(owner))
          throw new Error("Discard or finish the current preview before selecting another area.");
        selecting = true;
        const controller = new AbortController();
        const destroyed = () => { controller.abort(); pending.delete(owner); };
        sender.once("destroyed", destroyed);
        try {
          const current = await settings();
          const image = await capture.capture(sender, controller.signal);
          if (image.status !== "captured") return { status: image.status };
          if (sender.isDestroyed()) return { status: "cancelled" };
          const id = randomUUID();
          const { region, engine, text, thumbnail } = image;
          const { label: destination, providerName: consentProvider } = current.destination;
          pending.set(owner, { id, scope: current.scope, region, engine, needsConsent: Boolean(consentProvider), expires: now() + 300_000 });
          return { status: "preview", id, thumbnail, text, destination, consentProvider, emptyOcr: !text.trim() };
        } finally {
          sender.removeListener("destroyed", destroyed);
          selecting = false;
        }
      }
      case "send": {
        const preview = pending.get(owner);
        if (!preview || preview.id !== request.id) throw new Error("This screen preview is unavailable. Select the area again.");
        if (preview.expires <= now()) {
          pending.delete(owner);
          throw new Error("This screen preview expired. Select the area again.");
        }
        if (sending.has(owner)) throw new Error("Nova is already answering this screen question.");
        requireScreenConsent(preview.needsConsent, request.consent);
        if (typeof request.question !== "string" || !request.question.trim() || Buffer.byteLength(request.question) > NOVA_SCREEN_QUESTION_BYTES ||
            typeof request.text !== "string" || Buffer.byteLength(request.text) > NOVA_SCREEN_TEXT_BYTES)
          throw new Error("Shorten the question or edited screen text and try again.");
        sending.add(owner);
        try {
          const current = await settings();
          if (current.scope !== preview.scope) throw new Error("Nova's provider or organization changed. Select the screen area again.");
          const prepared = await prepareScreenQuestion(request.question, request.text, question => store.retrieveDocumentation(question));
          const llm = await store.novaPublicModel(current.provider.id, current.model, current.endpoint, current.local).catch(() => {
            throw new Error("Check the reasoning provider in Settings, then retry Send.");
          });
          if ((await settings()).scope !== preview.scope || sender.isDestroyed() || pending.get(owner) !== preview || preview.expires <= now()) throw new Error("Nova's session changed. Select the screen area again.");
          try {
            store.recordNovaScreenShare(preview.needsConsent, screenAudit(current.destination.audit, preview.region, preview.engine, prepared.textLength));
          } catch {
            throw new Error("Nova could not record screen sharing in the audit log. Check the audit log in Settings and try again.");
          }
          try {
            const result = await llm.complete({ ...prepared.input, signal: AbortSignal.timeout(120000) });
            if (!result.text.trim()) throw new Error();
            if (pending.get(owner) === preview) pending.delete(owner);
            return { status: "answered", text: result.text };
          } catch {
            throw new Error("Nova's provider could not answer the screen question. Check the provider in Settings, then retry Send.");
          }
        } finally {
          sending.delete(owner);
        }
      }
      default: throw new Error("Open Nova and start a new screen question.");
    }
  };
}
