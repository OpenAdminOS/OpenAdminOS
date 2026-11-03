export interface RoadmapItem {
  title: string;
  text: string;
}

export interface RoadmapStage {
  title: string;
  summary: string;
  /** Shown as a status next to the stage number. Only for shipped work. */
  status?: string;
  items: readonly RoadmapItem[];
}

// Stages are ordered, not dated. Keep this list user facing: no pricing,
// release numbers, or internal plans. Every item has a public GitHub issue.
export const ROADMAP_STAGES: readonly RoadmapStage[] = [
  {
    title: "The trusted desktop",
    summary: "A signed desktop app for macOS, Windows and Linux.",
    status: "Available today",
    items: [
      {
        title: "Chat over live tenant data",
        text: "Answers tied to the records actually read.",
      },
      {
        title: "Agent registry",
        text: "Community agents with declared scopes and read or write class.",
      },
      {
        title: "Confirmed writes",
        text: "Diff review, dry runs, risk flags and action limits on every change.",
      },
      {
        title: "Schedules and agent teammates",
        text: "Recurring checks and persistent assignments.",
      },
      {
        title: "Eight model providers",
        text: "Local and hosted, with the destination always named.",
      },
      {
        title: "Scoped permissions",
        text: "Choose permission areas and use your own app registration.",
      },
    ],
  },
  {
    title: "Any model, any tenant",
    summary: "Wider reach for every admin.",
    items: [
      {
        title: "More providers",
        text: "Google Antigravity, Muse, Mistral and Microsoft AI.",
      },
      {
        title: "Agent identity",
        text: "Least privilege per agent, with its own Entra agent identity or service principal.",
      },
      {
        title: "Local model explorer",
        text: "Find, fit check and download models inside the app.",
      },
      {
        title: "Compute across your devices",
        text: "Spread model work over your own machines, any GPU vendor.",
      },
      {
        title: "Google Workspace",
        text: "Including Workspace by STACKIT, beyond Microsoft 365.",
      },
      {
        title: "Shared memory",
        text: "Confirmed lessons shared across sessions, tools and devices.",
      },
      {
        title: "Activity and audit log",
        text: "Every agent run, Chat request and MCP call in one place.",
      },
      {
        title: "iOS and Android companion",
        text: "Follow runs and answer questions from your phone.",
      },
    ],
  },
  {
    title: "Built for IT teams",
    summary: "Shared control, end-to-end encrypted.",
    items: [
      {
        title: "Team approvals",
        text: "A second admin signs off before a write applies.",
      },
      {
        title: "Roles",
        text: "Decide who may use which agents, tools and skills.",
      },
      {
        title: "Team memory",
        text: "Confirmed lessons shared across the team.",
      },
      {
        title: "Audit forwarding",
        text: "To Microsoft Sentinel, Agent 365 and PostHog.",
      },
    ],
  },
  {
    title: "The ecosystem",
    summary: "Where vendors meet admins.",
    items: [
      {
        title: "Marketplace",
        text: "Vendor agents, plugins and MCP tools.",
      },
      {
        title: "Partner connectors",
        text: "Vendor agents that call their own backends through declared connectors.",
      },
      {
        title: "One rulebook",
        text: "The same scopes, confirmation and audit for every listing.",
      },
    ],
  },
];
