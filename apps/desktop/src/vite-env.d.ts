/// <reference types="vite/client" />

import type { OpenAdminOSApi } from "./shared/openAdminOS";

declare module "*.css";

declare global {
  interface Window {
    openAdminOS?: OpenAdminOSApi;
  }
}
