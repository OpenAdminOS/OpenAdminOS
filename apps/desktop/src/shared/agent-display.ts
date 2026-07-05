import type { AgentCategory, AgentMode } from "./openAdminOS.js";

export interface AgentDisplayAuthor {
  name: string;
  handle: string;
  verified: boolean;
}

export interface AgentDisplay {
  id: string;
  slug: string;
  name: string;
  description: string;
  mode: AgentMode;
  category: AgentCategory;
  scopes: string[];
  author: AgentDisplayAuthor;
  version: string;
  installed: boolean;
  installs?: number;
  lastRunAt?: string;
  preferredModel?: string;
  updateAvailable?: {
    version: string;
    manifestUrl: string;
    minAppVersion?: string;
  };
  compatibility?: {
    supported: boolean;
    appVersion: string;
    minAppVersion: string;
    reason?: string;
  };
}
