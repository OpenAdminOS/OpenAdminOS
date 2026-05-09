export const homeStats = {
  runsThisWeek: 28,
  runsLastWeek: 19,
  timeSavedHours: 14.6,
  costSpent: "$0.00",
  costLabel: "Local · Ollama",
  itemsResolved: 340,
};

// 7-day run counts (oldest → newest). Friday was a compliance-drop incident; the
// rest of the week is investigation + cleanup tailing off.
export const runsByDay = [2, 3, 2, 3, 9, 6, 3];
export const runsByDayLabels = ["M", "T", "W", "T", "F", "S", "S"];

// Most-recent-first. Tells a coherent investigation story:
// Friday's compliance dip triggered audits, today is still cleaning up.
export const recentActivity = [
  {
    agent: "Find inactive devices",
    when: "2h ago",
    result: "47 devices flagged",
    status: "ok" as const,
  },
  {
    agent: "Encryption status audit",
    when: "5h ago",
    result: "12 devices unencrypted",
    status: "ok" as const,
  },
  {
    agent: "Compliance overview",
    when: "Fri",
    result: "Dropped to 87% — investigated",
    status: "alert" as const,
  },
];
