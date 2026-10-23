import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/newsreader/wght.css";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { SetupFlowProvider } from "./setup/SetupFlowContext";
import { AppStateProvider } from "./state";
import "./styles/globals.css";
import { initializeAppearance } from "./styles/appearance";

initializeAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppStateProvider>
      <ToastProvider>
        <HashRouter>
          <SetupFlowProvider>
            <App />
          </SetupFlowProvider>
        </HashRouter>
      </ToastProvider>
    </AppStateProvider>
  </StrictMode>,
);
