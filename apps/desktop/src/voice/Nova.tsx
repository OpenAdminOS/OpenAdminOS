import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAppState } from "../state";
import { Button } from "../components/Button";
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
    [mode, setMode] = useState<"openai" | "local">("openai");
  const [name, setName] = useState(
    () => localStorage.getItem("nova.greeting-name") || "",
  );
  const [key, setKey] = useState(""),
    [hasKey, setHasKey] = useState(false),
    [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState("idle"),
    [error, setError] = useState(""),
    [caption, setCaption] = useState("");
  const [expanded, setExpanded] = useState(false);
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
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    blobUrl = useRef("");
  const api = window.openAdminOS;
  const stop = useCallback(() => {
    generation.current++;
    clearTimeout(timeout.current);
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
    setConversation(undefined);
    setCaption("");
  }, [state.activeTenantId, state.activeProviderId, stop]);
  useEffect(() => {
    if (open)
      void api
        ?.nova({ action: "status" })
        .then((r) => setHasKey(!!r.hasKey))
        .catch((e) => setError(String(e)));
  }, [open, api]);
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
    if (channel.current?.readyState === "open")
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
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    try {
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
        lastPlayback = 0;
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
            phaseRef.current = "listening";
            setPhase("listening");
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
            if (answer.route) navigate(answer.route);
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
      let history = "",
        queued = Promise.resolve(),
        lastSpeaker = "";
      const delegated = new Set<string>();
      dc.onmessage = (e) => {
        if (token !== generation.current) return;
        try {
          const event = JSON.parse(e.data);
          if (event.type === "session.started") {
            clearTimeout(timeout.current);
            setPhase("listening");
            dc.send(
              JSON.stringify({
                type: "session.thinking.append",
                delegation_id: null,
                content: `Current app page: ${location.pathname}. No action is approved.`,
              }),
            );
          } else if (
            event.type === "session.input_transcript.delta" ||
            event.type === "session.output_transcript.delta"
          ) {
            const role = event.type.includes("input_") ? "User" : "Nova";
            if (typeof event.delta !== "string") return;
            history = (
              history +
              (lastSpeaker !== role ? `\n${role}: ` : "") +
              event.delta
            ).slice(-12000);
            setCaption((current) =>
              (
                current +
                (lastSpeaker !== role ? `\n${role}: ` : "") +
                event.delta
              ).slice(-3000),
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
            const text =
              history.split("\nUser: ").at(-1)?.split("\nNova: ")[0]?.trim() ||
              history;
            queued = queued
              .then(async () => {
                if (token !== generation.current) return;
                setPhase("thinking");
                const answer = await api.nova({
                  action: "answer",
                  sessionId: sessionId.current,
                  text,
                });
                if (token !== generation.current || dc.readyState !== "open")
                  return;
                setConversation(answer.conversationId);
                if (answer.route) navigate(answer.route);
                setCaption(answer.text || "");
                const result =
                  answer.text || "No answer available. Open Chat for details.";
                setPhase("listening");
                for (let i = 0; i < Array.from(result).length; i += 100)
                  dc.send(
                    JSON.stringify({
                      type: "session.commentary.append",
                      delegation_id: id,
                      content: Array.from(result)
                        .slice(i, i + 100)
                        .join(""),
                    }),
                  );
              })
              .catch(fail);
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
  return (
    <div className="nova-root">
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
          className={`nova-panel${expanded ? " nova-panel-expanded" : ""}`}
          aria-label="Nova voice assistant"
        >
          <div className="flex items-center justify-between">
            <strong>
              Nova <span className="nova-eyebrow">VOICE</span>
            </strong>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Compact view" : "Expand view"}
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
          <p className="text-xs text-[var(--color-text-muted)]">
            {state.tenants.find((t) => t.id === state.activeTenantId)
              ?.displayName || "No tenant selected"}{" "}
            · {location.pathname.split("/")[1] || "Chat"}
          </p>
          <p className="text-xs text-[var(--color-accent)]">
            {mode === "openai"
              ? "Hosted voice · audio and shared context go to OpenAI"
              : "Local voice · audio stays on this device"}
          </p>
          <button
            ref={orb}
            className="nova-orb"
            data-phase={
              error ? "error" : muted && phase === "listening" ? "muted" : phase
            }
            onClick={() => (active ? stop() : void start())}
            disabled={
              !state.activeTenantId ||
              (mode === "openai" && (!hasKey || !consent))
            }
            aria-label={active ? "Stop Nova" : "Start Nova"}
          >
            <span className="nova-orb-core" aria-hidden="true" />
            <span className="nova-orb-ring" aria-hidden="true" />
          </button>
          <div role="status" className="text-center text-sm">
            {phase === "idle"
              ? "Start a conversation. Say “Hey Nova”."
              : phase === "connecting"
                ? "Connecting microphone and voice…"
                : phase === "listening"
                  ? muted
                    ? "Microphone muted"
                    : "Listening"
                  : phase === "thinking"
                    ? "Checking tenant evidence…"
                    : "Nova is speaking"}
          </div>
          {active && (
            <div className="flex justify-center gap-2">
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
              aria-pressed={captions}
              onClick={() => setCaptions(!captions)}
            >
              Captions {captions ? "on" : "off"}
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
          {captions && (
            <div className="nova-caption" aria-label="Conversation captions">
              {caption || "Your conversation will appear here."}
            </div>
          )}
          <audio ref={output} hidden />
          {playBlocked && (
            <Button
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
              variant="secondary"
              onClick={() => navigate(`/chat/${conversation}`)}
            >
              Open evidence in Chat
            </Button>
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
                Voice provider
                <select
                  value={mode}
                  onChange={(e) => {
                    stop();
                    setMode(e.target.value as "local" | "openai");
                    setConsent(false);
                    setError("");
                  }}
                >
                  <option value="openai">OpenAI · GPT-Live-1</option>
                  <option value="local">Local · whisper.cpp + Kokoro</option>
                </select>
              </label>
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
                      disabled={!key.trim()}
                      onClick={() =>
                        void api
                          ?.nova({ action: "configure", apiKey: key })
                          .then(() => {
                            setKey("");
                            setHasKey(true);
                            setError("");
                          })
                          .catch((e) => setError(String(e)))
                      }
                    >
                      Save key
                    </Button>
                    {hasKey && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void api
                            ?.nova({ action: "configure", apiKey: null })
                            .then(() => setHasKey(false))
                            .catch((e) => setError(String(e)))
                        }
                      >
                        Remove key
                      </Button>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Run whisper-server at 127.0.0.1:8080 and Kokoro-FastAPI at
                  127.0.0.1:8880, with models downloaded. Select a local agent
                  provider such as Ollama. Click Finish speaking to submit. No
                  cloud fallback. Maximum recording: one minute.
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
    </div>
  );
}
