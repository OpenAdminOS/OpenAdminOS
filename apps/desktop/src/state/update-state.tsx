import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { UpdateState } from "../shared/openAdminOS";

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
      .catch(() => undefined);
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
        const next = await window.openAdminOS?.checkForUpdatesNow();
        if (next) setState(next);
      },
      restart: async () => {
        await window.openAdminOS?.applyUpdateNow();
      },
    }),
    [state],
  );

  return <UpdateStateContext.Provider value={value}>{children}</UpdateStateContext.Provider>;
}

export function useUpdateState(): UpdateStateContextValue {
  const value = useContext(UpdateStateContext);
  if (!value) throw new Error("useUpdateState must be used within UpdateStateProvider.");
  return value;
}
