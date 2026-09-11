import { useEffect, useState } from "react";
import type {
  AgentManifestPreview,
  RegistryAgentSummary,
} from "../../shared/openAdminOS";
import { useAppState } from "../../state";
import { AgentInstallDetails } from "../../pages/AgentHub";
import { Modal, ModalHeader } from "../Modal";

/** Uses the Hub's permission review and signed installation without leaving the draft. */
export function PersonaWorkflowInstall({
  agent,
  tenantId,
  onClose,
}: {
  agent: RegistryAgentSummary;
  tenantId: string;
  onClose(): void;
}) {
  const { state, installAgent } = useAppState();
  const [preview, setPreview] = useState<AgentManifestPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const installed = state.installedAgents.some((a) => a.slug === agent.slug);
  useEffect(() => {
    let active = true;
    const api = window.openAdminOS;
    if (!api) {
      setPreviewError("Open the desktop app to review and install workflows.");
      setLoading(false);
      return;
    }
    void api
      .getAgentManifest(agent.slug)
      .then((value) => {
        if (active) setPreview(value ?? null);
      })
      .catch((e: unknown) => {
        if (active) setPreviewError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agent.slug]);
  const close = () => {
    if (!installing) onClose();
  };
  const install = async () => {
    setInstalling(true);
    setError("");
    try {
      await installAgent(agent.registryId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };
  return (
    <Modal open onClose={close} size="lg" ariaLabel={`Install ${agent.name}`}>
      <ModalHeader
        title={agent.name}
        subtitle="Install this workflow locally. Your teammate draft stays open."
        onClose={close}
      />
      <div className="overflow-y-auto p-6">
        {error && (
          <p role="alert" className="office-error">
            Installation failed: {error} Review the error and retry
            installation.
          </p>
        )}
        {installed && (
          <p role="status">
            Workflow installed. Return to your teammate to finish its assignment.
          </p>
        )}
        <AgentInstallDetails
          agent={agent}
          installed={installed}
          tenantTier={state.tenants.find((t) => t.id === tenantId)?.entraTier}
          manifestPreview={preview}
          manifestError={previewError}
          manifestLoading={loading}
          confirmInstall={agent.compatibility?.supported !== false}
          installing={installing}
          showRaw={showRaw}
          onToggleRaw={() => setShowRaw((v) => !v)}
          onRequestInstall={() => undefined}
          onCancelInstall={close}
          onConfirmInstall={() => void install()}
          onOpen={close}
          openLabel="Return to teammate"
        />
      </div>
    </Modal>
  );
}
