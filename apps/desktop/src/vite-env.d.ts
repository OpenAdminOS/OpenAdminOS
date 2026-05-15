/// <reference types="vite/client" />

import type { OpenAgentsApi } from "./shared/openAgents";

declare module "*.css";

declare global {
  interface Window {
    openAgents?: OpenAgentsApi;
  }
}
