import { useEffect, useState } from "react";
import type { NovaRequest, NovaSpeechStatus } from "@openadminos/agent-sdk";
import { Link } from "react-router";
import { Button } from "../components/Button";

export function LocalSpeechSetup({ showModel = false, onChange, openSettings }: {
  showModel?: boolean;
  openSettings?: () => void;
  onChange?: (status: NovaSpeechStatus) => void;
}) {
  const [status, setStatus] = useState<NovaSpeechStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const api = window.openAdminOS;
  useEffect(() => {
    if (!api?.nova) return;
    let disposed = false;
    const refresh = () => void api.nova({ action: "speech-status" }).then(result => {
      if (!disposed && result?.speech) {
        setStatus(result.speech);
        onChange?.(result.speech);
      }
    }).catch(() => { if (!disposed) setError("Local voice status could not be checked. Reopen Nova to retry."); });
    refresh();
    const timer = setInterval(refresh, 600);
    return () => { disposed = true; clearInterval(timer); };
  }, [api, onChange]);
  async function act(input: NovaRequest) {
    if (!api) return;
    setError("");
    if (input.action !== "speech-cancel") setBusy(true);
    try {
      const result = await api.nova(input);
      if (result.speech) {
        setStatus(result.speech);
        onChange?.(result.speech);
      }
    } catch (caught) {
      setError(String(caught).replace(/^Error invoking remote method ['"][^'"]+['"]: (?:Error: )?/, ""));
    } finally {
      if (input.action !== "speech-cancel") setBusy(false);
    }
  }
  if (!status && !error) return null;
  const downloading = status?.receivedBytes !== undefined;
  return (
    <section className="nova-local-setup grid gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" aria-label="Local voice setup">
      {status && <>
        {showModel && <label className="nova-field">
          Local voice source
          <select value={status.source} disabled={busy || downloading} onChange={event => void act({
            action: "speech-configure", source: event.target.value as NovaSpeechStatus["source"], model: status.model,
          })}>
            <option value="builtin">Built-in</option>
            <option value="servers">My own servers (advanced)</option>
          </select>
        </label>}
        {status.source === "servers" && !showModel && <p>Using your local servers. {openSettings ? <button className="underline" onClick={openSettings}>Change in Settings</button> : <Link className="underline" to="/settings/nova">Change in Settings</Link>}</p>}
        {status.source === "builtin" && <>
          {showModel && <label className="nova-field">
            Whisper model
            <select value={status.model} disabled={busy || downloading} onChange={event => void act({
              action: "speech-configure", source: status.source, model: event.target.value as NovaSpeechStatus["model"],
            })}>
              <option value="auto">Automatic ({status.gpuAccelerated ? "Large v3 Turbo" : "Small"})</option>
              <option value="small">Small</option>
              <option value="turbo">{status.gpuAccelerated ? "Large v3 Turbo" : "Large v3 Turbo · slow on this device"}</option>
            </select>
          </label>}
          <strong>{status.ready && status.available ? "Ready" : "Set up local voice"}</strong>
          <p>{status.ready ? "Models are installed on this device." : `Download ${Math.ceil(status.totalBytes / 1_000_000)} MB. Speech models come from Hugging Face.`}</p>
          {!status.available && <p role="status">This build is missing the speech runtime. Install a desktop release or use your own servers.</p>}
          {downloading && <>
            <div role="progressbar" aria-label="Speech model download" aria-valuemin={0} aria-valuemax={status.totalBytes}
              aria-valuenow={status.receivedBytes} className="h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]">
              <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${100 * (status.receivedBytes ?? 0) / status.totalBytes}%` }} />
            </div>
            <p role="status">{Math.floor((status.receivedBytes ?? 0) / 1_000_000)} of {Math.ceil(status.totalBytes / 1_000_000)} MB downloaded</p>
            <Button onClick={() => void act({ action: "speech-cancel" })}>Cancel download</Button>
          </>}
          {!status.ready && status.available && !downloading && <Button disabled={busy} onClick={() => void act({ action: "speech-install" })}>
            {status.repairNeeded ? "Download again" : status.error ? "Retry download" : "Download models"}
          </Button>}
          {showModel && Boolean(status.unusedBytes) && <p>The unused model set takes {Math.ceil((status.unusedBytes ?? 0) / 1_000_000)} MB on this device.</p>}
          {status.error && <p role="alert">{status.error}</p>}
        </>}
      </>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
