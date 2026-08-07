import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { SetupFlowProvider } from "./setup/SetupFlowContext";
import { AppStateProvider } from "./state";
import "./styles/globals.css";

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
