import { useCallback, useEffect, useRef, useState } from "react";
import type { NovaCallRequest, NovaCallUpdate, NovaCallView } from "@openadminos/agent-sdk";
import { Button } from "../components/ui";

const idle: NovaCallView = { state: "idle", canSuggest: false, suggesting: false };
const endedMessage = {
  permission: "Allow OpenAdminOS in Privacy & Security → Screen & System Audio Recording. Choose the system audio option, then start again.",
  failed: "Nova could not restore system audio. Check your Mac audio output, then start again.",
  "no-speech": "Call assist stopped after five minutes without speech.",
  "time-limit": "Call assist stopped after one hour.",
  "context-changed": "Your organization, model, or speech settings changed. Start again to use the current setup.",
  "speech-error": "Local speech processing stopped. Check built-in speech in Settings > Nova, then start again.",
  stopped: "Call assist stopped.",
} as const;

export function NovaCallAssist({ close }: { close: () => void }) {
  const api = window.openAdminOS;
  const [view, setView] = useState(idle);
  const [consent, setConsent] = useState(false);
  const [confirming, setConfirming] = useState(true);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const agreement = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const revision = useRef(-1);
  const stopping = useRef(false);

  const adopt = useCallback((next?: NovaCallUpdate) => {
    if (!next || next.revision < revision.current || stopping.current) return;
    revision.current = next.revision;
    setView(next);
  }, []);

  useEffect(() => {
    const unsubscribe = api?.onNovaCallChanged?.(adopt);
    const sync = () => {
      const stamp = generation.current;
      void api?.novaCall?.({ action: "status" }).then(next => {
        if (generation.current === stamp) adopt(next);
      }).catch(() => {});
    };
    sync();
    const unsubscribeResume = api?.onAppStateChanged?.(({ reason }) => {
      if (reason === "nova-call-resumed") sync();
      if (reason === "nova-bubble-toggle") panel.current?.querySelector<HTMLElement>("[data-call-focus]")?.focus();
    });
    return () => { generation.current++; unsubscribe?.(); unsubscribeResume?.(); };
  }, [api, adopt]);

  async function action(request: NovaCallRequest) {
    if (!api?.novaCall) return;
    const stamp = generation.current;
    setError("");
    try {
      const next = await api.novaCall(request);
      if (request.action === "stop") stopping.current = false;
      if (generation.current === stamp) adopt(next);
    } catch (caught) {
      if (generation.current !== stamp) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message.replace(/^Error invoking remote method ['"][^'"]+['"]: (?:\w*Error: )?/, ""));
    } finally {
      if (request.action === "stop") stopping.current = false;
      if (generation.current === stamp && request.action === "start") setWorking(false);
    }
  }

  const active = working || ["starting", "waiting-audio", "capturing", "reconnecting"].includes(view.state);
  useEffect(() => {
    if (confirming) agreement.current?.focus();
    else panel.current?.querySelector<HTMLButtonElement>("[data-call-focus]")?.focus();
  }, [confirming, active]);
  const recovery = view.state in endedMessage ? endedMessage[view.state as keyof typeof endedMessage] : "";
  const status = view.state === "reconnecting" ? "Reconnecting audio" : view.state === "capturing"
    ? "Capturing Mac playback" : view.state === "waiting-audio" ? "Waiting for Mac playback" : "Starting call assist";

  return <section ref={panel} className="nova-call-assist" aria-label="Call assist">
    <span className="sr-only" role="status">{confirming ? "" : "Call assist. " + (active ? view.answer ? status + ". Suggested answer ready." : status : recovery)}</span>
    {confirming ? (
      <>
        <h2>Start call assist</h2>
        <p>Nova can hear playback from other apps and browser tabs, including calls. Audio and suggestions stay on this device.</p>
        <label className="nova-call-agreement">
          <input data-call-focus ref={agreement} type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
          <span>I’m allowed to capture this call and have informed the participants.</span>
        </label>
        <div className="nova-bubble-actions">
          <Button variant="primary" size="sm" disabled={!consent} onClick={() => {
            generation.current++;
            setConsent(false);
            setConfirming(false);
            setWorking(true);
            void action({ action: "start", confirmed: consent });
          }}>Start capture</Button>
          <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
        </div>
      </>
    ) : (
      <>
        <div className="nova-call-header">
          <h2>Call assist</h2>
          {active && <span className="nova-call-status" data-reconnecting={view.state === "reconnecting"}>{status}</span>}
        </div>
        {active ? (
          <>
            <div className="nova-bubble-actions">
              <Button variant="primary" size="sm" disabled={!view.canSuggest || view.suggesting} onClick={() => void action({ action: "suggest" })}>
                {view.suggesting ? "Preparing answer" : "Suggest answer"}
              </Button>
              <Button data-call-focus size="sm" variant="secondary" onClick={() => {
                stopping.current = true;
                setView({ ...idle, state: "stopped" });
                setWorking(false);
                generation.current++;
                void action({ action: "stop" });
              }}>Stop</Button>
            </div>
            {view.state === "waiting-audio" && <>
              <p>Play audio from your call. If Nova still hears nothing, check system audio access in Privacy & Security.</p>
              <Button size="sm" variant="ghost" className="self-start" onClick={() => void action({ action: "settings" })}>Open Privacy & Security</Button>
            </>}
            {view.speechSkipped && <p role="status">Nova skipped some audio. Local transcription could not keep up.</p>}
            {!!view.answer && <div className="nova-call-answer" role="region" aria-label="Suggested answer" tabIndex={0}>
              <h3>Suggested answer</h3>
              <p>{view.answer}</p>
            </div>}
            {view.state === "capturing" && !view.canSuggest && !view.answer && <p role="status">Nova needs a few seconds of speech before it can suggest an answer.</p>}
          </>
        ) : (
          <>
            {recovery && <p>{recovery}</p>}
            <div className="nova-bubble-actions">
              {view.state === "permission" && <Button size="sm" variant="secondary" onClick={() => void action({ action: "settings" })}>Open Privacy & Security</Button>}
              <Button data-call-focus variant="primary" size="sm" onClick={() => { setError(""); setConfirming(true); }}>Start again</Button>
              <Button size="sm" variant="ghost" onClick={close}>Back to Nova</Button>
            </div>
          </>
        )}
        {error && <p className="nova-call-error" role="alert">{error}</p>}
      </>
    )}
  </section>;
}
