import { NovaCallAssist } from "./NovaCallAssist";
import { LocalTurns, localPcmWav } from "./local-turns";
// Keep the module same-origin in the production Content Security Policy.
import micWorklet from "./nova-mic.worklet.js?url&no-inline";
import { novaStopCommand } from "../shared/nova-transcript";
import { novaScreenQuestion } from "../shared/nova-command";
import type { NovaScreenResponse } from "@openadminos/agent-sdk";
import { novaKeyLabel } from "../shared/nova-keyboard";
import { systemVoices } from "./system-voices";
import { LocalSpeechSetup } from "./LocalSpeechSetup";
import { providerForModel } from "@openadminos/agent-sdk";
import { hasNovaAudienceGreeting, isNovaIntroduction, novaAudienceReply, NOVA_INTRODUCTION, NOVA_PUBLIC_INTRODUCTION } from "../shared/nova-conversation";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { novaActionIntent, novaConnectorQuestion } from "../shared/nova-action-intent";
import { NovaConversation, ConversationIcon, type NovaConversationItem } from "./NovaConversation";
import { NovaTranscript, isNovaConversationOnly, novaCommentaryChunks } from "../shared/nova-transcript";
import { novaInputWaitMs } from "../shared/nova-input-boundary";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { useAppState } from "../state";
import { Button } from "../components/Button";
import {
  resolveProviderDefaultModel,
  NOVA_SCREEN_TEXT_BYTES,
  NOVA_SCREEN_QUESTION_BYTES,
  type GraphCacheStatus,
  type NovaActivity,
  type NovaActionPreview,
  type NovaAnswerLink,
  type NovaSpeechStatus,
} from "@openadminos/agent-sdk";
import { OPEN_NOVA_EVENT, type OpenNovaDetail } from "../shared/nova-panel";
import { NOVA_CHECK_DOCUMENTATION, NOVA_DOCUMENTATION_SETTINGS, NOVA_INSTALL_DOCUMENTATION, NOVA_SESSION_CONTEXT_CHANGED, NOVA_SESSION_CONTEXT_ENDED_REASON, NOVA_SESSION_ENDED_BEFORE_CARD, NOVA_SESSION_ENDED_REASON, NOVA_SESSION_PROFILE_CHANGED } from "../shared/nova-session";
import "./nova.css";

/** What each Nova card names, explains and asks to confirm. Nothing happens before the click. */
const NOVA_ACTION_TARGET_LABEL: Record<NovaActionPreview["kind"], string> = {
  send: "Destination",
  run: "Destination",
  profile: "Setting",
  remember: "Organization",
  "follow-up": "Organization",
};
const NOVA_ACTION_EXPLANATION: Record<NovaActionPreview["kind"], string> = {
  send: "This sends the content below outside this app through your configured connector.",
  run: "The agent uses the selected tenant. Write plans still require their normal approval.",
  profile: "This changes Nova's settings on this device. Nothing changes until you confirm.",
  remember: "Nova keeps this note on this device and reads it in this organization's conversations. In hosted voice, confirmed notes go to OpenAI with the conversation. Until you confirm, it waits for review in Settings, Nova.",
  "follow-up": "Nova asks this question once more at the time below, in this organization only. It reads, it does not change or send anything.",
};
const NOVA_ACTION_CONFIRM: Record<NovaActionPreview["kind"], string> = {
  send: "Confirm send",
  run: "Confirm run",
  profile: "Confirm change",
  remember: "Confirm note",
  "follow-up": "Confirm follow-up",
};

