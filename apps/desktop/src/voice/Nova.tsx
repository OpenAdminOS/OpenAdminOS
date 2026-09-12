import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { useAppState } from "../state";
import { Button } from "../components/Button";
import {
  resolveProviderDefaultModel,
  type GraphCacheStatus,
} from "@openadminos/agent-sdk";
import "./nova.css";

export function Nova({
  onHostedChange,
}: {
  onHostedChange?: (active: boolean) => void;
}) {
  const { state } = useAppState();
  const location = useLocation(),
    navigate = useNavigate();
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState<"openai" | "local">(() =>
      localStorage.getItem("nova.voice-mode") === "local" ? "local" : "openai",
    );
  const [name, setName] = useState(
    () => localStorage.getItem("nova.greeting-name") || "",
  );
  const [key, setKey] = useState(""),
    [hasKey, setHasKey] = useState(false),
    [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState("idle"),
    [error, setError] = useState(""),
    [caption, setCaption] = useState("");
  const [connectionCheck, setConnectionCheck] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const keyRevision = useRef(0);
  const liveReady = useRef(false);
  const currentPage = useRef(location.pathname);
  currentPage.current = location.pathname;
  const [checking, setChecking] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<GraphCacheStatus>();
  const reasoning = state.providers.find(
    (p) => p.id === state.activeProviderId,
  );
  const reasoningModel = resolveProviderDefaultModel(
    reasoning,
    state.activeModelByProviderId,
  ).model;
  const reasoningReady =
    reasoning?.status === "connected" &&
    (mode !== "local" || reasoning.isLocal);
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [focusCaptions, setFocusCaptions] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);
  const [captions, setCaptions] = useState(true);
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
    orb = useRef<HTMLButtonElement>(null),
    recorder = useRef<MediaRecorder | null>(null),
    sessionId = useRef("");
  const delegationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    blobUrl = useRef("");
  const api = window.openAdminOS;
  const stop = useCallback(() => {
    generation.current++;
    liveReady.current = false;
    setConsent(false);
    setKey("");
    clearTimeout(timeout.current);
    clearTimeout(delegationTimer.current);
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
      closingChannel.send(JSON.stringify({ type: "session.close" }));
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
      output.current.srcObject = null;
      output.current.removeAttribute("src");
    }
    URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = "";
    sessionId.current = "";
    orb.current?.style.setProperty("--voice-level", "0");
    void api?.nova({ action: "stop" }).catch(() => {});
    setPhase("idle");
  }, [api]);
  useEffect(() => {
    stop();
    setConsent(false);
    setConnectionCheck("");
    setCacheStatus(undefined);
    setConversation(undefined);
    setCaption("");
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
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === generation.current) setChecking(false);
    }
  }
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "KeyV") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") stop();
    };
    const hidden = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("keydown", keydown);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("keydown", keydown);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [stop]);
  useEffect(() => {
    if (liveReady.current && channel.current?.readyState === "open")
      channel.current.send(
        JSON.stringify({
          type: "session.thinking.append",
          delegation_id: null,
          content: `Current app page: ${location.pathname}. Navigation does not authorize tenant changes.`,
        }),
      );
  }, [location.pathname]);
  async function start() {
    if (!api || !state.activeTenantId) return;
    stop();
    const token = generation.current;
    setError("");
    setCaption("");
    setPhase("connecting");
    const fail = (e: unknown) => {
      if (generation.current === token) {
        stop();
        setError(voiceErrorMessage(e));
      }
    };
    try {
      await api.nova({ action: "check", mode, connectivity: false });
      if (token !== generation.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (token !== generation.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      mic.current = stream;
      const audioContext = new AudioContext();
      context.current = audioContext;
      await audioContext.resume();
      if (token !== generation.current) return;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const playbackSamples = new Uint8Array(512);
      let level = 0,
        lastPlayback = 0,
        pendingAnswers = 0;
      const rms = (values: Uint8Array) => {
        let sum = 0;
        for (const sample of values) sum += ((sample - 128) / 128) ** 2;
        return Math.min(1, Math.sqrt(sum / values.length) * 7);
      };
      const animate = () => {
        if (token !== generation.current) return;
        analyser.getByteTimeDomainData(samples);
        let outputLevel = 0;
        if (playbackAnalyser.current) {
          playbackAnalyser.current.getByteTimeDomainData(playbackSamples);
          outputLevel = rms(playbackSamples);
          if (outputLevel > 0.025 && !output.current?.paused) {
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
        const recorded: Blob[] = [];
        const rec = new MediaRecorder(stream);
        recorder.current = rec;
        rec.ondataavailable = (e) => {
          if (e.data.size) recorded.push(e.data);
        };
        rec.onstop = () => {
          void (async () => {
            if (token !== generation.current) return;
            clearTimeout(timeout.current);
            mic.current?.getTracks().forEach((t) => {
              t.onended = null;
              t.stop();
            });
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
            const pcm = resampled.getChannelData(0),
              wav = new ArrayBuffer(44 + pcm.length * 2),
              view = new DataView(wav);
            const text = (offset: number, value: string) => {
              for (let i = 0; i < value.length; i++)
                view.setUint8(offset + i, value.charCodeAt(i));
            };
            text(0, "RIFF");
            view.setUint32(4, wav.byteLength - 8, true);
            text(8, "WAVE");
            text(12, "fmt ");
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, 16000, true);
            view.setUint32(28, 16000 * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            text(36, "data");
            view.setUint32(40, pcm.length * 2, true);
            pcm.forEach((sample, i) =>
              view.setInt16(
                44 + i * 2,
                Math.max(-1, Math.min(1, sample)) * 32767,
                true,
              ),
            );
            const heard = await api.nova({
              action: "transcribe",
              sessionId: sessionId.current,
              audio: Array.from(new Uint8Array(wav)),
            });
            if (token !== generation.current) return;
            if (!heard.text?.trim())
              throw new Error(
                "No speech recognized. Try again closer to the microphone.",
              );
            setCaption(heard.text);
            const answer = await api.nova({
              action: "answer",
              sessionId: sessionId.current,
              text: heard.text,
            });
            if (token !== generation.current) return;
            setCaption(answer.text || "No answer returned.");
            setConversation(answer.conversationId);
            if (answer.route) {
              setExpanded(false);
              navigate(answer.route);
            }
            const speech = await api.nova({
              action: "speak",
              sessionId: sessionId.current,
              text: (answer.text || "").slice(0, 5000),
            });
            if (token !== generation.current) return;
            blobUrl.current = URL.createObjectURL(
              new Blob([new Uint8Array(speech.audio || [])], {
                type: "audio/wav",
              }),
            );
            output.current!.src = blobUrl.current;
            setPhase("speaking");
            output.current!.onerror = () =>
              fail(
                new Error(
                  "Local speech could not be played. Check Kokoro's WAV output and your audio device, then retry.",
                ),
              );
            output.current!.onended = () => {
              if (token === generation.current) stop();
            };
            await output.current!.play();
          })().catch(fail);
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
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      const dc = pc.createDataChannel("oai-events");
      channel.current = dc;
      let pendingUserText = "",
        answerRevision = 0,
        lastSpeaker = "";
      const delegated = new Set<string>();
      dc.onmessage = (e) => {
        if (token !== generation.current) return;
        try {
          const event = JSON.parse(e.data);
          if (event.type === "session.started") {
            liveReady.current = true;
            clearTimeout(timeout.current);
            setPhase("listening");
            dc.send(
              JSON.stringify({
                type: "session.thinking.append",
                delegation_id: null,
                content: `Current app page: ${currentPage.current}. No action is approved.`,
              }),
            );
          } else if (
            event.type === "session.input_transcript.delta" ||
            event.type === "session.output_transcript.delta"
          ) {
            const role = event.type.includes("input_") ? "User" : "Nova";
            if (typeof event.delta !== "string") return;
            const prefix = lastSpeaker !== role ? `\n${role}: ` : "";
            if (role === "User")
              pendingUserText = (pendingUserText + event.delta).slice(-12000);
            setCaption((current) =>
              (current + prefix + event.delta).slice(-3000),
            );
            lastSpeaker = role;
            if (role === "User") setPhase("listening");
          } else if (
            event.type === "session.delegation.created" &&
            typeof event.delegation?.id === "string"
          ) {
            const id = event.delegation.id;
            if (delegated.has(id)) return;
            delegated.add(id);
            clearTimeout(delegationTimer.current);
            // Delegation and transcript events can arrive in the same network burst.
            delegationTimer.current = setTimeout(() => {
              if (token !== generation.current || dc.readyState !== "open")
                return;
              const text = pendingUserText.trim();
              if (!text) {
                dc.send(
                  JSON.stringify({
                    type: "session.commentary.append",
                    delegation_id: id,
                    content: pendingAnswers
                      ? "The earlier question is still being checked."
                      : "Please repeat the question; I did not receive its transcript.",
                  }),
                );
                return;
              }
              pendingUserText = "";
              const revision = ++answerRevision;
              pendingAnswers = 1;
              setPhase("thinking");
              void (async () => {
                const answer = await api.nova({
                  action: "answer",
                  sessionId: sessionId.current,
                  text,
                });
                if (
                  token !== generation.current ||
                  revision !== answerRevision ||
                  dc.readyState !== "open"
                )
                  return;
                pendingAnswers = 0;
                setConversation(answer.conversationId);
                if (answer.route) {
                  setExpanded(false);
                  navigate(answer.route);
                }
                const result =
                  answer.text || "No answer available. Open Chat for details.";
                setCaption((current) =>
                  `${current}\nBackend: ${result}`.slice(-3000),
                );
                lastSpeaker = "";
                setPhase("listening");
                const characters = Array.from(result);
                for (let i = 0; i < characters.length; i += 100)
                  dc.send(
                    JSON.stringify({
                      type: "session.commentary.append",
                      delegation_id: id,
                      content: characters.slice(i, i + 100).join(""),
                    }),
                  );
              })().catch((error) => {
                if (revision === answerRevision) fail(error);
              });
            }, 250);
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
      timeout.current = setTimeout(
        () => fail(new Error("Nova did not become ready. Stop and retry.")),
        20000,
      );
      await pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
    } catch (e) {
      fail(e);
    }
  }
  const active = phase !== "idle";
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
      else
        root.current?.querySelector<HTMLButtonElement>(".nova-launch")?.focus();
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
  const showCaptions = expanded ? focusCaptions : captions;
  const quiet =
    expanded &&
    active &&
    !controlsVisible &&
    !error &&
    !muted &&
    !playBlocked &&
    phase !== "connecting" &&
    !(mode === "local" && phase === "listening");
  return createPortal(
    <div
      ref={root}
      className={`nova-root${open && expanded ? " nova-root-fullscreen" : ""}`}
    >
      <button
        className="nova-launch"
        onClick={() => {
          if (open) stop();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-controls="nova-panel"
      >
        <span className="nova-dot" />
        Talk to Nova <kbd>Alt V</kbd>
      </button>
      {open && (
        <section
          id="nova-panel"
          ref={panel}
          tabIndex={-1}
          role={expanded ? "dialog" : "region"}
          aria-modal={expanded || undefined}
          data-active={active}
          data-quiet={quiet}
          onPointerMove={expanded ? revealControls : undefined}
          onPointerDown={expanded ? revealControls : undefined}
          onKeyDown={(event) => {
            if (!expanded) return;
            revealControls();
            if (event.key !== "Tab") return;
            const controls = Array.from(
              panel.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
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
              Nova <span className="nova-eyebrow">VOICE</span>
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
                setOpen(false);
              }}
            >
              Close
            </Button>
          </div>
          <p className="nova-tenant text-xs text-[var(--color-text-muted)]">
            {state.tenants.find((t) => t.id === state.activeTenantId)
              ?.displayName || "No tenant selected"}{" "}
            · {location.pathname.split("/")[1] || "Chat"}
          </p>
          <p className="nova-trust text-xs text-[var(--color-accent)]">
            {mode === "openai"
              ? "Hosted voice · audio and shared context go to OpenAI"
              : "Local voice · audio stays on this device"}
          </p>
          {!active && (
            <>
              <label className="nova-field">
                Voice provider
                <select
                  value={mode}
                  disabled={savingKey}
                  onChange={(e) => {
                    stop();
                    setMode(e.target.value as "local" | "openai");
                    localStorage.setItem("nova.voice-mode", e.target.value);
                    setConnectionCheck("");
                    setConsent(false);
                    setError("");
                  }}
                >
                  <option value="openai">OpenAI · GPT-Live-1</option>
                  <option value="local">Local · whisper.cpp + Kokoro</option>
                </select>
              </label>
              <div className="nova-readiness">
                <p>
                  <strong>Tenant reasoning</strong> ·{" "}
                  {reasoning?.name || "Not selected"}
                  {reasoningModel ? ` · ${reasoningModel}` : ""}
                </p>
                <p>
                  {reasoningReady
                    ? "Ready to retrieve permitted tenant data."
                    : "Connect a reasoning provider in Settings before starting voice."}
                </p>
                <p>
                  {mode === "openai"
                    ? "The voice key powers speech. Tenant answers use the reasoning provider above."
                    : "Whisper recognizes speech and Kokoro speaks the answer. Tenant answers use the local reasoning provider above."}
                </p>
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
          <button
            ref={orb}
            className="nova-orb"
            data-phase={
              error ? "error" : muted && phase === "listening" ? "muted" : phase
            }
            onClick={() => (active ? stop() : void start())}
            disabled={
              !active &&
              (!reasoningReady ||
                checking ||
                savingKey ||
                !state.activeTenantId ||
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
              ? "Start a conversation. Say “Hey Nova”."
              : phase === "connecting"
                ? "Checking setup and connecting microphone…"
                : phase === "listening"
                  ? muted
                    ? "Microphone muted"
                    : "Listening"
                  : phase === "thinking"
                    ? "Checking tenant evidence…"
                    : "Nova is speaking"}
          </div>
          {active && (
            <div className="nova-session-controls flex justify-center gap-2">
              <Button
                variant="secondary"
                disabled={
                  phase === "connecting" ||
                  (mode === "local" && phase !== "listening")
                }
                aria-pressed={muted}
                onClick={() => {
                  const next = !mutedRef.current;
                  mic.current?.getAudioTracks().forEach((track) => {
                    track.enabled = !next;
                  });
                  mutedRef.current = next;
                  setMuted(next);
                }}
              >
                {muted ? "Unmute mic" : "Mute mic"}
              </Button>
              <Button variant="secondary" onClick={stop}>
                Stop
              </Button>
              {mode === "local" && phase === "listening" && (
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
              type="button"
              aria-pressed={showCaptions}
              onClick={() =>
                expanded
                  ? setFocusCaptions(!focusCaptions)
                  : setCaptions(!captions)
              }
            >
              Captions {showCaptions ? "on" : "off"}
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
          </div>
          {showCaptions && (
            <div className="nova-caption" aria-label="Conversation captions">
              {caption || "Your conversation will appear here."}
            </div>
          )}
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
          {!active && (
            <div className="nova-readiness">
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
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={checking || savingKey}
                  onClick={() => void checkSetup()}
                >
                  {checking ? "Checking…" : "Check voice setup"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setExpanded(false);
                    navigate("/cache");
                  }}
                >
                  Review cache
                </Button>
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
              Allow audio and relevant tenant context to the selected hosted
              providers for this session.
            </label>
          )}
          {!active && (settings || (mode === "openai" && !hasKey)) && (
            <div id="nova-settings" className="nova-settings">
              <label className="nova-field">
                Greeting name
                <input
                  value={name}
                  maxLength={40}
                  onChange={(e) => {
                    setName(e.target.value);
                    localStorage.setItem("nova.greeting-name", e.target.value);
                  }}
                />
              </label>
              {mode === "openai" ? (
                <>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Audio and shared tenant answers go to OpenAI. Agent
                    reasoning uses{" "}
                    {
                      state.providers.find(
                        (p) => p.id === state.activeProviderId,
                      )?.name
                    }
                    . API billing is separate from CLI subscriptions.
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
              <p className="text-[10px] text-[var(--color-text-muted)]">
                Microphone starts only when clicked. “Hey Nova” works during an
                active conversation; background wake-word detection is not
                enabled. Writes require visual review.
              </p>
            </div>
          )}
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
  return error instanceof Error ? error.message : String(error);
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
          <stop offset="0" stopColor="#fff9ee" />
          <stop offset="0.33" stopColor="#f2d1aa" />
          <stop offset="0.62" stopColor="#ba693e" />
          <stop offset="0.86" stopColor="#522718" />
          <stop offset="1" stopColor="#160f0d" />
        </radialGradient>
        <linearGradient id={`${id}-silk`} x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#fffef8" />
          <stop offset="0.36" stopColor="#ffe7ca" />
          <stop offset="0.57" stopColor="#d88955" />
          <stop offset="0.78" stopColor="#814226" />
          <stop offset="1" stopColor="#341b16" />
        </linearGradient>
        <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fffdf3" stopOpacity="0.95" />
          <stop offset="0.5" stopColor="#ffcc90" stopOpacity="0.5" />
          <stop offset="1" stopColor="#ffa26a" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}-glass`} cx="35%" cy="12%" r="88%">
          <stop offset="0" stopColor="#fffef7" stopOpacity="0.6" />
          <stop offset="0.28" stopColor="#fffef7" stopOpacity="0" />
          <stop offset="0.78" stopColor="#150b07" stopOpacity="0" />
          <stop offset="1" stopColor="#150b07" stopOpacity="0.55" />
        </radialGradient>
        <radialGradient id={`${id}-specular`}>
          <stop offset="0" stopColor="#fffef6" stopOpacity="0.95" />
          <stop offset="0.55" stopColor="#fffef6" stopOpacity="0.35" />
          <stop offset="1" stopColor="#fffef6" stopOpacity="0" />
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
