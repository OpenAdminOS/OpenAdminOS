import { Nova } from "./voice/Nova";
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
import { LOCAL_RESET_INCOMPLETE_HASH, LocalResetIncomplete } from "./setup/LocalReset";
import "./styles/globals.css";
import { initializeAppearance } from "./styles/appearance";
import { initializeAnswerFont } from "./styles/answer-font";
import { initializeDensity } from "./styles/density";

initializeAppearance();
initializeAnswerFont();
initializeDensity();

const root = createRoot(document.getElementById("root")!);
// A reset that did not finish keeps the app closed: no store runs, so the
// screen renders without the app state providers.
if (window.location.hash.startsWith(LOCAL_RESET_INCOMPLETE_HASH)) {
  root.render(
    <StrictMode>
      <LocalResetIncomplete />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <AppStateProvider>
        <ToastProvider>
          <HashRouter>
            <SetupFlowProvider>
              {window.location.hash === "#/nova-bubble" ? <Nova bubble /> : <App />}
            </SetupFlowProvider>
          </HashRouter>
        </ToastProvider>
      </AppStateProvider>
    </StrictMode>,
  );
}