export function Nova({
  onHostedChange,
  bubble = false,
}: {
  bubble?: boolean;
  onHostedChange?: (active: boolean) => void;
}) {
  const { state, refresh, loading } = useAppState();
  const location = useLocation(),
    navigate = useNavigate();
  const [open, setOpen] = useState(bubble);
  const [question, setQuestion] = useState("");
  const [callPanel, setCallPanel] = useState(false);
  const callAssistEnabled = bubble && state.novaCallAssistAvailable && state.novaProfile?.callAssist === true;
  const showCallPanel = callAssistEnabled && callPanel;
  useEffect(() => {
    if (!callAssistEnabled) setCallPanel(false);
  }, [callAssistEnabled]);
  const [screenQuestion, setScreenQuestion] = useState("");
  const [screenResult, setScreenResult] = useState<NovaScreenResponse>();
  const [screenConsent, setScreenConsent] = useState(false);
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenError, setScreenError] = useState("");
  const screenRevision = useRef(0);
  const bubbleRoot = useRef<HTMLElement>(null);
  const bubbleTalk = useRef<HTMLButtonElement>(null);
  const bubbleConsent = useRef<HTMLInputElement>(null);
  const bubbleTrustId = useId();
  const startRequested = useRef(false);
  const [startSignal, setStartSignal] = useState(0);
  const bubbleAction = useRef<(reason: string) => void>(() => {});
  // Voice mode and greeting name live in Nova's settings in the main process.
  const profile = state.novaProfile;
  const allowedModes = profile?.allowedVoiceModes ?? ["openai", "local"];
  const voiceOff = allowedModes.length === 0;
  const [modeOverride, setModeOverride] = useState<"openai" | "local">();
  const [typedLocal, setTypedLocal] = useState(false);
  const mode: "openai" | "local" = typedLocal ? "local" : modeOverride ?? profile?.voiceMode ?? allowedModes[0] ?? "local";
  const [localSpeech, setLocalSpeech] = useState<NovaSpeechStatus>();
  const waitingForLocalSpeech = mode === "local" && localSpeech?.source === "builtin" &&
    (!localSpeech.ready || !localSpeech.available);
  const [microphoneLive, setMicrophoneLive] = useState(false);
  const resetIdle = useRef<() => void>(() => {});
  const [timings, setTimings] = useState<string>();
  const preferences = localSpeech?.preferences;
  const holdMode = mode === "local" && preferences?.interaction === "hold-to-talk";
  const releaseTalk = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
    else if (phaseRef.current === "connecting") {
      stop();
      setError("Released too soon. Hold to talk until Nova starts listening.");
    }
  };
  const talkPress = {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!holdMode || phaseRef.current !== "idle" || event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      void start();
    },
    onPointerUp: () => { if (holdMode && phaseRef.current !== "idle") releaseTalk(); },
    onPointerCancel: () => { if (holdMode) stop(); },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!holdMode || event.key !== " " || event.repeat || phaseRef.current !== "idle") return;
      event.preventDefault();
      void start();
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!holdMode || event.key !== " ") return;
      event.preventDefault();
      releaseTalk();
    },
  };
  const [typedQuestion, setTypedQuestion] = useState("");
  const [deviceVoice, setDeviceVoice] = useState("");
  const name = profile?.greetingName ?? "";
  const [nameDraft, setNameDraft] = useState<string>();
  const [links, setLinks] = useState<NovaAnswerLink[]>([]);
  const [shortcutNotice, setShortcutNotice] = useState("");
  const [sessionNotice, setSessionNotice] = useState("");
  const queuedShortcut = useRef<string | undefined>(undefined);
  /** Asks the live session a typed request, such as a shortcut picked in the palette. */
  const askTyped = useRef<(text: string) => void>(() => {});
  const requestShortcut = useRef<(shortcut: string) => void>(() => {});
  const [key, setKey] = useState(""),
    [hasKey, setHasKey] = useState(false),
    [consent, setConsent] = useState(false);
  const [pendingAction, setPendingAction] = useState<NovaActionPreview>();
  const [actionBusy, setActionBusy] = useState(false);
  const actionRevision = useRef(0);
  const interruptCurrent = useRef<() => void>(() => {});
  const [phase, setPhase] = useState("idle"), [error, setError] = useState("");
  const [conversationItems, setConversationItems] = useState<NovaConversationItem[]>([]);
  const itemSequence = useRef(0);
  const historyClipped = useRef(false);
  const [incomingTransfer, setIncomingTransfer] = useState<string>();
  const [transferNotice, setTransferNotice] = useState("");
  const appendItem = useCallback((items: NovaConversationItem[], item: NovaConversationItem) => {
    if (items.length >= 80) historyClipped.current = true;
    return [...items.slice(-79), item];
  }, []);
  const conversationToggle = useRef<HTMLButtonElement>(null);
  const appendSpeech = useCallback((role: "user" | "assistant", text: string, startMs?: number, endMs?: number) => {
    const id = `speech-${++itemSequence.current}`;
    setConversationItems(current => {
      const last = current.filter(item => item.kind === "speech" && item.role === role).at(-1);
      // Live speech can overlap. Keep nearby fragments in their speaker's bubble.
      const continues = last?.kind === "speech" && (last === current.at(-1) ||
        (Number.isFinite(startMs) && last.endMs !== undefined && startMs! >= last.endMs && startMs! - last.endMs < 1200));
      if (continues && last?.kind === "speech")
        return current.map(item => item.id === last.id ? { ...last, endMs, text: (last.text + text).slice(-8000) } : item);
      return appendItem(current, { id, kind: "speech", role, text, endMs });
    });
  }, [appendItem]);
  const recordActivity = useCallback((id: string, activity: NovaActivity, result?: string) => {
    setConversationItems(current => {
      const previous = current.find(item => item.id === id && item.kind === "activity");
      const steps = previous?.kind === "activity" ? previous.steps : [];
      const item: NovaConversationItem = { id, kind: "activity",
        status: activity.kind === "answer" ? activity.status : "running",
        steps: (steps.at(-1)?.message === activity.message ? steps : [...steps, activity]).slice(-8), result };
      return previous ? current.map(row => row.id === id ? item : row) : appendItem(current, item);
    });
  }, [appendItem]);
  const endActivities = useCallback((status: "stopped" | "replaced" | "failed") => {
    setConversationItems(current => current.map(item =>
      item.kind === "activity" && item.status === "running" ? { ...item, status } : item));
  }, []);
  const [connectionCheck, setConnectionCheck] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const keyRevision = useRef(0);
  const liveReady = useRef(false);
  const [checking, setChecking] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<GraphCacheStatus>();
  const reasoningEndpoint = state.providers.find(
    (p) => p.id === state.activeProviderId,
  );
  const reasoningModel = resolveProviderDefaultModel(
    reasoningEndpoint,
    state.activeModelByProviderId,
  ).model;
  const reasoning = providerForModel(reasoningEndpoint, reasoningModel);
  const hostedReasoningDisclosure = reasoning && !reasoning.isLocal
    ? state.activeTenantId
      ? `Your question and relevant tenant context go to ${reasoning.name} for reasoning.`
      : `Your question, recent turns and documentation passages go to ${reasoning.name} for reasoning.`
    : "";
  const publicHostedDisclosure = ["Audio and Nova’s instructions go to OpenAI.", hostedReasoningDisclosure, "No organization data is shared."].filter(Boolean).join(" ");
  const trustDisclosure = mode === "openai"
    ? state.activeTenantId
      ? ["Hosted voice · Audio, relevant tenant context, public web searches, Nova instructions and confirmed notes go to OpenAI.", hostedReasoningDisclosure].filter(Boolean).join(" ")
      : `Hosted voice · ${publicHostedDisclosure}`
    : [localSpeech?.source === "servers"
      ? "Local voice · audio goes to your loopback services."
      : "Local voice · audio stays on this device.", hostedReasoningDisclosure].filter(Boolean).join(" ");
  const consentDisclosure = state.activeTenantId
    ? `Allow audio, relevant tenant context and public web research queries to the selected hosted providers for this session. Your Nova instructions and this organization's confirmed notes, when set, go to OpenAI too. ${hostedReasoningDisclosure}`.trim()
    : `Allow hosted processing for this session. ${publicHostedDisclosure}`;
  const reasoningReady =
    reasoning?.status === "connected" &&
    (mode !== "local" || reasoning.isLocal);
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);
  const [captions, setCaptions] = useState(() => localStorage.getItem("nova.conversation-visible") === "true");
  const toggleConversation = useCallback((visible: boolean) => {
    setCaptions(visible);
    localStorage.setItem("nova.conversation-visible", String(visible));
    if (!visible) conversationToggle.current?.focus();
  }, []);
  const [muted, setMuted] = useState(false);
  const [settings, setSettings] = useState(false);
  const [playBlocked, setPlayBlocked] = useState(false);
  const mutedRef = useRef(false);
  const playbackAnalyser = useRef<AnalyserNode | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [conversation, setConversation] = useState<string>();
  const generation = useRef(0),
    peer = useRef<RTCPeerConnection | null>(null),
    channel = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null),
    context = useRef<AudioContext | null>(null),
    output = useRef<HTMLAudioElement | null>(null);
  const frame = useRef(0),
    orb = useRef<HTMLElement>(null),
    recorder = useRef<MediaRecorder | null>(null),
    sessionId = useRef("");
  const completedResult = useRef<string | undefined>(undefined);
  const delegationTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const micActivityTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    blobUrl = useRef("");
  const api = window.openAdminOS;
  useEffect(() => {
    if (modeOverride && profile?.voiceMode === modeOverride) setModeOverride(undefined);
  }, [modeOverride, profile?.voiceMode]);
  // Move the values this device kept in local storage into Nova's settings, once.
  const [migrationError, setMigrationError] = useState("");
  const [migrationAttempt, setMigrationAttempt] = useState(0);
  useEffect(() => {
    if (!api?.novaProfile) return;
    let storedMode: string | null, storedName: string | null;
    try {
      storedMode = localStorage.getItem("nova.voice-mode");
      storedName = localStorage.getItem("nova.greeting-name");
    } catch { return; }
    if (storedMode === null && storedName === null) return;
    void api.novaProfile({
      action: "migrate",
      ...(storedMode === "local" || storedMode === "openai" ? { voiceMode: storedMode } : {}),
      ...(storedName?.trim() ? { greetingName: storedName.trim().slice(0, 40) } : {}),
    }).then(() => {
      setMigrationError("");
      try {
        localStorage.removeItem("nova.voice-mode");
        localStorage.removeItem("nova.greeting-name");
      } catch { /* The next start tries again; the move is idempotent. */ }
      void refresh();
    }).catch((caught) => {
      // The values stay in local storage until the move succeeds.
      setMigrationError(`Nova could not move the voice mode and greeting name saved on this device into its settings, so they are not applied yet. ${voiceErrorMessage(caught)}`);
    });
  }, [api, refresh, migrationAttempt]);
  const saveProfile = async (patch: Parameters<NonNullable<typeof api>["novaProfile"]>[0] & { action: "save" }) => {
    if (!api?.novaProfile) return false;
    try {
      await api.novaProfile(patch);
      await refresh();
      return true;
    } catch (caught) {
      setError(voiceErrorMessage(caught));
      return false;
    }
  };
  function showAnswerLinks(answer: { links?: NovaAnswerLink[]; route?: string }) {
    const links = answer.links ?? [];
    if (bubble && answer.route && !links.some(link => link.route === answer.route)) {
      setLinks([...links, { label: "", route: answer.route }]);
      return;
    }
    setLinks(links);
    if (!bubble && answer.route) {
      setExpanded(false);
      navigate(answer.route);
    }
  }
  const decideAction = async (approved: boolean) => {
    if (!pendingAction || actionBusy || !api) return;
    const token = generation.current;
    const revision = ++actionRevision.current;
    setActionBusy(true);
    try {
      const answer = await api.nova({ action: "decide-action", sessionId: sessionId.current, actionId: pendingAction.id, approved },
        event => { if (token === generation.current && revision === actionRevision.current) recordActivity(pendingAction.id, event); });
      if (token !== generation.current || revision !== actionRevision.current) return;
      setPendingAction(undefined);
      setError(answer.answerError || "");
      completedResult.current = answer.text;
      const dc = channel.current;
      if (dc?.readyState !== "open") appendSpeech("assistant", answer.text || "No action result returned.");
      if (dc?.readyState === "open") {
        if (output.current) output.current.muted = false;
        for (const content of novaCommentaryChunks(answer.text || "No action result returned."))
          dc.send(JSON.stringify({ type: "session.commentary.append", delegation_id: null, content }));
      }
      showAnswerLinks(answer);
    } catch (error) {
      if (token === generation.current && revision === actionRevision.current) {
        setPendingAction(undefined);
        // The main process ended a hosted session whose instructions or notes changed: close the audio too.
        // What happened to the card follows the message.
        const text = String(error);
        if (text.includes(NOVA_SESSION_PROFILE_CHANGED)) {
          stop();
          setError(text.slice(text.indexOf(NOVA_SESSION_PROFILE_CHANGED)));
        } else if (text.includes(NOVA_SESSION_ENDED_BEFORE_CARD)) {
          stop();
          setError(text.slice(text.indexOf(NOVA_SESSION_ENDED_BEFORE_CARD)));
        } else if (text.includes(NOVA_SESSION_CONTEXT_CHANGED)) {
          stop();
          setError(text.slice(text.indexOf(NOVA_SESSION_CONTEXT_CHANGED)));
        } else setError(text);
      }
    }
    finally { if (revision === actionRevision.current) setActionBusy(false); }
  };
  const stop = useCallback(() => {
    generation.current++;
    resetIdle.current = () => {};
    setMicrophoneLive(false);
    phaseRef.current = "idle";
    ++actionRevision.current;
    setActionBusy(false);
    setPendingAction(undefined);
    interruptCurrent.current = () => {};
    askTyped.current = () => {};
    window.speechSynthesis?.cancel();
    setDeviceVoice("");
    setTypedLocal(false);
    if (!bubble) setLinks([]);
    endActivities("stopped");
    liveReady.current = false;
    setConsent(false);
    setKey("");
    clearTimeout(timeout.current);
    clearInterval(micActivityTimer.current);
    micActivityTimer.current = undefined;
    delegationTimers.current.forEach(clearTimeout);
    delegationTimers.current.clear();
    cancelAnimationFrame(frame.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    recorder.current = null;
    mic.current?.getTracks().forEach((t) => t.stop());
    mic.current = null;
    const closingChannel = channel.current,
      closingPeer = peer.current;
    channel.current = null;
    peer.current = null;
    if (closingChannel?.readyState === "open") {
      const finalize = () => {
        clearTimeout(deadline);
        closingChannel.close();
        closingPeer?.close();
      };
      const deadline = setTimeout(finalize, 15000);
      closingChannel.addEventListener("message", (event) => {
        try {
          if (JSON.parse(event.data).type === "session.closed") finalize();
        } catch {
          /* Ignore malformed finalization events. */
        }
      });
      try {
        closingChannel.send(JSON.stringify({ type: "session.close" }));
      } catch {
        finalize();
      }
    } else {
      closingChannel?.close();
      closingPeer?.close();
    }
    void context.current?.close().catch(() => {});
    context.current = null;
    playbackAnalyser.current = null;
    mutedRef.current = false;
    setMuted(false);
    setChecking(false);
    setPlayBlocked(false);
    if (output.current) {
      output.current.pause();
      output.current.muted = false;
      output.current.srcObject = null;
      output.current.removeAttribute("src");
    }
    URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = "";
    sessionId.current = "";
    setSessionNotice("");
    orb.current?.style.setProperty("--voice-level", "0");
    void api?.nova({ action: "stop" }).catch(() => {});
    setPhase("idle");
  }, [api, bubble, endActivities]);
  // The main process ends a hosted voice session when its instructions or
  // notes change, and any session when its organization, connection or
  // provider changes; the audio and the connection to OpenAI close here at once.
  useEffect(() => {
    if (!api?.onAppStateChanged) return;
    return api.onAppStateChanged((info) => {
      const ended = info.reason === NOVA_SESSION_ENDED_REASON ? NOVA_SESSION_PROFILE_CHANGED : info.reason === NOVA_SESSION_CONTEXT_ENDED_REASON ? NOVA_SESSION_CONTEXT_CHANGED : undefined;
      if (!ended || !sessionId.current) return;
      stop();
      setError(ended);
    });
  }, [api, stop]);
  useEffect(() => {
    stop();
    setConsent(false);
    setConnectionCheck("");
    setCacheStatus(undefined);
    setConversation(undefined);
    setLinks([]);
    setConversationItems([]);
    historyClipped.current = false;
  }, [
    state.activeTenantId,
    state.activeProviderId,
    reasoningModel,
    reasoning?.isLocal,
    stop,
  ]);
  useEffect(() => {
    let cancelled = false;
    const revision = keyRevision.current;
    if (open)
      void api
        ?.nova({ action: "status" })
        .then((result) => {
          if (!cancelled && revision === keyRevision.current)
            setHasKey(!!result.hasKey);
        })
        .catch((error) => {
          if (!cancelled && revision === keyRevision.current)
            setError(voiceErrorMessage(error));
        });
    return () => {
      cancelled = true;
    };
  }, [open, api]);
  useEffect(() => {
    let cancelled = false;
    if (open && state.activeTenantId)
      void api
        ?.getGraphCacheStatus(state.activeTenantId)
        .then((result) => {
          if (!cancelled) setCacheStatus(result);
        })
        .catch(() => {
          if (!cancelled) setCacheStatus(undefined);
        });
    return () => {
      cancelled = true;
    };
  }, [open, state.activeTenantId, api]);
  async function configureKey(apiKey: string | null) {
    if (!api || savingKey) return;
    keyRevision.current++;
    setSavingKey(true);
    setConnectionCheck("");
    setConsent(false);
    try {
      const result = await api.nova({ action: "configure", apiKey });
      setKey("");
      setHasKey(!!result.hasKey);
      setError("");
    } catch (error) {
      setError(voiceErrorMessage(error));
    } finally {
      setSavingKey(false);
    }
  }
  async function checkSetup() {
    if (!api) return;
    const token = generation.current;
    setChecking(true);
    setConnectionCheck("");
    setError("");
    try {
      const result = await api.nova({ action: "check", mode });
      if (token !== generation.current) return;
      setConnectionCheck(result.text || "Connection checked.");
      if (state.activeTenantId) {
        const snapshot = await api.getGraphCacheStatus(state.activeTenantId);
        if (token === generation.current) setCacheStatus(snapshot);
      }
    } catch (error) {
      if (token === generation.current)
        setError(voiceErrorMessage(error));
    } finally {
      if (token === generation.current) setChecking(false);
    }
  }
  useEffect(() => {
    const openPanel = (event?: Event) => {
      setOpen(true);
      const shortcut = (event as CustomEvent<OpenNovaDetail | undefined> | undefined)?.detail?.shortcut;
      if (shortcut) requestShortcut.current(shortcut);
    };
    const keydown = (e: KeyboardEvent) => {
      if (!bubble && e.key === "Escape") stop();
      if (!bubble && e.code === "KeyV" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.defaultPrevented) {
        e.preventDefault();
        if (!e.repeat) openPanel();
      }
    };
    const hidden = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener(OPEN_NOVA_EVENT, openPanel);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener(OPEN_NOVA_EVENT, openPanel);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [bubble, stop]);
  useEffect(() => {
    if (!api?.novaWindow || !api.onAppStateChanged) return;
    const unsubscribe = api.onAppStateChanged(({ reason }) => bubbleAction.current(reason));
    void api.novaWindow(bubble ? "ready" : "ready-main").catch(error => setError(voiceErrorMessage(error)));
    return unsubscribe;
  }, [api, bubble]);

  async function lookAtScreen(text: string, replacePreview = false) {
    if (!api?.novaScreen || screenBusy || (!replacePreview && screenResult?.status === "preview")) return;
    const revision = ++screenRevision.current;
    stop();
    setScreenResult(undefined);
    setScreenError("");
    setScreenConsent(false);
    setScreenQuestion(text);
    setScreenBusy(true);
    try {
      if (replacePreview && screenResult?.status === "preview") {
        await api.novaScreen({ action: "discard", id: screenResult.id });
      }
      const result = await api.novaScreen({ action: "capture" });
      if (revision === screenRevision.current) {
        setScreenResult(result.status === "cancelled" ? undefined : result);
      } else if (result.status === "preview") {
        await api.novaScreen({ action: "discard", id: result.id });
      }
    } catch (error) {
      if (revision === screenRevision.current) setScreenError(voiceErrorMessage(error));
    } finally {
      setScreenBusy(false);
    }
  }

  function discardScreen() {
    ++screenRevision.current;
    if (screenResult?.status === "preview") void api?.novaScreen({ action: "discard", id: screenResult.id }).catch(() => {});
    setScreenResult(undefined);
    setScreenError("");
    setScreenQuestion("");
    setScreenConsent(false);
  }

  const screenTextBytes = screenResult?.status === "preview" ? new TextEncoder().encode(screenResult.text).length : 0;
  const screenQuestionTooLong = new TextEncoder().encode(screenQuestion).length > NOVA_SCREEN_QUESTION_BYTES;
  const screenTextTooLong = screenTextBytes > NOVA_SCREEN_TEXT_BYTES;

  async function sendScreen() {
    if (!api || screenBusy || screenResult?.status !== "preview" || screenTextTooLong || screenQuestionTooLong) return;
    const revision = ++screenRevision.current;
    setScreenError("");
    setScreenBusy(true);
    try {
      const { id, text } = screenResult;
      const result = await api.novaScreen({ action: "send", id, text, question: screenQuestion, consent: screenConsent });
      if (revision === screenRevision.current) setScreenResult(result);
    } catch (error) {
      if (revision === screenRevision.current) setScreenError(voiceErrorMessage(error));
    } finally {
      setScreenBusy(false);
    }
  }

  const screenControls = <section className="nova-screen-controls" aria-label="Screen questions">
    {screenResult?.status !== "preview" && <Button size="sm" variant="secondary" disabled={screenBusy}
      onClick={() => void lookAtScreen(screenQuestion || (bubble ? question : typedQuestion))}>
      Look at screen
    </Button>}
    {screenQuestion && !screenResult && !screenBusy && !screenError && <p role="status">Select Look at screen to choose an area.</p>}
    {screenBusy && <p role="status">Working on your screen question…</p>}
    {screenError && <p role="alert">{screenError}</p>}
    {screenResult?.status === "permission" && <div role="status">
      <p>Allow OpenAdminOS in Screen Recording, then restart the app. If OpenAdminOS is missing from the list, use the + button to add it.</p>
      <Button size="sm" onClick={() => void api?.novaScreen({ action: "settings" }).catch(error => setScreenError(voiceErrorMessage(error)))}>Open Screen Recording settings</Button>
    </div>}
    {screenResult?.status === "preview" && screenResult.emptyOcr && <div className="nova-screen-preview">
      <p role="status">No text found in this area.</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void lookAtScreen(screenQuestion, true)} disabled={screenBusy}>Select again</Button>
        <Button size="sm" variant="secondary" onClick={discardScreen}>Discard</Button>
      </div>
    </div>}
    {screenResult?.status === "preview" && !screenResult.emptyOcr && <form className="nova-screen-preview" onSubmit={event => { event.preventDefault(); void sendScreen(); }}>
      <img src={screenResult.thumbnail} alt="Selected screen area" />
      <fieldset disabled={screenBusy} className="nova-screen-fields">
        <div className="nova-screen-text-label">
          <label htmlFor={`${bubbleTrustId}-screen-text`}>Screen text</label>
          <Button type="button" size="sm" variant="ghost" onClick={() => setScreenResult({ ...screenResult, text: "" })}>Remove text</Button>
        </div>
        <textarea id={`${bubbleTrustId}-screen-text`} rows={3} value={screenResult.text} aria-invalid={screenTextTooLong}
          aria-describedby={`${bubbleTrustId}-screen-limit`}
          onChange={event => setScreenResult({ ...screenResult, text: event.target.value })} />
        <small id={`${bubbleTrustId}-screen-limit`}>{screenTextBytes} / {NOVA_SCREEN_TEXT_BYTES} bytes{screenTextTooLong ? ". Shorten the screen text." : ""}</small>
        <label className="nova-field">Question<input autoFocus value={screenQuestion} maxLength={NOVA_SCREEN_QUESTION_BYTES} aria-invalid={screenQuestionTooLong}
          onChange={event => setScreenQuestion(event.target.value)} /></label>
        {screenQuestionTooLong && <p role="alert">Shorten the question to {NOVA_SCREEN_QUESTION_BYTES} bytes.</p>}
        <p>{screenResult.destination}</p>
        <p>Nova answers from this text and public documentation, without looking up your organization.</p>
        {screenResult.consentProvider && <label><input type="checkbox" checked={screenConsent}
          onChange={event => setScreenConsent(event.target.checked)} /> Allow sending this screen text to {screenResult.consentProvider}</label>}
        <div className="flex gap-2">
          <Button size="sm" type="submit" disabled={!screenQuestion.trim() || screenTextTooLong || screenQuestionTooLong || (Boolean(screenResult.consentProvider) && !screenConsent)}>Send</Button>
          <Button size="sm" type="button" variant="secondary" onClick={discardScreen}>Discard</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => void lookAtScreen(screenQuestion, true)}>Select again</Button>
        </div>
      </fieldset>
    </form>}
    {screenResult?.status === "answered" && <div className="nova-screen-preview">
      <MarkdownPreview source={screenResult.text} className="nova-markdown" />
      <div className="flex gap-2">
        {state.activeTenantId && <Button size="sm" onClick={() => {
          if (bubble) void api?.novaWindow("draft-screen-question", screenQuestion).catch(error => setScreenError(voiceErrorMessage(error)));
          else {
            navigate("/chat", { state: { screenQuestionDraft: screenQuestion } });
            discardScreen();
            setOpen(false);
          }
        }}>Ask in Chat</Button>}
        <Button size="sm" variant="secondary" onClick={discardScreen}>Clear answer</Button>
      </div>
    </div>}
  </section>;

  async function start(typed?: string) {
    if (typed && novaScreenQuestion(typed)) {
      setScreenQuestion(typed);
      return;
    }
    if (!api || phaseRef.current !== "idle" || (!typed && waitingForLocalSpeech)) return;
    const useTypedLocal = Boolean(typed && reasoning?.isLocal && allowedModes.includes("local") && (!bubble || mode === "local"));
    if (!reasoningReady || voiceOff || (!useTypedLocal && mode === "openai" && (!hasKey || !consent))) {
      if (bubble) {
        const needsConsent = reasoningReady && !voiceOff && mode === "openai" && hasKey && !consent;
        setError(needsConsent ? "Confirm hosted sharing for this session, then select Talk or Ask." :
          "Review voice and provider setup in OpenAdminOS.");
        if (needsConsent) bubbleConsent.current?.focus();
      }
      return;
    }
    stop();
    phaseRef.current = "connecting";
    const token = generation.current;
    setError("");
    setLinks([]);
    if (!bubble) { setConversationItems([]); historyClipped.current = false; }
    setDeviceVoice("");
    setTimings(undefined);
    setTypedLocal(useTypedLocal);
    setPhase("connecting");
    const fail = (e: unknown) => {
      if (generation.current === token) {
        endActivities("failed");
        stop();
        setError(voiceErrorMessage(e));
      }
    };
    let turnRevision = 0;
    let liveLocal = false;
    let turns: LocalTurns | undefined;
    let cappedTurn = false;
    let pendingTranscript: string | undefined;
    let showTurnTimings = preferences?.showTimings ?? false;
    const interruptLocal = () => {
      ++turnRevision;
      endActivities("stopped");
      setPendingAction(undefined);
      window.speechSynthesis?.cancel();
      setDeviceVoice("");
      if (output.current) {
        output.current.onended = null;
        output.current.onerror = null;
        output.current.pause();
        output.current.removeAttribute("src");
      }
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
      blobUrl.current = "";
      phaseRef.current = "listening";
      setPhase("listening");
      return api.nova({ action: "interrupt", sessionId: sessionId.current! });
    };
    const respond = async (text: string, languageHint?: string, timing?: { end: number; transcript: number }): Promise<void> => {
      setTimings(undefined);
      const revision = ++turnRevision;
      const current = () => token === generation.current && revision === turnRevision;
      const stopCommand = mode === "local" ? novaStopCommand(text.replace(/\bstop answer\b/i, "stop the answer")) : undefined;
      if (stopCommand !== undefined) {
        cappedTurn = false;
        turns?.clearSubmitted();
        await interruptLocal();
        if (!stopCommand) {
          pendingTranscript = undefined;
          if (!liveLocal) stop();
          return;
        }
        return respond(stopCommand, languageHint, timing);
      }
      const activityId = `local-${++itemSequence.current}`;
      const answer = await api.nova({
        action: "answer",
        sessionId: sessionId.current,
        text,
      }, event => { if (current()) recordActivity(activityId, event); }).catch(error => {
        if (current()) {
          appendSpeech("user", text);
          fail(error);
        }
        return undefined;
      });
      if (!answer || !current()) return;
      turns?.clearSubmitted();
      if (cappedTurn) setSessionNotice("");
      cappedTurn = false;
      pendingTranscript = undefined;
      appendSpeech("user", text);
      const readyAt = performance.now();
      let firstAudio = false;
      const reportAudio = () => {
        if (!timing || firstAudio) return;
        firstAudio = true;
        const transcriptMs = Math.round(timing.transcript - timing.end);
        const answerMs = Math.round(readyAt - timing.transcript);
        const audioMs = Math.round(performance.now() - readyAt);
        if (showTurnTimings) console.info("[nova-speech] local turn ms", { transcriptMs, answerMs, audioMs });
        setTimings(`End of speech to transcript ${transcriptMs} ms · Transcript to answer ${answerMs} ms · Answer to audio ${audioMs} ms`);
      };
      if (answer.screenQuestion) {
        stop();
        setScreenQuestion(answer.screenQuestion);
        return;
      }
      setPendingAction(answer.pendingAction);
      setError(answer.answerError || "");
      appendSpeech("assistant", answer.text || "No answer returned.");
      recordActivity(activityId, { kind: "answer", status: answer.answerError ? "failed" : "completed", message: answer.answerError || (answer.pendingAction ? "Awaiting your review" : "Result retrieved") }, answer.displayText || answer.text);
      setConversation(answer.conversationId);
      setLinks(answer.links ?? []);
      showAnswerLinks(answer);
      const finish = () => {
        if (!current()) return;
        if (liveLocal || answer.pendingAction) { phaseRef.current = "listening"; setPhase("listening"); return; }
        stop();
        if (answer.links?.length) setLinks(answer.links);
      };
      const speakWithSystem = async (text: string, language?: string) => {
        const synth = window.speechSynthesis;
        const requested = language || "en";
        const label = language ? new Intl.DisplayNames(["en"], { type: "language" }).of(language) : undefined;
        const voices = synth ? await systemVoices(synth) : [];
        if (!current()) return;
        const voice = voices.find(candidate =>
          candidate.localService && candidate.lang.toLowerCase().split("-")[0] === requested);
        if (!voice || !synth || !text) {
          finish();
          if (label) setError(`Install a system voice for ${label} to hear this answer, or read it in the conversation.`);
          return;
        }
        setDeviceVoice(label ? `Speaking with the system voice for ${label}` : "Speaking with your device's voice");
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        utterance.onstart = reportAudio;
        utterance.onend = finish;
        const playbackFailed = () => {
          if (!current()) return;
          finish();
          setError("Device voice could not play. Read Nova's answer in the conversation.");
        };
        utterance.onerror = playbackFailed;
        phaseRef.current = "speaking";
        setPhase("speaking");
        try {
          synth.speak(utterance);
        } catch {
          playbackFailed();
        }
      };
      const queue: Uint8Array[] = [];
      let playing = false;
      let finished = false;
      let remainingText = (answer.text || "").slice(0, 5000);
      let fallbackText = "";
      const playNext = () => {
        if (!current() || playing) return;
        const wav = queue.shift();
        if (!wav) {
          if (finished) {
            if (fallbackText) {
              const remainder = fallbackText;
              fallbackText = "";
              void speakWithSystem(remainder).catch(fail);
            } else finish();
          }
          return;
        }
        const player = output.current;
        if (!player) return;
        playing = true;
        if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
        blobUrl.current = URL.createObjectURL(new Blob([new Uint8Array(wav)], { type: "audio/wav" }));
        player.src = blobUrl.current;
        phaseRef.current = "speaking";
        setPhase("speaking");
        player.onended = () => { playing = false; playNext(); };
        player.onerror = () => fail(new Error("Local speech could not play. Check your audio device, then retry."));
        void player.play().then(() => { if (current()) reportAudio(); }).catch(error => { if (current()) fail(error); });
      };
      const enqueue = (wav: Uint8Array, remaining?: string) => {
        if (!current() || !wav.byteLength) return;
        if (remaining !== undefined) remainingText = remaining;
        queue.push(wav);
        playNext();
      };
      try {
        const speech = await api.nova({
          action: "speak", sessionId: sessionId.current, text: (answer.text || "").slice(0, 5000), languageHint,
        }, undefined, enqueue);
        if (!current()) return;
        if (speech.speechLanguage) { await speakWithSystem(answer.text || "", speech.speechLanguage); return; }
        if (speech.audio?.length) enqueue(new Uint8Array(speech.audio));
        finished = true;
        playNext();
      } catch (error) {
        if (!current()) return;
        setError(voiceErrorMessage(error));
        fallbackText = remainingText;
        finished = true;
        playNext();
      }
    };
    try {
      if (typed && useTypedLocal) {
        await api.novaWindow?.("claim-typed");
        if (token !== generation.current) return;
        const result = await api.nova({ action: "start", mode: "local", tenantId: state.activeTenantId, consent: false, name });
        if (token !== generation.current) return;
        sessionId.current = result.sessionId!;
        setPhase("thinking");
        toggleConversation(true);
        await respond(typed);
        return;
      }
      await api.nova({ action: "check", mode, connectivity: false });
      if (token !== generation.current) return;
      await api.novaWindow?.(typed ? "claim-typed" : "claim");
      if (token !== generation.current) return;
      const speechStatus = mode === "local" && !typed
        ? localSpeech ?? (await api.nova({ action: "speech-status" })).speech
        : undefined;
      if (token !== generation.current) return;
      if (speechStatus && speechStatus !== localSpeech) setLocalSpeech(speechStatus);
      const localPreferences = speechStatus?.preferences;
      showTurnTimings = localPreferences?.showTimings ?? showTurnTimings;
      const stream = typed ? new MediaStream() : await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, ...(mode === "local" ? { autoGainControl: true, channelCount: 1 } : {}) },
        video: false,
      });
      if (token !== generation.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      mic.current = stream;
      if (mode === "local") setMicrophoneLive(true);
      const localHandsFree = localPreferences?.interaction === "hands-free";
      const audioContext = localHandsFree ? new AudioContext({ sampleRate: 16000 }) : new AudioContext();
      context.current = audioContext;
      if (localHandsFree && audioContext.sampleRate !== 16000)
        throw new Error(`The microphone opened at ${audioContext.sampleRate} Hz. Select Hold to talk in Settings > Nova or use a microphone that supports 16000 Hz.`);
      await audioContext.resume();
      if (token !== generation.current) return;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      if (!typed) audioContext.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const playbackSamples = new Uint8Array(512);
      let level = 0,
        lastPlayback = 0,
        pendingAnswers = 0;
      let lastVoiceAt = Date.now();
      const rms = (values: Uint8Array) => {
        let sum = 0;
        for (const sample of values) sum += ((sample - 128) / 128) ** 2;
        return Math.min(1, Math.sqrt(sum / values.length) * 7);
      };
      const sampleMicrophone = () => {
        if (token !== generation.current) return;
        analyser.getByteTimeDomainData(samples);
        // Transcript delivery can pause while the microphone still carries speech.
        // This is an amplitude guard, not a claim of semantic end-of-speech detection.
        if (!mutedRef.current && rms(samples) > 0.08) lastVoiceAt = Date.now();
      };
      // Request routing must not depend on the orb receiving animation frames.
      micActivityTimer.current = setInterval(sampleMicrophone, 50);
      const animate = () => {
        if (token !== generation.current) return;
        sampleMicrophone();
        let outputLevel = 0;
        if (playbackAnalyser.current) {
          playbackAnalyser.current.getByteTimeDomainData(playbackSamples);
          outputLevel = rms(playbackSamples);
          if (outputLevel > 0.025 && !output.current?.paused && !output.current?.muted) {
            lastPlayback = performance.now();
            if (phaseRef.current !== "speaking") {
              phaseRef.current = "speaking";
              setPhase("speaking");
            }
          } else if (
            phaseRef.current === "speaking" &&
            performance.now() - lastPlayback > 650
          ) {
            phaseRef.current = pendingAnswers > 0 ? "thinking" : "listening";
            setPhase(phaseRef.current);
          }
        }
        const target = Math.max(
          mutedRef.current ? 0 : rms(samples),
          outputLevel,
        );
        level += (target - level) * (target > level ? 0.45 : 0.12);
        orb.current?.style.setProperty("--voice-level", String(level));
        frame.current = requestAnimationFrame(animate);
      };
      animate();
      stream
        .getAudioTracks()[0]
        ?.addEventListener("ended", () =>
          fail(
            new Error(
              "Microphone disconnected. Check your input device and start again.",
            ),
          ),
        );
      if (mode === "local") {
        const result = await api.nova({
          action: "start",
          mode,
          tenantId: state.activeTenantId,
          consent: false,
          name,
        });
        if (token !== generation.current) return;
        sessionId.current = result.sessionId!;
        setSessionNotice(result.notice ?? "");
        if (localHandsFree) {
          await audioContext.audioWorklet.addModule(micWorklet);
          if (token !== generation.current) return;
          const node = new AudioWorkletNode(audioContext, "nova-mic", { numberOfOutputs: 0 });
          audioContext.createMediaStreamSource(stream).connect(node);
          liveLocal = true;
          turns = new LocalTurns(localPreferences.silenceMs);
          const clockOrigin = performance.now() - audioContext.currentTime * 1000;
          let busy = false;
          let latest: CaptureFrame[] | undefined;
          resetIdle.current = () => {
            clearTimeout(timeout.current);
            if (phaseRef.current !== "listening" || mutedRef.current) return;
            timeout.current = setTimeout(() => {
              if (token !== generation.current || phaseRef.current !== "listening" || mutedRef.current) return;
              stop();
              setError("Microphone closed after inactivity. Start Nova to listen again.");
            }, localPreferences.idleSeconds * 1000);
          };
          const transcribe = async (frames: Float32Array[], end: number) => {
            const revision = ++turnRevision;
            const current = () => token === generation.current && revision === turnRevision;
            setTimings(undefined);
            phaseRef.current = "thinking";
            resetIdle.current();
            setPhase("thinking");
            try {
              const heard = await api.nova({ action: "transcribe", sessionId: sessionId.current!, audio: localPcmWav(frames) });
              if (!current()) return;
              if (heard.text?.trim()) {
                pendingTranscript = heard.text;
                await respond(heard.text, heard.speechLanguage, { end, transcript: performance.now() });
              } else {
                if (cappedTurn) setSessionNotice("");
                if (pendingTranscript) appendSpeech("user", pendingTranscript);
                pendingTranscript = undefined;
                setError("Nova could not recognize the question. Try again closer to the microphone.");
                turns?.clearSubmitted();
                cappedTurn = false;
                phaseRef.current = "listening";
                setPhase("listening");
              }
            } catch (caught) {
              if (current()) {
                if (pendingTranscript) appendSpeech("user", pendingTranscript);
                fail(caught);
              }
            }
          };
          type CaptureFrame = { frame: Float32Array; captured: number };
          const detect = async (batch: CaptureFrame[]) => {
            busy = true;
            try {
              const { speechProbabilities } = await api.nova({
                action: "vad", sessionId: sessionId.current!, frames: batch.map(({ frame }) => frame),
              });
              if (token !== generation.current || mutedRef.current || cappedTurn) return;
              for (const [index, { frame, captured }] of batch.entries()) {
                const event = turns!.accept(frame, speechProbabilities?.[index] ?? 0, phaseRef.current === "speaking", captured);
                if (event.speech && phaseRef.current === "listening") resetIdle.current();
                if (event.resume) {
                  await interruptLocal();
                  if (token !== generation.current) return;
                  phaseRef.current = "thinking";
                  setPhase("thinking");
                } else if (event.bargeIn) {
                  await interruptLocal();
                  if (token !== generation.current) return;
                }
                if (event.submit) {
                  cappedTurn = event.capped;
                  if (cappedTurn) setSessionNotice("Nova sent the first minute. Wait for the answer, then continue.");
                  void transcribe(event.submit, clockOrigin + event.end);
                  if (cappedTurn) break;
                }
              }
            } catch (error) {
              fail(error);
            } finally {
              busy = false;
              const next = latest;
              latest = undefined;
              if (next && token === generation.current && !cappedTurn && !mutedRef.current) void detect(next);
            }
          };
          node.port.onmessage = ({ data }: MessageEvent<CaptureFrame[]>) => {
            if (token !== generation.current || mutedRef.current || cappedTurn) return;
            // Keep one fresh batch under load instead of queuing stale VAD work.
            if (busy) latest = data;
            else void detect(data);
          };
          askTyped.current = text => {
            cappedTurn = false;
            pendingTranscript = undefined;
            turns!.reset();
            void interruptLocal().then(() => respond(text)).catch(fail);
          };
          interruptCurrent.current = () => {
            if (cappedTurn) setSessionNotice("");
            cappedTurn = false;
            pendingTranscript = undefined;
            turns!.reset();
            void interruptLocal().catch(fail);
          };
          phaseRef.current = "listening";
          setPhase("listening");
          const queued = queuedShortcut.current;
          if (queued) { queuedShortcut.current = undefined; askTyped.current(`Run shortcut ${queued}`); }
          return;
        }
        const recorded: Blob[] = [];
        const rec = new MediaRecorder(typed ? audioContext.createMediaStreamDestination().stream : stream);
        recorder.current = rec;
        rec.ondataavailable = (e) => {
          if (e.data.size) recorded.push(e.data);
        };
        rec.onstop = () => {
          const end = performance.now();
          void (async () => {
            if (token !== generation.current) return;
            clearTimeout(timeout.current);
            setMicrophoneLive(false);
            mic.current?.getTracks().forEach((t) => {
              t.onended = null;
              t.stop();
            });
            mic.current = null;
            setPhase("thinking");
            const decoded = await audioContext.decodeAudioData(
              await new Blob(recorded).arrayBuffer(),
            );
            if (token !== generation.current) return;
            const offline = new OfflineAudioContext(
              1,
              Math.ceil(decoded.duration * 16000),
              16000,
            );
            const source = offline.createBufferSource();
            source.buffer = decoded;
            source.connect(offline.destination);
            source.start();
            const resampled = await offline.startRendering();
            if (token !== generation.current) return;
            const heard = await api.nova({
              action: "transcribe",
              sessionId: sessionId.current,
              audio: localPcmWav([resampled.getChannelData(0)]),
            });
            if (token !== generation.current) return;
            if (!heard.text?.trim())
              throw new Error(
                "No speech recognized. Try again closer to the microphone.",
              );
            await respond(heard.text, heard.speechLanguage, { end, transcript: performance.now() });
          })().catch(fail);
        };
        const queued = typed || (queuedShortcut.current && `Run shortcut ${queuedShortcut.current}`);
        if (queued) {
          // A shortcut picked before the session started runs instead of a recording.
          queuedShortcut.current = undefined;
          setShortcutNotice("");
          setPhase("thinking");
          void respond(queued).catch(fail);
          return;
        }
        askTyped.current = (text) => {
          rec.onstop = null;
          if (rec.state === "recording") rec.stop();
          stream.getTracks().forEach(track => track.stop());
          clearTimeout(timeout.current);
          setPhase("thinking");
          void respond(text).catch(fail);
        };
        rec.start();
        setPhase("listening");
        timeout.current = setTimeout(() => {
          if (rec.state === "recording") rec.stop();
        }, 60000);
        return;
      }
      const pc = new RTCPeerConnection();
      peer.current = pc;
      pc.ontrack = (e) => {
        if (token !== generation.current) return;
        const playback = new MediaStream([e.track]);
        output.current!.srcObject = playback;
        const meter = audioContext.createAnalyser();
        meter.fftSize = 512;
        audioContext.createMediaStreamSource(playback).connect(meter);
        playbackAnalyser.current = meter;
        void output.current!.play().catch(() => setPlayBlocked(true));
      };
      if (typed) pc.addTransceiver("audio", { direction: "recvonly" });
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      const dc = pc.createDataChannel("oai-events");
      channel.current = dc;
      const transcript = new NovaTranscript();
      let answerRevision = 0;
      completedResult.current = undefined;
      const delegated = new Set<string>();
      const delegationByAnchor = new Map<string, string>();
      interruptCurrent.current = () => {
        ++answerRevision;
        ++actionRevision.current;
        setActionBusy(false);
        completedResult.current = undefined;
        pendingAnswers = 0;
        delegationTimers.current.forEach(clearTimeout);
        delegationTimers.current.clear();
        delegationByAnchor.clear();
        setPendingAction(undefined);
        endActivities("stopped");
        if (output.current) output.current.muted = true;
        if (dc.readyState === "open") dc.send(JSON.stringify({ type: "session.instructions.append", delegation_id: null,
          content: "Stop speaking immediately. The current investigation and any unapproved action were cancelled. Do not resume the old answer. Wait for a new user request." }));
        void api.nova({ action: "interrupt", sessionId: sessionId.current }).catch(error => setError(String(error)));
        setPhase("listening");
      };
      let actionFallback: (() => void) | undefined;
      let lastInputAt = 0;
      const runRequest = (id: string | null, offsetMs?: number, actionsOnly = false, anchor?: string) => {
        if (token !== generation.current || dc.readyState !== "open") return;
        const preview = transcript.capture(offsetMs, false, anchor);
        const actionRequest = preview && (novaActionIntent(preview.text) || novaConnectorQuestion(preview.text));
        const audienceReply = preview && novaAudienceReply(preview.text);
        if (audienceReply !== undefined) {
          transcript.capture(offsetMs, true, anchor);
          if (audienceReply && !hasNovaAudienceGreeting(preview?.responseText ?? '')) {
            if (output.current) output.current.muted = false;
            dc.send(JSON.stringify({ type: "session.instructions.append", delegation_id: id,
              content: "For this conversational turn only, greet the audience aloud using the greeting that follows naturally. This is conversation, not an agent run or connector message. Later task requests still use normal delegation." }));
            for (const content of novaCommentaryChunks(audienceReply)) dc.send(JSON.stringify({ type: "session.commentary.append", delegation_id: id, content }));
          }
          return;
        }
        if (preview?.text && isNovaIntroduction(preview.text)) {
          transcript.capture(offsetMs, true, anchor);
          // A successful conversational reply needs no second answer from the fallback.
          const alreadyAnswered = /\b(?:i'm nova|i am nova|i can|help you|assistant)\b/i.test(preview.responseText ?? "") && !/\b(?:checking|looking (?:that|it) up|one moment)\b/i.test(preview.responseText ?? "");
          if (!alreadyAnswered) {
            if (output.current) output.current.muted = false;
            dc.send(JSON.stringify({ type: "session.instructions.append", delegation_id: id,
              content: "For this conversational turn only, answer the user's introduction or general help question directly using the product description that follows. No lookup is needed; do not say checking or start a task. Later task requests still use normal delegation." }));
            for (const content of novaCommentaryChunks(state.activeTenantId ? NOVA_INTRODUCTION : NOVA_PUBLIC_INTRODUCTION)) dc.send(JSON.stringify({ type: "session.commentary.append", delegation_id: id, content }));
          }
          return;
        }
        if (actionsOnly && (!preview?.text || (isNovaConversationOnly(preview.text) && !/^(?:still there|are you (?:still )?(?:there|working|checking)|any (?:update|news))[?.!\s]*$/i.test(preview.text)))) {
          // Consume settled small talk so it cannot prefix the next real command.
          if (preview?.text) transcript.capture(offsetMs, true, anchor);
          return;
        }
        const request = transcript.capture(offsetMs, true, anchor);
        const activityId = id || `action-${++itemSequence.current}`;
        if (!request?.text || isNovaConversationOnly(request.text)) {
          if (request?.text && /^(?:still there|are you (?:still )?(?:there|working|checking)|any (?:update|news))[?.!\s]*$/i.test(request.text) && !pendingAnswers && completedResult.current) {
            dc.send(JSON.stringify({ type: "session.instructions.append", delegation_id: id,
              content: "The investigation is complete. Answer the waiting question using the completed result that follows. Do not say you are still checking." }));
            for (const content of novaCommentaryChunks(completedResult.current)) dc.send(JSON.stringify({ type: "session.commentary.append", delegation_id: id, content }));
            return;
          }
          return;
        }
        const { text, history } = request;
        if (actionRequest) dc.send(JSON.stringify({ type: "session.instructions.append", delegation_id: id,
          content: "Wait for the app result before answering this request. Do not claim a send or agent run succeeded unless the result confirms it." }));
        deliver(id, activityId, text, history);
      };
      // One request to the app, with its result spoken through the live session.
      const deliver = (id: string | null, activityId: string, text: string, history: { role: "user" | "assistant"; text: string }[]) => {
        if (output.current) output.current.muted = false;
        ++actionRevision.current;
        setActionBusy(false);
        setPendingAction(undefined);
        setLinks([]);
        endActivities("replaced");
        completedResult.current = undefined;
        const revision = ++answerRevision;
        pendingAnswers = 1;
        setPhase("thinking");
        void (async () => {
          const answer = await api.nova({
            action: "answer",
            sessionId: sessionId.current,
            text,
            ...(history.length ? { history } : {}),
          }, event => {
            if (token !== generation.current || revision !== answerRevision || dc.readyState !== "open") return;
            recordActivity(activityId, event);
            // Activity labels are UI copy, not content for the voice model.
          });
          if (
            token !== generation.current ||
            revision !== answerRevision ||
            dc.readyState !== "open"
          )
            return;
          pendingAnswers = 0;
          if (answer.screenQuestion) {
            stop();
            setScreenQuestion(answer.screenQuestion);
            return;
          }
          setPendingAction(answer.pendingAction);
          setError(answer.answerError || "");
          setConversation(answer.conversationId);
          showAnswerLinks(answer);
          const result =
            answer.text || "No answer available. Open Chat for details.";
          completedResult.current = result;
          recordActivity(activityId, { kind: "answer", status: answer.answerError ? "failed" : "completed", message: answer.answerError || (answer.pendingAction ? "Awaiting your review" : "Answer ready") }, answer.displayText || result);
          setPhase("listening");
          for (const chunk of novaCommentaryChunks(result))
            dc.send(
              JSON.stringify({
                type: "session.commentary.append",
                delegation_id: id,
                content: chunk,
              }),
            );
        })().catch((error) => {
          if (revision === answerRevision) fail(error);
        });
      };
      askTyped.current = (text: string) => {
        if (token !== generation.current || dc.readyState !== "open") return;
        appendSpeech("user", text);
        dc.send(JSON.stringify({ type: "session.instructions.append", delegation_id: null,
          content: "The admin typed a request in the app. Wait for its result, then speak it. Do not start a second lookup." }));
        deliver(null, `typed-${++itemSequence.current}`, text, []);
      };
      const scheduleRequest = (id: string | null, anchor: string) => {
        if (id !== null) delegationByAnchor.set(anchor, id);
        const dispatch = () => {
          delegationTimers.current.delete(timer);
          if (token !== generation.current || dc.readyState !== "open") return;
          const request = transcript.capture(undefined, false, anchor);
          if (!request) return;
          sampleMicrophone();
          const remaining = novaInputWaitMs(request.text, Date.now() - lastInputAt, Date.now() - lastVoiceAt);
          if (remaining > 0) {
            timer = setTimeout(dispatch, remaining);
            delegationTimers.current.add(timer);
            return;
          }
          // The delegation offset selects the original turn, not its final word.
          const delegationId = delegationByAnchor.get(anchor) ?? null;
          runRequest(delegationId, undefined, delegationId === null, anchor);
          delegationByAnchor.delete(anchor);
        };
        let timer = setTimeout(dispatch, 650);
        delegationTimers.current.add(timer);
        return () => { clearTimeout(timer); delegationTimers.current.delete(timer); };
      };
      dc.onmessage = (e) => {
        if (token !== generation.current) return;
        try {
          const event = JSON.parse(e.data);
          if (event.type === "session.started") {
            liveReady.current = true;
            clearTimeout(timeout.current);
            setPhase("listening");
            const queued = typed || (queuedShortcut.current && `Run shortcut ${queuedShortcut.current}`);
            if (queued) {
              queuedShortcut.current = undefined;
              setShortcutNotice("");
              askTyped.current(queued);
            }
          } else if (
            event.type === "session.input_transcript.delta" ||
            event.type === "session.output_transcript.delta"
          ) {
            const role = event.type.includes("input_") ? "User" : "Nova";
            if (typeof event.delta !== "string") return;
            if (!transcript.append(event)) return;
            appendSpeech(role === "User" ? "user" : "assistant", event.delta, event.start_ms, event.end_ms);
            if (role === "User") {
              lastInputAt = Date.now();
              if (transcript.takeStopCommand()) {
                interruptCurrent.current();
                if (!transcript.capture(undefined, false)?.text) return;
              }
              actionFallback?.();
              // Every settled substantive request reaches the app even if Live never delegates it.
              // capture() consumes it once, so a later model delegation cannot duplicate it.
              const anchor = transcript.capture(undefined, false)?.anchor;
              if (anchor) actionFallback = scheduleRequest(null, anchor);
              if (output.current) output.current.muted = false;
              setError("");
              setPhase("listening");
            }
          } else if (
            event.type === "session.delegation.created" &&
            typeof event.delegation?.id === "string"
          ) {
            const id = event.delegation.id;
            if (delegated.has(id)) return;
            delegated.add(id);
            // Bind untimed delegations too: a delayed handoff must not take a newer turn.
            const anchor = transcript.capture(event.offset_ms, false)?.anchor;
            if (!anchor) return;
            scheduleRequest(id, anchor);
          } else if (event.type === "session.closed") stop();
          else if (event.type === "error")
            fail(
              new Error(
                "Nova reported a voice session error. Stop and reconnect; check your API access if it repeats.",
              ),
            );
        } catch (error) {
          fail(error);
        }
      };
      dc.onclose = () => {
        if (token === generation.current)
          fail(new Error("Voice connection closed. Start Nova again."));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed")
          fail(
            new Error("Voice connection failed. Check your network and retry."),
          );
      };
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== "complete")
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            pc.removeEventListener("icegatheringstatechange", changed);
            reject(
              new Error(
                "Audio connection timed out. Check network access and retry.",
              ),
            );
          }, 10000);
          const changed = () => {
            if (pc.iceGatheringState === "complete") {
              clearTimeout(timer);
              pc.removeEventListener("icegatheringstatechange", changed);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", changed);
          changed();
        });
      if (token !== generation.current) return;
      const result = await api.nova({
        action: "start",
        mode,
        tenantId: state.activeTenantId,
        consent,
        name,
        sdp: pc.localDescription?.sdp,
      });
      if (token !== generation.current) return;
      sessionId.current = result.sessionId!;
      setSessionNotice(result.notice ?? "");
      timeout.current = setTimeout(
        () => fail(new Error("Nova did not become ready. Stop and retry.")),
        20000,
      );
      await pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
    } catch (e) {
      fail(e);
    }
  }
  useEffect(() => { resetIdle.current(); }, [phase, muted]);
  const active = phase !== "idle";
  const localHandsFree = mode === "local" && preferences?.interaction === "hands-free" && !typedLocal;
  const microphoneStatus = microphoneLive && !muted && <span className="nova-mic-live" role="status">Microphone live</span>;
  const timingRow = preferences?.showTimings && timings && <p className="nova-timings">{timings}</p>;
  bubbleAction.current = (reason) => {
    if (reason === "nova-window-handoff") {
      stop();
      setError("Nova moved to the other window. Start it here to move it back.");
    } else if (bubble && reason === "nova-context-changed" && phaseRef.current !== "idle") {
      stop();
      setError(NOVA_SESSION_CONTEXT_CHANGED);
    } else if (bubble && reason === "nova-bubble-hidden") {
      setCallPanel(false);
      discardScreen();
      startRequested.current = false;
      stop();
    } else if (bubble && reason === "nova-bubble-toggle") {
      if (showCallPanel) return;
      if (holdMode && (phaseRef.current === "connecting" || recorder.current?.state === "recording")) {
        releaseTalk();
        return;
      }
      if (startRequested.current || phaseRef.current !== "idle") {
        startRequested.current = false;
        stop();
      } else {
        bubbleTalk.current?.focus();
        startRequested.current = true;
        setStartSignal(value => value + 1);
      }
    } else if (!bubble && reason === "nova-screen-draft") {
      void api?.novaWindow("take-screen-question").then(draft => {
        if (draft) {
          discardScreen();
          setOpen(false);
          navigate("/chat", { state: { screenQuestionDraft: draft } });
        }
      }).catch(error => setError(voiceErrorMessage(error)));
    } else if (!bubble && reason === "nova-open-main") {
      setOpen(true);
      toggleConversation(true);
      setTransferNotice("");
      void api?.novaWindow("take-conversation").then(setIncomingTransfer)
        .catch(() => setTransferNotice("Conversation could not carry over. Try opening it again from the bubble."));
    }
  };
  useEffect(() => {
    if (!incomingTransfer || loading) return;
    setIncomingTransfer(undefined);
    try {
      const moved = JSON.parse(incomingTransfer) as {
        notice?: string; clipped?: boolean; organizationId?: string; tenantId?: string;
        providerId?: string; model?: string; items: NovaConversationItem[]; conversation?: string;
      };
      if (moved.notice) { setTransferNotice(moved.notice); return; }
      if (moved.organizationId !== state.activeOrganizationId || moved.tenantId !== state.activeTenantId ||
        moved.providerId !== state.activeProviderId || moved.model !== reasoningModel) {
        setTransferNotice("Conversation could not carry over because the organization, provider or model changed.");
        return;
      }
      setConversationItems(moved.items.slice(-80).map(item => ({ ...item, id: `transferred-${item.id}` })));
      setConversation(moved.conversation);
      if (moved.clipped || moved.items.length > 80) setTransferNotice("Showing the last 80 conversation items.");
    } catch {
      setTransferNotice("Conversation could not carry over. Try opening it again from the bubble.");
    }
  }, [incomingTransfer, loading, reasoningModel, state.activeOrganizationId, state.activeProviderId, state.activeTenantId]);
  const startFromShortcut = useRef(start);
  startFromShortcut.current = start;
  useEffect(() => {
    if (loading || !startRequested.current) return;
    startRequested.current = false;
    void startFromShortcut.current();
  }, [loading, startSignal]);
  const microphoneHelp = api?.platform === "macos" && error.startsWith("Microphone access was denied.") ? (
    <Button size="sm" onClick={() => void api?.novaWindow("microphone-settings").catch(error => setError(voiceErrorMessage(error)))}>
      Open Microphone Settings
    </Button>
  ) : null;
  requestShortcut.current = (shortcut: string) => {
    setShortcutNotice("");
    if (!active) {
      queuedShortcut.current = shortcut;
      setShortcutNotice(`Start Nova to run ${shortcut}. Nothing runs until you start a session.`);
      return;
    }
    if (mode === "local") {
      setError(`Local voice is listening. Say run ${shortcut}, or stop Nova and pick the shortcut again.`);
      return;
    }
    askTyped.current(`Run shortcut ${shortcut}`);
  };
  useEffect(() => {
    onHostedChange?.(active && mode === "openai");
    return () => onHostedChange?.(false);
  }, [active, mode, onHostedChange]);
  useEffect(() => {
    if (!open || !expanded) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const siblings = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== root.current,
    );
    const previousInert = siblings.map((element) => element.inert);
    siblings.forEach((element) => {
      element.inert = true;
    });
    panel.current?.focus();
    revealControls();
    return () => {
      clearTimeout(controlsTimer.current);
      siblings.forEach((element, index) => {
        element.inert = previousInert[index];
      });
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open, expanded, revealControls]);
  useEffect(() => {
    if (expanded && active) revealControls();
  }, [expanded, active, revealControls]);
  useEffect(() => {
    const speed =
      phase === "speaking"
        ? 2.2
        : phase === "listening"
          ? 1.4
          : phase === "thinking"
            ? 0.75
            : 1;
    // Changing playback rate preserves the current angle; changing CSS duration jumps.
    for (const layer of orb.current?.querySelectorAll(
      ".nova-orb-current, .nova-orb-undercurrent",
    ) || []) {
      for (const animation of layer.getAnimations?.() || [])
        animation.updatePlaybackRate(speed);
    }
  }, [open, phase]);
  const showCaptions = captions;
  const quiet =
    expanded &&
    active &&
    !controlsVisible &&
    !error &&
    !muted &&
    !playBlocked &&
    phase !== "connecting" &&
    !(mode === "local" && phase === "listening");
  const toggleMute = () => {
    const next = !mutedRef.current;
    mic.current?.getAudioTracks().forEach(track => { track.enabled = !next; });
    mutedRef.current = next;
    setMuted(next);
  };
  if (bubble) {
    const result = conversationItems.filter(item => item.kind === "activity" && item.result).at(-1);
    const activity = conversationItems.filter(item => item.kind === "activity").at(-1);
    const activityText = activity?.kind === "activity" &&
      (activity.status === "running" || activity.status === "completed" || activity.status === "failed")
      ? activity.steps.at(-1)?.message : undefined;
    const spoken = conversationItems.filter(item => item.kind === "speech" && item.role === "assistant").at(-1);
    const answer = (result?.kind === "activity" ? result.result : undefined) || (spoken?.kind === "speech" ? spoken.text : "");
    const organization = state.organizations?.find(item => item.id === state.activeOrganizationId)?.name
      || state.tenants.find(item => item.id === state.activeTenantId)?.displayName || "No organization";
    const windowAction = (action: "hide" | "open-main" | "open-page", route?: string) => {
      const transcript = action === "open-main" && conversationItems.length ? JSON.stringify({
        organizationId: state.activeOrganizationId,
        tenantId: state.activeTenantId,
        providerId: state.activeProviderId,
        model: reasoningModel,
        clipped: historyClipped.current,
        items: conversationItems.slice(-80).map(item => item.kind === "activity" && item.status === "running"
          ? { ...item, status: "stopped" } : item),
        conversation,
      }) : undefined;
      void api?.novaWindow(action, route ?? transcript).catch(error => setError(voiceErrorMessage(error)));
    };
    return (
      <section ref={bubbleRoot} className="nova-bubble" data-screen-preview={screenResult?.status === "preview"} aria-label="Nova" role="dialog" aria-modal="true" tabIndex={-1}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); windowAction("hide"); }
          if (event.key !== "Tab") return;
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']"));
          const target = event.shiftKey ? controls[0] : controls.at(-1);
          if (document.activeElement === target) {
            event.preventDefault();
            (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
          }
        }}>
        <header className="nova-bubble-header">
          <strong>Nova</strong>
          <Button size="sm" variant="ghost" onClick={() => windowAction("hide")}>Close</Button>
        </header>
        <div className="nova-bubble-context">
          <div>{organization}</div>
          <div id={bubbleTrustId}>{showCallPanel ? "On this device" : trustDisclosure}</div>
        </div>
        {showCallPanel ? <NovaCallAssist close={() => {
          setCallPanel(false);
          requestAnimationFrame(() => bubbleRoot.current?.querySelector<HTMLButtonElement>("[data-call-start]")?.focus());
        }} /> : screenResult?.status === "preview" ? screenControls : <>
        <div className="nova-bubble-voice">
          <span ref={element => { orb.current = element; }} className="nova-orb" data-phase={error ? "error" : muted ? "muted" : phase} aria-hidden="true">
            <span className="nova-orb-core"><NovaOrbArtwork /></span>
            <span className="nova-orb-ring" />
          </span>
          <div className="nova-bubble-voice-controls">
            <div role="status">{error ? error.startsWith("Microphone access was denied.") ? "Microphone denied" : "Needs attention"
              : muted ? "Microphone muted" : phase === "idle" ? "Ready" : phase === "connecting" ? "Connecting"
              : phase === "listening" ? "Listening" : phase === "thinking" ? "Working on an answer" : "Speaking"}</div>
            <div className="nova-bubble-actions">
              <button type="button" className="nova-bubble-talk" ref={bubbleTalk} autoFocus disabled={!active && waitingForLocalSpeech} {...talkPress} onClick={event => { if (holdMode && event.detail !== 0) return; if (active && holdMode && phase === "listening") releaseTalk(); else if (active) stop(); else void start(); }}>
                {active ? holdMode && phase === "listening" ? "Release to send" : "Stop" : holdMode ? "Hold to talk" : "Talk"}
              </button>
              {state.novaRegisteredShortcut && <kbd>{novaKeyLabel(state.novaRegisteredShortcut)}</kbd>}
              {active && phase !== "connecting" && (mode === "openai" || phase === "listening") &&
                <Button size="sm" variant="ghost" aria-pressed={muted} onClick={toggleMute}>{muted ? "Unmute" : "Mute"}</Button>}
              {mode === "local" && phase === "listening" && recorder.current?.state === "recording" &&
                <Button size="sm" variant="secondary" onClick={() => recorder.current?.stop()}>Finish speaking</Button>}
            </div>
          </div>
        </div>
        {microphoneStatus}
        {timingRow}
        {error && <div className="nova-bubble-error" role="alert">{error} {microphoneHelp}</div>}
        {!active && mode === "openai" && hasKey &&
          <label className="nova-bubble-consent">
            <input ref={bubbleConsent} aria-describedby={bubbleTrustId} type="checkbox" checked={consent} onChange={event => {
              setConsent(event.target.checked);
              setError("");
            }} /> Allow hosted processing for this session
          </label>}
        {sessionNotice && <div role="status">{sessionNotice}</div>}
        {activityText && <div className="nova-bubble-activity" role="status">{activityText}</div>}
        {answer && <div className="nova-bubble-answer" role="region" aria-label="Latest answer" tabIndex={0}>
          <MarkdownPreview source={answer} numberedSections={false} className="nova-markdown" />
        </div>}
        {links.length > 0 && <div className="nova-bubble-actions" aria-label="Pages in this answer">
          {links.map(link => <Button key={link.route} size="sm" variant="secondary" onClick={() => windowAction("open-page", link.route)}>{novaBubbleLinkLabel(link)}</Button>)}
        </div>}
        {pendingAction && <div>Review this request in OpenAdminOS. Start a new session there to prepare the action for approval.</div>}
        {mode === "local" && allowedModes.includes("local") && !active && <LocalSpeechSetup onChange={setLocalSpeech} openSettings={() => windowAction("open-page", "/settings/nova")} />}
        {deviceVoice && <p role="status">{deviceVoice}</p>}
        <footer className="nova-bubble-footer">
          <form className="nova-bubble-question" onSubmit={event => {
            event.preventDefault();
            const text = question.trim();
            if (!text) return;
            if (novaScreenQuestion(text)) {
              setQuestion("");
              discardScreen();
              setScreenQuestion(text);
              setScreenError("");
              return;
            }
            if (!active && (!reasoningReady || voiceOff || (mode === "openai" && (!hasKey || !consent)))) {
              void start(text);
              return;
            }
            setQuestion("");
            if (novaScreenQuestion(text)) { discardScreen(); setScreenQuestion(text); }
            else if (active) askTyped.current(text);
            else void start(text);
          }}>
            <input aria-label="Ask Nova" placeholder="Ask Nova" value={question} maxLength={12000} onChange={event => setQuestion(event.target.value)} />
            <Button size="sm" type="submit" disabled={!question.trim() || active && (phase !== "listening" || mode === "local" && !localHandsFree && recorder.current?.state !== "recording")}>Ask</Button>
          </form>
          {screenControls}
          {callAssistEnabled && !active && <Button data-call-start size="sm" variant="secondary" onClick={() => {
            stop();
            discardScreen();
            setCallPanel(true);
          }}>Start call assist</Button>}
          <Button size="sm" variant="secondary" onClick={() => windowAction("open-main")}>Open in OpenAdminOS</Button>
        </footer>
        </>}
        <audio ref={output} autoPlay />
      </section>
    );
  }
  return createPortal(
    <div
      ref={root}
      className={`nova-root${open && expanded ? " nova-root-fullscreen" : ""}`}
    >
      {open && (
        <section
          id="nova-panel"
          ref={panel}
          tabIndex={-1}
          role={expanded ? "dialog" : "region"}
          aria-modal={expanded || undefined}
          data-active={active}
          data-quiet={quiet}
          data-conversation={showCaptions}
          data-action-review={Boolean(pendingAction)}
          onPointerMove={expanded ? revealControls : undefined}
          onPointerDown={expanded ? revealControls : undefined}
          onKeyDown={(event) => {
            if (!expanded) return;
            revealControls();
            if (event.key !== "Tab") return;
            const controls = Array.from(
              panel.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
              ) || [],
            ).filter((element) => element.getClientRects().length > 0);
            const first = controls[0],
              last = controls.at(-1);
            if (!first) {
              event.preventDefault();
              return;
            }
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === panel.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last ||
                document.activeElement === panel.current)
            ) {
              event.preventDefault();
              first.focus();
            }
          }}
          className={`nova-panel${expanded ? " nova-panel-expanded" : ""}`}
          aria-label="Nova voice assistant"
        >
          <div className="nova-header flex items-center justify-between">
            <strong>
              Nova <span className="nova-eyebrow">Voice</span>
            </strong>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={expanded}
              onClick={() => {
                setExpanded(!expanded);
                revealControls();
              }}
            >
              {expanded ? "Exit full screen" : "Full screen"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                stop();
                queuedShortcut.current = undefined;
                setShortcutNotice("");
                discardScreen();
                setOpen(false);
              }}
            >
              Close
            </Button>
          </div>
          <p className="nova-tenant text-xs text-[var(--color-text-muted)]" data-no-organization={!state.activeTenantId}>
            {state.tenants.find((t) => t.id === state.activeTenantId)
              ?.displayName || "No organization"}{" "}
            · {location.pathname.split("/")[1] || "Chat"}
          </p>
          <p className="nova-trust text-xs text-[var(--color-accent)]">
            {trustDisclosure}
          </p>
          {!active && (
            <>
              {voiceOff ? (
                <p role="status" className="text-xs">Nova voice is turned off by your IT department. Chat still answers.</p>
              ) : (
              <label className="nova-field">
                Voice provider
                <select
                  value={mode}
                  disabled={savingKey || profile?.locked.voiceMode}
                  onChange={(e) => {
                    const next = e.target.value as "local" | "openai";
                    stop();
                    setModeOverride(next);
                    setConnectionCheck("");
                    setConsent(false);
                    setError("");
                    void saveProfile({ action: "save", patch: { voiceMode: next } }).then((saved) => { if (!saved) setModeOverride(undefined); });
                  }}
                >
                  {allowedModes.includes("openai") && <option value="openai">OpenAI · GPT-Live-1</option>}
                  {allowedModes.includes("local") && <option value="local">Local (on this device)</option>}
                </select>
              </label>
              )}
              <div className="nova-readiness">
                <p>
                  <strong>{state.activeTenantId ? "Tenant reasoning" : "Reasoning provider"}</strong> ·{" "}
                  {reasoning?.name || "Not selected"}
                  {reasoningModel ? ` · ${reasoningModel}` : ""}
                </p>
                <p>
                  {reasoningReady
                    ? state.activeTenantId ? "Ready to retrieve permitted tenant data." : "Ready to answer public Microsoft product questions."
                    : "Connect a reasoning provider in Settings before starting voice."}
                </p>
                {mode === "openai" && <p>The voice key powers speech. Tenant answers use the reasoning provider above.</p>}
                {!reasoningReady && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setExpanded(false);
                      navigate("/settings");
                    }}
                  >
                    Configure reasoning
                  </Button>
                )}
              </div>
            </>
          )}
          {screenControls}
          <form className="nova-question grid gap-2" onSubmit={event => {
            event.preventDefault();
            const text = typedQuestion.trim();
            if (!text) return;
            setTypedQuestion("");
            if (active) askTyped.current(text);
            else void start(text);
          }}>
            <label className="nova-field">
              Type a question
              <input value={typedQuestion} maxLength={12000} onChange={event => setTypedQuestion(event.target.value)} />
            </label>
            <Button type="submit" disabled={!typedQuestion.trim() || (!novaScreenQuestion(typedQuestion) &&
              (active ? localHandsFree ? phase !== "listening" : mode !== "openai" || !liveReady.current : (!reasoningReady || !reasoning?.isLocal || !allowedModes.includes("local"))))}>Ask Nova</Button>
            {deviceVoice && <p role="status">{deviceVoice}</p>}
          </form>
          {mode === "local" && allowedModes.includes("local") && !active && <LocalSpeechSetup onChange={setLocalSpeech} />}
          {holdMode && <Button {...talkPress} disabled={!reasoningReady || waitingForLocalSpeech} onClick={event => {
            if (event.detail !== 0) return;
            if (active) releaseTalk();
            else void start();
          }}>{phase === "listening" ? "Release to send" : "Hold to talk"}</Button>}
          <button
            hidden={!active && (waitingForLocalSpeech || holdMode)}
            ref={element => { orb.current = element; }}
            className="nova-orb"
            data-phase={
              error ? "error" : muted && phase === "listening" ? "muted" : phase
            }
            onClick={() => (active ? stop() : void start())}
            disabled={
              !active &&
              (!reasoningReady ||
                voiceOff ||
                checking ||
                savingKey ||
                waitingForLocalSpeech ||
                (mode === "openai" && (!hasKey || !consent)))
            }
            aria-label={active ? "Stop Nova" : "Start Nova"}
          >
            <span className="nova-orb-core" aria-hidden="true">
              <NovaOrbArtwork />
            </span>
            <span className="nova-orb-ring" aria-hidden="true" />
          </button>
          <div role="status" className="nova-status text-center text-sm">
            {phase === "idle"
              ? waitingForLocalSpeech ? "Download the models to start a voice conversation." : "Start a conversation. Say “Hey Nova”."
              : phase === "connecting"
                ? "Checking setup and connecting microphone…"
                : phase === "listening"
                  ? muted
                    ? "Microphone muted"
                    : "Listening"
                  : phase === "thinking"
                    ? "Working on your question…"
                    : "Nova is speaking"}
          </div>
          {microphoneStatus}
          {timingRow}
          {active && (
            <div className="nova-session-controls flex justify-center gap-2">
              {!typedLocal && <Button
                variant="secondary"
                disabled={
                  phase === "connecting" ||
                  (mode === "local" && !localHandsFree && phase !== "listening")
                }
                aria-pressed={muted}
                onClick={toggleMute}
              >
                {muted ? "Unmute mic" : "Mute mic"}
              </Button>}
              {(mode === "openai" || (localHandsFree && (phase === "thinking" || phase === "speaking"))) && <Button variant="secondary" onClick={() => interruptCurrent.current()}>Stop answer</Button>}

              <Button variant="secondary" onClick={stop}>
                Stop
              </Button>
              {mode === "local" && !localHandsFree && !typedLocal && phase === "listening" && (
                <Button onClick={() => recorder.current?.stop()}>
                  Finish speaking
                </Button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-300">
              {error}
            </p>
          )}
          <div className="nova-tools">
            <button
              ref={conversationToggle}
              type="button"
              className="nova-conversation-toggle"
              aria-label={showCaptions ? "Hide conversation panel" : "Show conversation panel"}
              aria-pressed={showCaptions}
              aria-controls="nova-conversation"
              onClick={() => toggleConversation(!showCaptions)}
            >
              <ConversationIcon /> Conversation
            </button>
            {!active && (
              <button
                type="button"
                aria-expanded={settings || (mode === "openai" && !hasKey)}
                aria-controls="nova-settings"
                onClick={() => setSettings(!settings)}
              >
                Voice settings
              </button>
            )}
            {state.activeTenantId && state.novaFollowUpsPending ? (
              <button
                type="button"
                className="nova-followups-pending"
                onClick={() => { setExpanded(false); navigate("/settings/nova"); }}
              >
                {state.novaFollowUpsPending === 1 ? "1 follow-up pending" : `${state.novaFollowUpsPending} follow-ups pending`}
              </button>
            ) : null}
          </div>
          {showCaptions && <NovaConversation items={conversationItems} onClose={() => toggleConversation(false)}
            onEvidence={conversation ? () => { setExpanded(false); navigate(`/chat/${conversation}`); } : undefined} />}
          {pendingAction && <section className="nova-action-review" aria-label="Review Nova action">
            <h2>{pendingAction.title}</h2><p><strong>{NOVA_ACTION_TARGET_LABEL[pendingAction.kind]}:</strong> {pendingAction.target}</p>
            <p>{NOVA_ACTION_EXPLANATION[pendingAction.kind]}</p>
            {pendingAction.deliveryNote && <p>{pendingAction.deliveryNote}</p>}
            {pendingAction.kind === "profile" ? <>
              <p><strong>Now</strong></p>
              <pre className="nova-action-body" aria-label="Current value">{pendingAction.previousBody ?? "None"}</pre>
              <p><strong>After the change</strong></p>
              <pre className="nova-action-body" aria-label="New value">{pendingAction.body}</pre>
            </> : pendingAction.kind === "remember" || pendingAction.kind === "follow-up"
              ? <pre className="nova-action-body" aria-label={pendingAction.kind === "remember" ? "Note" : "Question"}>{pendingAction.body}</pre>
              : <MarkdownPreview source={pendingAction.body} numberedSections={false} className="nova-action-body nova-markdown" />}
            <div><Button disabled={actionBusy} onClick={() => void decideAction(true)}>{actionBusy ? "Submitting…" : NOVA_ACTION_CONFIRM[pendingAction.kind]}</Button>
            <Button variant="secondary" disabled={actionBusy} onClick={() => void decideAction(false)}>Cancel</Button></div>
          </section>}
          <audio ref={output} hidden />
          {playBlocked && (
            <Button
              className="nova-playback-recovery"
              onClick={() =>
                void output.current
                  ?.play()
                  .then(() => setPlayBlocked(false))
                  .catch(() =>
                    setError(
                      "Audio playback is blocked. Check the app’s audio permissions and try again.",
                    ),
                  )
              }
            >
              Play Nova audio
            </Button>
          )}
          {conversation && (
            <Button
              className="nova-evidence"
              variant="secondary"
              onClick={() => {
                setExpanded(false);
                navigate(`/chat/${conversation}`);
              }}
            >
              Open evidence in Chat
            </Button>
          )}
          {links.length > 0 && (
            <div className={`nova-links flex flex-wrap justify-center gap-2${state.activeTenantId ? "" : " rounded-lg border border-[var(--color-border-soft)] p-3"}`} aria-label="Pages in this answer">
              {links.some(link => link.label === NOVA_INSTALL_DOCUMENTATION) && (
                <p className="w-full text-center text-xs">The local documentation index is missing.</p>
              )}
              {links.some(link => link.label === NOVA_CHECK_DOCUMENTATION) && (
                <p className="w-full text-center text-xs">Nova could not search the local documentation index.</p>
              )}
              {links.map((link) => (
                <Button key={link.route} size="sm" variant="secondary" onClick={() => { setExpanded(false); navigate(link.route); }}>
                  {link.label}
                </Button>
              ))}
            </div>
          )}
          {shortcutNotice && <p role="status" className="text-xs text-center">{shortcutNotice}</p>}
          {transferNotice && <p role="status" className="text-xs text-center">{transferNotice}</p>}
          {sessionNotice && <p role="status" className="text-xs text-center">{sessionNotice}</p>}
          {migrationError && (
            <div role="alert" className="text-xs text-center">
              <p>{migrationError}</p>
              <Button size="sm" variant="secondary" onClick={() => { setMigrationError(""); setMigrationAttempt((value) => value + 1); }}>Try again</Button>
            </div>
          )}
          {!active && (
            <div className="nova-readiness">
              {state.activeTenantId ? (
                <>
                  <p>
                    <strong>Tenant data</strong> ·{" "}
                    {cacheStatus?.resources?.some((r) => r.refreshedAt)
                      ? "Saved snapshots available"
                      : "Retrieved when you ask"}
                  </p>
                  <p>
                    Nova fetches missing or stale data for your question. Preloading
                    is optional and keeps large collections on this device.
                  </p>
                </>
              ) : (
                <p>Ask about Microsoft features and how to use them. Notes and follow-ups need a connected organization.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={checking || savingKey}
                  onClick={() => void checkSetup()}
                >
                  {checking ? "Checking…" : "Check voice setup"}
                </Button>
                {state.activeTenantId && <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setExpanded(false);
                    navigate("/settings/data");
                  }}
                >
                  Review cache
                </Button>}
              </div>
              {connectionCheck && <p role="status">{connectionCheck}</p>}
            </div>
          )}
          {!active && mode === "openai" && hasKey && (
            <label className="text-xs">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />{" "}
              {consentDisclosure}
            </label>
          )}
          {!active && (settings || (mode === "openai" && !hasKey)) && (
            <div id="nova-settings" className="nova-settings">
              <label className="nova-field">
                Greeting name
                <input
                  value={nameDraft ?? name}
                  maxLength={40}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => {
                    if (nameDraft === undefined || nameDraft.trim() === name) { setNameDraft(undefined); return; }
                    void saveProfile({ action: "save", patch: { greetingName: nameDraft } }).then(() => setNameDraft(undefined));
                  }}
                />
              </label>
              {mode === "openai" ? (
                <>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {state.activeTenantId ? "Audio, shared tenant answers and public research queries go to OpenAI. Nova can choose web search when it needs current information." : publicHostedDisclosure} Agent
                    reasoning uses{" "}
                    {
                      state.providers.find(
                        (p) => p.id === state.activeProviderId,
                      )?.name
                    }
                    . Voice and web search incur API charges separately from CLI subscriptions.
                  </p>
                  <label className="nova-field">
                    OpenAI API key {hasKey ? "· saved securely" : ""}
                    <input
                      type="password"
                      autoComplete="off"
                      value={key}
                      placeholder={
                        hasKey ? "Replace saved key" : "Enter API key"
                      }
                      onChange={(e) => setKey(e.target.value)}
                    />
                  </label>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={!key.trim() || savingKey || checking}
                      onClick={() => void configureKey(key)}
                    >
                      Save key
                    </Button>
                    {hasKey && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={savingKey || checking}
                        onClick={() => void configureKey(null)}
                      >
                        Remove key
                      </Button>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Local voice needs three components: a reasoning model, speech
                  recognition and speech output. Run whisper-server at
                  127.0.0.1:8080 and Kokoro-FastAPI at 127.0.0.1:8880, with
                  models downloaded. Select a local agent provider such as
                  Ollama. Click Finish speaking to submit. No cloud fallback.
                  Maximum recording: one minute.
                </p>
              )}
              <p className="text-xs text-[var(--color-text-muted)]">
                The microphone starts when you select Talk or press the system shortcut. “Hey Nova” works during an
                active conversation; background wake-word detection is not
                enabled. Writes require visual review.
              </p>
            </div>
          )}
          {microphoneHelp}
          <p className="nova-footnote">
            {active
              ? "Esc ends the session and releases your microphone."
              : "Click the orb to begin. Your microphone stays off until then."}
          </p>
        </section>
      )}
    </div>,
    document.body,
  );
}

