import { useState, type ReactNode } from "react";

import type { ChatToolUseStatus, McpServerSummary } from "../../shared/openAdminOS";
import { useAppState } from "../../state";
import { IconCheck, IconClose, IconCloud, IconExternal, IconHardDrive, IconLayers, IconLock, IconRefresh, IconShield, IconUsers, IconWarning } from "../icons";
import { Modal } from "../Modal";
import { Button, Switch } from "../ui";
import { CoverArt, inkFor } from "./CoverArt";

type View = "details" | "install";
type Action = "install" | "check" | "uninstall" | "toggle";

/** Electron prefixes main-process errors with the IPC channel; the host message is what the admin needs. */
export function ipcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method ['"][^'"]+['"]: (?:Error: )?/, "");
}

export function McpServerDialog({
  server,
  toolUse,
  startWithInstall,
  onClose,
}: {
  server: McpServerSummary;
  toolUse: ChatToolUseStatus | undefined;
  startWithInstall: boolean;
  onClose: () => void;
}) {
  // The caller keys this dialog by server id, so every listing opens fresh.
  const { refresh } = useAppState();
  const [view, setView] = useState<View>(startWithInstall && !server.installed ? "install" : "details");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [failure, setFailure] = useState<{ action: Action; title: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const api = window.openAdminOS;
  const run = async (action: Action, task: () => Promise<unknown> | undefined, success: string | ((servers: unknown) => string), failed: string) => {
    setBusy(action);
    setFailure(null);
    setNotice(null);
    try {
      const pending = task();
      if (!pending) throw new Error("This build of OpenAdminOS cannot manage MCP servers. Update the app, then try again.");
      const servers = await pending;
      await refresh();
      setNotice(typeof success === "string" ? success : success(servers));
      if (action === "install") setView("details");
    } catch (error) {
      setFailure({ action, title: failed, message: ipcErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  };
  // A server that answered without an offered tool is recorded, but Chat does not use it.
  const missingAfter = (servers: unknown) => (Array.isArray(servers) ? (servers as McpServerSummary[]) : []).find((entry) => entry.id === server.id)?.missingTools ?? [];
  const install = () => void run("install", () => api?.installMcpServer?.(server.id), (servers) => missingAfter(servers).length > 0
    ? `Installed ${server.name}, but it does not list ${missingAfter(servers).join(", ")}. Chat does not use it until it does.`
    : `Installed ${server.name}. Its tools are available to Chat.`, `${server.name} could not be installed`);
  const check = () => void run("check", () => api?.checkMcpServer?.(server.id), (servers) => missingAfter(servers).length > 0
    ? `${server.name} answered, but it does not list ${missingAfter(servers).join(", ")}. Chat does not use it until it does.`
    : `${server.name} answered. The tool list is up to date.`, `${server.name} did not respond`);
  const uninstall = () => void run("uninstall", () => api?.uninstallMcpServer?.(server.id), `Removed ${server.name}. Chat no longer offers its tools.`, `Could not uninstall ${server.name}`);
  const toggle = (enabled: boolean) => void run("toggle", () => api?.setMcpServerEnabled?.(server.id, enabled),
    enabled ? `${server.name} is available to Chat.` : `${server.name} is off. Chat does not offer its tools.`,
    enabled ? `Could not turn on ${server.name}` : `Could not turn off ${server.name}`);

  const ink = inkFor(server.id);
  return (
    <Modal open onClose={onClose} size="lg" ariaLabel={`${server.name} details`}>
      <div className="relative h-[200px] shrink-0 overflow-hidden" style={{ background: ink.ground, color: ink.highlight }}>
        <CoverArt id={server.id} className="absolute inset-0 h-full w-full" />
        <div className="absolute inset-0" style={{ background: `linear-gradient(0deg, ${ink.ground} 0%, ${ink.ground}b3 38%, transparent 75%)` }} />
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <IconClose size={15} />
        </button>
        <div className="absolute inset-x-6 bottom-5 grid gap-2">
          <ListingTags tags={["MCP tool", "Read only"]} />
          <h2 className="font-serif text-[34px] font-normal leading-[1.05] tracking-[-0.02em]">{server.name}</h2>
          <span className="text-sm opacity-80">{server.publisher}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === "install" ? (
          <InstallReview
            server={server}
            acknowledged={acknowledged}
            onAcknowledge={setAcknowledged}
            busy={busy === "install"}
            failure={failure?.action === "install" ? failure.message : null}
            toolUse={toolUse}
          />
        ) : (
          <Details server={server} toolUse={toolUse} />
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border-soft)] px-6 py-4">
        {notice ? <p role="status" className="basis-full text-sm text-[var(--color-success)]">{notice}</p> : null}
        {failure && failure.action !== "install" ? (
          <ErrorBox title={failure.title} message={failure.message} onRetry={failure.action === "check" ? check : undefined} />
        ) : null}
        {view === "install" ? (
          <>
            <div className="text-sm text-[var(--color-text-muted)]">No sign-in needed · queries go to {server.host}</div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => { setView("details"); setFailure(null); }} disabled={busy === "install"}>Cancel</Button>
              <Button variant="primary" onClick={install} disabled={!acknowledged || busy === "install"} leadingIcon={failure?.action === "install" ? <IconRefresh size={14} /> : undefined}>
                {busy === "install" ? `Connecting to ${server.host}` : failure?.action === "install" ? "Retry" : "Install"}
              </Button>
            </div>
          </>
        ) : server.installed ? (
          <>
            <div className="min-w-[220px] flex-1">
              <Switch
                checked={server.enabled}
                disabled={busy !== null}
                onCheckedChange={toggle}
                label="Available in Chat"
                description={!server.enabled ? "Chat does not offer these tools" : server.missingTools?.length ? "Chat skips this server until its offered tools are back" : `Tool queries go to ${server.host}`}
              />
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={check} disabled={busy !== null} leadingIcon={<IconRefresh size={14} className={busy === "check" ? "animate-spin" : ""} />}>
                {busy === "check" ? "Checking" : "Check connection"}
              </Button>
              <Button variant="danger" onClick={uninstall} disabled={busy !== null}>Uninstall</Button>
            </div>
          </>
        ) : (
          <>
            <div>
              <div className="text-sm font-medium text-[var(--color-text)]">No sign-in needed</div>
              <div className="text-sm text-[var(--color-text-muted)]">Public server from {server.publisher}</div>
            </div>
            <Button variant="primary" onClick={() => setView("install")}>Install</Button>
          </>
        )}
      </div>
    </Modal>
  );
}

function Details({ server, toolUse }: { server: McpServerSummary; toolUse: ChatToolUseStatus | undefined }) {
  return (
    <div className="grid gap-7 px-6 py-6">
      <p className="max-w-[62ch] text-base leading-relaxed text-[var(--color-text-soft)]">{server.description}</p>
      {server.useFor ? (
        <p className="max-w-[62ch] text-sm text-[var(--color-text-muted)]">
          <span className="font-medium text-[var(--color-text-soft)]">Chat uses it for</span> {server.useFor.charAt(0).toLowerCase() + server.useFor.slice(1)}
        </p>
      ) : null}
      <Operator server={server} className="max-w-[62ch] text-sm text-[var(--color-text-muted)]" />
      {toolUse?.available === false && toolUse.notice ? <ToolUseNotice notice={toolUse.notice} /> : null}
      {server.missingTools?.length ? <MissingTools server={server} missing={server.missingTools} /> : null}
      <section>
        <h3 className="mb-3 font-serif text-xl font-normal text-[var(--color-text)]">Where queries go</h3>
        <QueryFlow host={server.host} skipped={Boolean(server.missingTools?.length)} />
      </section>
      <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-3 rounded-xl bg-[var(--color-bg-raised)] px-4 py-3.5 text-sm text-[var(--color-text-soft)]">
        <IconShield size={20} className="text-[var(--color-text)]" />
        <span>Read only. This server never connects to your tenant and cannot propose changes.</span>
      </div>
      {server.notes?.map((note) => (
        <div key={note} className="grid grid-cols-[22px_minmax(0,1fr)] gap-3 rounded-xl bg-[var(--color-bg-raised)] px-4 py-3.5 text-sm text-[var(--color-text-soft)]">
          <IconUsers size={20} className="text-[var(--color-text)]" />
          <span>{note}</span>
        </div>
      ))}
      <section>
        <h3 className="mb-3 font-serif text-xl font-normal text-[var(--color-text)]">Tools Chat can call</h3>
        {server.missingTools?.length ? (
          <p className="mb-3 text-sm text-[var(--color-warning)]">Chat calls none of these until every offered tool is back.</p>
        ) : null}
        {server.tools.length > 0 ? (
          <div className="grid gap-px overflow-hidden rounded-xl ring-1 ring-[var(--color-border-soft)]">
            {server.tools.map((tool) => (
              <div key={tool.name} className="grid gap-0.5 bg-[var(--color-bg-raised)] px-4 py-2.5 text-sm">
                <div className="flex justify-between gap-3">
                  <code className="font-mono text-xs text-[var(--color-text)]">{tool.name}</code>
                  {tool.unavailable
                    ? <span className="text-xs text-[var(--color-warning)]">Not offered to Chat</span>
                    : <span className="text-xs text-[var(--color-success)]">Reads</span>}
                </div>
                {tool.description ? <span className="line-clamp-2 text-xs text-[var(--color-text-muted)]">{tool.description}</span> : null}
                {tool.unavailable ? <span className="text-xs text-[var(--color-warning)]">{tool.unavailable}</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">{server.installed
            ? `${server.name} listed none of the tools OpenAdminOS offers at its last connection.`
            : "The server lists its tools when you install it. OpenAdminOS shows them here and offers them to Chat."}</p>
        )}
        {server.offeredTools ? (
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">OpenAdminOS offers only {server.offeredTools.length === 1 ? "this tool" : `these ${server.offeredTools.length} tools`} from {server.name}. Other tools the server lists are never shown or called.</p>
        ) : null}
      </section>
      <section>
        <h3 className="mb-3 font-serif text-xl font-normal text-[var(--color-text)]">Details</h3>
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-x-6 gap-y-4 text-sm">
          <Fact label="Publisher" value={server.publisher} />
          {server.policy ? <Fact label="Terms and privacy" value={<PolicyLink policy={server.policy} />} /> : null}
          <Fact label="Sign-in" value="No sign-in needed" />
          <Fact label="Endpoint" value={<code className="font-mono text-xs">{server.url}</code>} />
          <Fact label="Protocol" value="MCP, streamable HTTP" />
          {server.installedAt ? <Fact label="Installed" value={formatDate(server.installedAt)} /> : null}
          {server.lastConnectedAt ? <Fact label="Last connected" value={formatDate(server.lastConnectedAt)} /> : null}
        </dl>
      </section>
    </div>
  );
}

function InstallReview({
  server,
  acknowledged,
  onAcknowledge,
  busy,
  failure,
  toolUse,
}: {
  server: McpServerSummary;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  busy: boolean;
  failure: string | null;
  toolUse: ChatToolUseStatus | undefined;
}) {
  return (
    <div className="grid gap-5 px-6 py-6">
      <h3 className="font-serif text-2xl font-normal text-[var(--color-text)]">Install {server.name}?</h3>
      <ol className="grid gap-4 text-sm text-[var(--color-text-soft)]">
        <Step icon={<IconLock size={16} />} title="Authentication">
          No sign-in needed. This server is public and asks for no account, key or token.
        </Step>
        <Step icon={<IconCloud size={16} />} title="Where queries go" warning>
          Tool queries go to <code className="font-mono text-xs">{server.host}</code>. Each query is written from your current question only, never from Graph or cache data. The status strip names this host while the server is on.
        </Step>
        <Step icon={<IconShield size={16} />} title="What is sent">
          Words from your question can be sent to {server.host}. A filter blocks known tenant names, IDs, email addresses and IP addresses, but cannot guarantee it catches every private detail. Every query is shown in its Chat step. Answers are passed to the model as reference material, not instructions.
        </Step>
        <Step icon={<IconHardDrive size={16} />} title="Tenant access">
          None. The server cannot read or change your tenant.
        </Step>
        <Step icon={<IconExternal size={16} />} title="Who runs it">
          <Operator server={server} />
          {server.notes?.map((note) => <span key={note} className="mt-1 block">{note}</span>)}
        </Step>
        <Step icon={<IconLayers size={16} />} title="Tools Chat will be offered">
          {server.offeredTools ? (
            <>
              <span className="mt-1 flex flex-wrap gap-1.5">
                {server.offeredTools.map((name) => <code key={name} className="rounded-md bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-text)]">{name}</code>)}
              </span>
              <span className="mt-1 block">Only these. Other tools {server.name} lists are never shown or called.</span>
            </>
          ) : (
            <>Every tool {server.name} lists when it connects. They are shown in the details after install.</>
          )}
        </Step>
      </ol>
      {toolUse?.available === false && toolUse.notice ? <ToolUseNotice notice={toolUse.notice} /> : null}
      <label className="flex cursor-pointer items-start gap-2.5 rounded-xl bg-[var(--color-bg-raised)] px-4 py-3 text-sm text-[var(--color-text-soft)]">
        <input type="checkbox" className="mt-0.5" checked={acknowledged} disabled={busy} onChange={(event) => onAcknowledge(event.target.checked)} />
        I understand that words from my question can be sent to {server.host}.
      </label>
      {busy ? (
        <p role="status" className="text-sm text-[var(--color-text-muted)]">Connecting to {server.host} and listing its tools.</p>
      ) : null}
      {failure ? <ErrorBox title={`${server.name} could not be installed`} message={`${failure} Nothing was installed.`} /> : null}
    </div>
  );
}

/** Who runs the server, and its terms or privacy page where one exists. The host is named in Where queries go. */
function Operator({ server, className }: { server: McpServerSummary; className?: string }) {
  return (
    <span className={`block ${className ?? ""}`}>
      {server.operator ?? `Run by ${server.publisher}.`}
      {server.policy ? <> <PolicyLink policy={server.policy} /></> : null}
    </span>
  );
}

function PolicyLink({ policy }: { policy: { label: string; url: string } }) {
  return (
    <a href={policy.url} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] underline underline-offset-2 hover:opacity-80">
      {policy.label}
    </a>
  );
}

/** Where a Chat query goes. A server Chat skips because offered tools are missing receives nothing, and says so. */
function QueryFlow({ host, skipped = false }: { host: string; skipped?: boolean }) {
  const node = "grid content-start gap-1 rounded-xl bg-[var(--color-bg-raised)] p-3.5 ring-1 ring-[var(--color-border-soft)]";
  const edge = "hidden items-center justify-center text-[var(--color-text-muted)] md:flex";
  return (
    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_28px_minmax(0,1fr)]">
      <div className={node}>
        <b className="text-sm font-medium text-[var(--color-text)]">Chat on this device</b>
        <span className="text-xs text-[var(--color-text-muted)]">A query is written from your current question</span>
      </div>
      <div className={edge} aria-hidden="true">→</div>
      <div className={node}>
        <b className="text-sm font-medium text-[var(--color-text)]">OpenAdminOS on this device</b>
        <span className="text-xs text-[var(--color-text-muted)]">Known tenant names, IDs, email and IP addresses are blocked before sending</span>
      </div>
      <div className={`${edge} text-[var(--color-warning)]`} aria-hidden="true">→</div>
      <div className={`${node} bg-[var(--color-warning-soft)] ring-[var(--color-warning)]/35`}>
        <b className="break-all text-sm font-medium text-[var(--color-text)]">{host}</b>
        <span className="text-xs text-[var(--color-text-muted)]">{skipped ? "Chat sends nothing to it until its offered tools are back" : "Receives the query text"}</span>
      </div>
    </div>
  );
}

function Step({ icon, title, warning = false, children }: { icon: ReactNode; title: string; warning?: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[18px_minmax(0,1fr)] gap-3">
      <span className={`mt-0.5 ${warning ? "text-[var(--color-warning)]" : "text-[var(--color-text-muted)]"}`}>{icon}</span>
      <span>
        <span className="block font-medium text-[var(--color-text)]">{title}</span>
        {children}
      </span>
    </li>
  );
}

/** An offered tool the server stopped listing: Chat leaves the server alone until a check finds it again. */
function MissingTools({ server, missing }: { server: McpServerSummary; missing: string[] }) {
  const names = missing.map((name, index) => (
    <span key={name}>{index > 0 ? (index === missing.length - 1 ? " and " : ", ") : null}<code className="font-mono text-xs">{name}</code></span>
  ));
  return (
    <div role="alert" className="flex gap-2.5 rounded-xl bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
      <IconWarning size={16} className="mt-0.5 shrink-0" />
      <span>
        <span className="block font-medium">{server.name} no longer lists {missing.length === 1 ? "a tool" : "tools"} OpenAdminOS offers</span>
        Missing: {names}. Chat does not use {server.name} until every offered tool is back. Check the connection again later.
      </span>
    </div>
  );
}

function ToolUseNotice({ notice }: { notice: string }) {
  return (
    <div role="note" className="flex gap-2.5 rounded-xl bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
      <IconWarning size={16} className="mt-0.5 shrink-0" />
      <span>{notice}</span>
    </div>
  );
}

function ErrorBox({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex basis-full flex-wrap items-start justify-between gap-3 rounded-xl bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        {message}
      </span>
      {onRetry ? <Button size="sm" variant="secondary" leadingIcon={<IconRefresh size={13} />} onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="mb-0.5 text-[var(--color-text-muted)]">{label}</dt>
      <dd className="m-0 break-words text-[var(--color-text-soft)]">{value}</dd>
    </div>
  );
}

export function ListingTags({ tags }: { tags: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-black/35 px-2.5 py-0.5 text-xs text-white/90 backdrop-blur">
          {tag === "Read only" ? <IconCheck size={11} /> : null}
          {tag}
        </span>
      ))}
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
