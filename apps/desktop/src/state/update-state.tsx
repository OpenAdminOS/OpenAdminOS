import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { UpdateState } from "../shared/openAdminOS";
import { userFacingErrorReason } from "../copy";

interface UpdateStateContextValue {
  state: UpdateState;
  retry: () => Promise<void>;
  restart: () => Promise<void>;
}

const UpdateStateContext = createContext<UpdateStateContextValue | undefined>(undefined);

export function UpdateStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState>({ status: "idle" });

  useEffect(() => {
    const api = window.openAdminOS;
    if (!api) return;
    let cancelled = false;
    void api
      .getUpdateState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: updateErrorMessage("The update status could not be loaded", error),
          });
        }
      });
    const unsubscribe = api.onUpdateStateChanged((next) => setState(next));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const value = useMemo<UpdateStateContextValue>(
    () => ({
      state,
      retry: async () => {
        try {
          const next = await window.openAdminOS?.checkForUpdatesNow();
          if (next) setState(next);
        } catch (error) {
          setState({
            status: "error",
            message: updateErrorMessage("The update check failed", error),
          });
        }
      },
      restart: async () => {
        try {
          await window.openAdminOS?.applyUpdateNow();
        } catch (error) {
          setState({
            status: "error",
            message: updateErrorMessage("The update could not be installed", error),
          });
        }
      },
    }),
    [state],
  );

  return <UpdateStateContext.Provider value={value}>{children}</UpdateStateContext.Provider>;
}

function updateErrorMessage(action: string, error: unknown): string {
  const detail = userFacingErrorReason(error instanceof Error ? error.message : String(error));
  return `${action}.${detail ? ` ${detail}` : ""} Try again from About and updates.`;
}

export function useUpdateState(): UpdateStateContextValue {
  const value = useContext(UpdateStateContext);
  if (!value) throw new Error("useUpdateState must be used within UpdateStateProvider.");
  return value;
}

export function useUpdateStateOptional(): UpdateStateContextValue | undefined {
  return useContext(UpdateStateContext);
}