function novaBubbleLinkLabel(link: NovaAnswerLink): string {
  const pages: Record<string, string> = {
    "/connections": "Connections", "/chat": "Chat", "/agents": "Agents", "/office": "Agent Team",
    "/changes": "Changes", "/settings": "Settings", "/settings/data": "Data settings",
    [NOVA_DOCUMENTATION_SETTINGS]: "documentation settings",
  };
  const page = pages[link.route] ?? (link.route.startsWith("/runs/") ? "run" : link.label || "page");
  return `Open ${page} in OpenAdminOS`;
}

function voiceErrorMessage(error: unknown): string {
  const name =
    error && typeof error === "object" && "name" in error
      ? error.name
      : undefined;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access was denied. Allow OpenAdminOS in your system microphone privacy settings, then start Nova again.";
  if (name === "NotFoundError")
    return "No microphone is available. Connect an input device and start Nova again.";
  if (name === "NotReadableError")
    return "The microphone could not be opened. Check whether another app is using it and retry.";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method ['"][^'"]+['"]: (?:Error: )?/, "");
}

/** Resolution-independent ribbons: audio scales the shell, CSS moves the interior. */
function NovaOrbArtwork() {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      className="nova-orb-art"
      viewBox="0 0 200 200"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={`${id}-body`} cx="32%" cy="18%" r="85%">
          <stop offset="0" stopColor="#f4f5f7" />
          <stop offset="0.33" stopColor="#dce0e6" />
          <stop offset="0.62" stopColor="#8a94a3" />
          <stop offset="0.86" stopColor="#3b434e" />
          <stop offset="1" stopColor="#17191d" />
        </radialGradient>
        <linearGradient id={`${id}-silk`} x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.36" stopColor="#e4e7ec" />
          <stop offset="0.57" stopColor="#a8b0bb" />
          <stop offset="0.78" stopColor="#626a75" />
          <stop offset="1" stopColor="#292d34" />
        </linearGradient>
        <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="0.5" stopColor="#c2c7ce" stopOpacity="0.5" />
          <stop offset="1" stopColor="#a8b0bb" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}-glass`} cx="35%" cy="12%" r="88%">
          <stop offset="0" stopColor="#f4f5f7" stopOpacity="0.6" />
          <stop offset="0.28" stopColor="#f4f5f7" stopOpacity="0" />
          <stop offset="0.78" stopColor="#121418" stopOpacity="0" />
          <stop offset="1" stopColor="#121418" stopOpacity="0.55" />
        </radialGradient>
        <radialGradient id={`${id}-specular`}>
          <stop offset="0" stopColor="#f4f5f7" stopOpacity="0.95" />
          <stop offset="0.55" stopColor="#f4f5f7" stopOpacity="0.35" />
          <stop offset="1" stopColor="#f4f5f7" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}-clip`}>
          <circle cx="100" cy="100" r="98" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <circle cx="100" cy="100" r="100" fill={`url(#${id}-body)`} />
        <g className="nova-orb-current">
          <path
            d="M-35 57 C30 -38 164 -4 172 48 C181 102 64 77 46 124 C25 181 161 160 227 116 L233 225 L-35 225Z"
            fill={`url(#${id}-silk)`}
          />
          <path
            d="M-35 57 C30 -38 164 -4 172 48 C181 102 64 77 46 124 C25 181 161 160 227 116"
            fill="none"
            stroke={`url(#${id}-edge)`}
            strokeWidth="1.4"
          />
        </g>
        <g className="nova-orb-undercurrent">
          <path
            d="M-25 96 C15 163 89 201 142 158 C192 117 90 113 116 66 C137 29 191 43 227 62 L220 -30 L-25 -30Z"
            fill={`url(#${id}-silk)`}
            opacity="0.8"
          />
          <path
            d="M-25 96 C15 163 89 201 142 158 C192 117 90 113 116 66 C137 29 191 43 227 62"
            fill="none"
            stroke={`url(#${id}-edge)`}
            strokeWidth="1"
          />
        </g>
        <circle cx="100" cy="100" r="98" fill={`url(#${id}-glass)`} />
        <ellipse
          className="nova-orb-glint"
          cx="78"
          cy="30"
          rx="43"
          ry="12"
          fill={`url(#${id}-specular)`}
          opacity="0.12"
          transform="rotate(-28 78 30)"
        />
      </g>
      <circle
        cx="100"
        cy="100"
        r="98"
        fill="none"
        stroke={`url(#${id}-edge)`}
        strokeWidth="0.7"
      />
    </svg>
  );
}
