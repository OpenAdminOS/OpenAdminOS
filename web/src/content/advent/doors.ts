type Door = {
  day: number;
  title: string;
  goal: string;
  needsTenant: boolean;
  draft: boolean;
  steps?: readonly string[];
  question?: string;
  hint?: string;
};

// Choose check answers with a meaningful search space. Avoid counts, yes or no, and multiple choice.
export const doors: readonly Door[] = [
  {
    day: 1, title: "Install OpenAdminOS", goal: "Install the desktop app and find the version you are running.",
    needsTenant: false, draft: true,
    steps: [
      "Download the installer for your operating system and install OpenAdminOS.",
      "Open OpenAdminOS. You can leave Microsoft 365 disconnected for this door.",
      "Open Settings, then About. Read the value next to Version.",
    ],
    question: "What version appears in Settings, About?",
    hint: "That is not what the app shows. Check the Version row in step 3.",
  },
  {
    day: 2, title: "Choose a model", goal: "Run the model scan and see where prompts go with the model you choose.",
    needsTenant: false, draft: true,
    steps: [
      "Open the model scan on first launch, or select Scan again in Settings, Providers.",
      "Choose a ready model. You can use a local runtime or a hosted provider you are already signed in to.",
      "In Chat, look at the status strip at the bottom of the window. Read the prompt destination beside the model.",
    ],
    question: "What does the status strip say about where prompts go?",
    hint: "That is not what the app shows. Check the prompt destination in step 3.",
  },
  {
    day: 3, title: "Ask your first Chat question", goal: "Get a documentation answer and check which article it cites.",
    needsTenant: false, draft: true,
    steps: [
      "Open Chat. If it offers Add Microsoft Learn, select it and review the installation.",
      "Ask: Using Microsoft Learn only, what do I need to do before enrolling an Android Enterprise dedicated device in Intune? Cite the article you used.",
      "In Sources under the answer, read the title of the first cited Microsoft Learn article.",
    ],
    question: "What is the title of the first cited Microsoft Learn article?",
    hint: "That is not what the app shows. Check the first citation in step 3.",
  },
  {
    day: 4, title: "Add the Microsoft 365 roadmap", goal: "Add the public roadmap reference so Chat can consult it.",
    needsTenant: false, draft: true,
    steps: [
      "Open Marketplace and select MCP tools.",
      "Find the Microsoft listing whose description mentions the Microsoft 365 roadmap and Azure updates. Open its details.",
      "Select Install, review the connection details, and select Install again. Read the server name at the top of the details.",
    ],
    question: "What is the server name shown in the listing?",
    hint: "That is not what the app shows. Check the server name in step 3.",
  },
  {
    day: 5, title: "Ask about the Intune roadmap", goal: "Use the installed roadmap reference in Chat and find where the query went.",
    needsTenant: false, draft: true,
    steps: [
      "Open Chat after installing the roadmap reference from door 4.",
      "Ask: Use the Microsoft 365 roadmap MCP tool to find upcoming Intune changes. List up to three items with their dates and sources.",
      "Expand the answer’s steps, find the roadmap tool call and read the host on the MCP tool line.",
    ],
    question: "What host appears on the MCP tool line for the roadmap call?",
    hint: "That is not what the app shows. Check the host in step 3.",
  },
  {
    day: 6, title: "Inspect an agent’s permissions", goal: "Read the permissions and mode of a Marketplace agent before installing it.",
    needsTenant: false, draft: true,
    steps: [
      "Open Marketplace, select Agents and search for Find inactive devices.",
      "Open the listing and read its mode near the title. Leave the agent uninstalled for this door.",
      "Open Permissions. Read the exact name of the first Microsoft Graph scope in the list.",
    ],
    question: "What is the exact name of the first Microsoft Graph scope listed under Permissions for Find inactive devices?",
    hint: "That is not what the app shows. Check the exact spelling of the first scope in step 3.",
  },
  {
    day: 7, title: "Try the OpenAdmin 8B local model", goal: "Install OpenAdmin 8B in Ollama if your hardware can run it. This door is optional.",
    needsTenant: false, draft: true,
    // TODO(ugur): Confirm where the release build displays the full Ollama model identifier.
    steps: [
      "Start Ollama and open the model choice in Chat. Select Get OpenAdmin 8B if offered.",
      "Follow the Ollama instructions shown in the app. Wait for the download to finish, then select Scan again.",
      "Open Settings, then Providers. Select Details for Ollama and find the model under Models. Hover over it if it shows a shorter name.",
    ],
    question: "What is the full Ollama model identifier shown in Providers?",
    hint: "That is not what the app shows. Check the full identifier in step 3.",
  },
  { day: 8, title: "Connect Microsoft 365", goal: "Connect an organisation using read-only permissions.", needsTenant: true, draft: true },
  { day: 9, title: "Ask about your tenant", goal: "Ask Chat your first question about your connected Microsoft 365 tenant.", needsTenant: true, draft: true },
  { day: 10, title: "Run a tenant health report", goal: "Run Tenant health report and review its results.", needsTenant: true, draft: true },
  { day: 11, title: "Find inactive devices", goal: "Install Find inactive devices and run it against your tenant.", needsTenant: true, draft: true },
  { day: 12, title: "Inspect your local cache", goal: "See what is cached on this device and where to clear it.", needsTenant: true, draft: true },
  { day: 13, title: "Read a proposed change", goal: "Open a write agent, review its proposed changes and cancel at confirmation.", needsTenant: true, draft: true },
  { day: 14, title: "Review tenant drift", goal: "Open Changes and review a change in your connected tenant.", needsTenant: true, draft: true },
  { day: 15, title: "Schedule an agent", goal: "Set a schedule for an agent you want to run regularly.", needsTenant: true, draft: true },
  { day: 16, title: "Deliver a result", goal: "Deliver an agent result to Teams, Slack or Outlook.", needsTenant: true, draft: true },
  { day: 17, title: "Ask the Agent Team", goal: "Ask the Agent Team a documentation question.", needsTenant: false, draft: true },
  { day: 18, title: "Organise your conversations", goal: "Move related conversations into a workspace.", needsTenant: false, draft: true },
  { day: 19, title: "Turn on the menu bar companion", goal: "Enable the companion and open it from the menu bar.", needsTenant: false, draft: true },
  { day: 20, title: "Review the privacy screen", goal: "Read what is sent from the app and what stays on this device.", needsTenant: false, draft: true },
  { day: 21, title: "Draft your own agent", goal: "Draft an agent for a task you repeat.", needsTenant: false, draft: true },
  {
    day: 22, title: "Send feedback", goal: "Tell us what worked or what got in the way.",
    needsTenant: false, draft: true,
    steps: ["Think of one thing you tried in OpenAdminOS during the campaign.", "Describe what worked or where you got stuck in the form below. Leave out tenant data and personal details."],
    question: "What would you keep or change?",
  },
  { day: 23, title: "Export a year-end report", goal: "Export a tenant report to keep for your year-end review.", needsTenant: true, draft: true },
  {
    day: 24, title: "Share your badge", goal: "Make your Advent progress public and open the page you can share.",
    needsTenant: false, draft: true,
    steps: ["Open My Advent and enable Public badge under Settings.", "Open your public badge page, then return here to complete the door."],
    question: "Is your badge page public?",
  },
];
