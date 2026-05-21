/// <reference types="vite/client" />

import type { OpenAdminOSApi } from "./shared/openAdminOS";

declare module "*.css";

declare global {
  interface Window {
    openAdminOS?: OpenAdminOSApi;
  }

  // Injected by vite.config.ts at build time from apps/desktop/package.json.
  const __APP_VERSION__: string;
}
