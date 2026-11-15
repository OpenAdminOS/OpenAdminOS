import { useEffect, useState } from "react";

import type { EnterpriseStatus } from "@openadminos/agent-sdk";

/** The team features status, kept current with the main process. Inactive when the bridge has none. */
export function useEnterpriseStatus(): EnterpriseStatus {
  const [status, setStatus] = useState<EnterpriseStatus>({ active: false });

  useEffect(() => {
    const bridge = window.openAdminOS;
    if (!bridge?.getEnterpriseStatus) return;
    let current = true;
    const refresh = () => {
      bridge.getEnterpriseStatus?.().then(
        (next) => {
          if (current) setStatus(next);
        },
        (error: unknown) => {
          console.error("[enterprise] the team features status could not be read", error);
        },
      );
    };
    refresh();
    const unsubscribe = bridge.onEnterpriseStatusChanged?.(refresh);
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, []);

  return status;
}
