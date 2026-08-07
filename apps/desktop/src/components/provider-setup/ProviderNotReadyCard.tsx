import { useState, type ReactNode } from "react";
import type { ProviderSummary } from "../../shared/openAdminOS";
import { copyTextToClipboard } from "../../shared/clipboard";
import { useToast } from "../Toast";
import { Button } from "../Button";
import {
  IconCheck,
  IconCloud,
  IconCopy,
  IconExternal,
  IconHardDrive,
  IconWarning,
} from "../icons";

export function ProviderNotReadyCard({
  provider,
  onRecheck,
}: {
  provider: ProviderSummary;
  onRecheck: () => void | Promise<void>;
}) {
  const [rechecking, setRechecking] = useState(false);
  const [attemptedRecheck, setAttemptedRecheck] = useState(false);
  const warn =
    provider.status === "error" ||
    (attemptedRecheck && provider.status !== "connected");

  const handleRecheck = async () => {
    setRechecking(true);
    setAttemptedRecheck(true);
    try {
      await onRecheck();
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    } finally {
      setRechecking(false);
    }
  };

  if (provider.id === "ollama") {
    return (
      <OllamaInstallGuide
        warn={warn}
        rechecking={rechecking}
        onRecheck={handleRecheck}
      />
    );
  }

  return (
    <div
      className={
        warn
          ? "rounded-xl bg-[var(--color-warning-soft)] p-5 ring-1 ring-[var(--color-warning)]/30"
          : "rounded-xl bg-[var(--color-surface)] p-5 ring-1 ring-[var(--color-border-soft)]"
      }
    >
      <div className="flex items-start gap-3">
        <div
          className={
            warn
              ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/35"
              : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-info-soft)] text-[var(--color-info)] ring-1 ring-[var(--color-info)]/25"
          }
        >
          {warn ? (
            <IconWarning size={15} />
          ) : provider.isLocal ? (
            <IconHardDrive size={15} />
          ) : (
            <IconCloud size={15} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            {warn ? `${provider.name} is not reachable.` : `${provider.name} needs setup.`}
          </div>
          <p className="mt-1 break-words text-[12px] leading-5 text-[var(--color-text-soft)]">
            {provider.detail ?? "Install or configure the provider, then recheck."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void handleRecheck()}
              disabled={rechecking}
            >
              {rechecking ? "Rechecking…" : "Recheck"}
            </Button>
            {providerGuideUrl(provider.id) && (
              <Button
                size="sm"
                variant="secondary"
                trailingIcon={<IconExternal size={11} />}
                onClick={() => void window.openAdminOS?.openExternal(providerGuideUrl(provider.id)!)}
              >
                Open setup guide
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function OllamaInstallGuide({
  warn,
  rechecking,
  onRecheck,
}: {
  warn: boolean;
  rechecking: boolean;
  onRecheck: () => void | Promise<void>;
}) {
  const platform = window.openAdminOS?.platform ?? "unknown";
  const openExternal = (url: string) => void window.openAdminOS?.openExternal(url);

  return (
    <div
      className={
        warn
          ? "overflow-hidden rounded-xl bg-[var(--color-warning-soft)] ring-1 ring-[var(--color-warning)]/30"
          : "overflow-hidden rounded-xl bg-[var(--color-surface)] ring-1 ring-[var(--color-border-soft)]"
      }
    >
      <div className="flex items-start gap-3 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-raised)]/40 px-5 py-4">
        <div
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            warn
              ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/35"
              : "bg-[var(--color-info-soft)] text-[var(--color-info)] ring-1 ring-[var(--color-info)]/25"
          }`}
        >
          {warn ? <IconWarning size={15} /> : <IconHardDrive size={15} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            {warn ? "Ollama is not running on this device." : "Set up Ollama locally"}
          </div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-soft)]">
            Ollama runs the model on this device. Install it, start it, then recheck the connection.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 bg-[var(--color-bg)]/40 px-5 py-5">
        <InstallStep number={1} title="Install Ollama">
          {platform === "macos" && <MacInstallStep openExternal={openExternal} />}
          {platform === "windows" && <WindowsInstallStep openExternal={openExternal} />}
          {platform === "linux" && <LinuxInstallStep />}
          {platform === "unknown" && <UnknownPlatformInstallStep openExternal={openExternal} />}
        </InstallStep>
        <InstallStep number={2} title="Start Ollama">
          {platform === "macos" ? (
            <p className="text-[12px] leading-5 text-[var(--color-text-soft)]">
              Open the Ollama app. It stays available from the menu bar.
            </p>
          ) : platform === "windows" ? (
            <p className="text-[12px] leading-5 text-[var(--color-text-soft)]">
              Open Ollama. It stays available from the system tray.
            </p>
          ) : (
            <CommandRow command="ollama serve" />
          )}
        </InstallStep>
        <InstallStep number={3} title="Recheck the connection">
          <p className="text-[12px] leading-5 text-[var(--color-text-soft)]">
            OpenAdminOS detects Ollama without an app restart.
          </p>
          <Button
            className="mt-3"
            size="sm"
            variant="primary"
            onClick={() => void onRecheck()}
            disabled={rechecking}
          >
            {rechecking ? "Rechecking…" : "Recheck"}
          </Button>
        </InstallStep>
      </div>
    </div>
  );
}

function InstallStep({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-warning-soft)] text-[11px] font-medium text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/40">
        {number}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-[var(--color-text)]">{title}</div>
        <div className="mt-1.5">{children}</div>
      </div>
    </div>
  );
}

function CommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
      <span className="break-all font-mono text-[12px] text-[var(--color-text)]">{command}</span>
      <button
        type="button"
        onClick={() => {
          void copyTextToClipboard(command)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
        }}
        className="ml-auto inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
      >
        {copied ? <IconCheck size={10} /> : <IconCopy size={10} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function MacInstallStep({ openExternal }: { openExternal: (url: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-5 text-[var(--color-text-soft)]">
        Download the macOS app and move it to Applications, or install it with Homebrew.
      </p>
      <Button
        size="sm"
        variant="secondary"
        trailingIcon={<IconExternal size={11} />}
        onClick={() => openExternal("https://ollama.com/download/mac")}
      >
        Download for macOS
      </Button>
      <CommandRow command="brew install ollama" />
    </div>
  );
}

function WindowsInstallStep({ openExternal }: { openExternal: (url: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-5 text-[var(--color-text-soft)]">
        Download and run the Windows installer.
      </p>
      <Button
        size="sm"
        variant="secondary"
        trailingIcon={<IconExternal size={11} />}
        onClick={() => openExternal("https://ollama.com/download/windows")}
      >
        Download for Windows
      </Button>
    </div>
  );
}

function LinuxInstallStep() {
  return (
    <div className="space-y-2">
      <p className="text-[12px] leading-5 text-[var(--color-text-soft)]">
        Run the official install command in a terminal.
      </p>
      <CommandRow command="curl -fsSL https://ollama.com/install.sh | sh" />
    </div>
  );
}

function UnknownPlatformInstallStep({ openExternal }: { openExternal: (url: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-5 text-[var(--color-text-soft)]">
        Open the Ollama download page and choose the build for this device.
      </p>
      <Button
        size="sm"
        variant="secondary"
        trailingIcon={<IconExternal size={11} />}
        onClick={() => openExternal("https://ollama.com/download")}
      >
        Open downloads
      </Button>
    </div>
  );
}

function providerGuideUrl(id: ProviderSummary["id"]): string | undefined {
  switch (id) {
    case "apple-foundation":
      return "https://support.apple.com/121115";
    case "lm-studio":
      return "https://lmstudio.ai";
    case "anthropic":
      return "https://docs.anthropic.com/en/docs/claude-code/overview";
    case "openai":
      return "https://github.com/openai/codex";
    case "azure-openai":
      return "https://learn.microsoft.com/azure/ai-services/openai/";
    default:
      return undefined;
  }
}
