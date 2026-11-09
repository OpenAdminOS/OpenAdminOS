---
title: "First run"
description: "What happens the first time OpenAdminOS starts: a scan for models on this device, then Microsoft 365, then Chat."
---

# First Run

The first time OpenAdminOS starts, it takes you through two steps, shown as **1 Model** and **2 Microsoft 365** at the top: it checks this device for AI models, then offers to connect Microsoft 365. Both can be skipped. There is no sample data: OpenAdminOS works with your own organization, and Chat only needs a model.

## The Model Scan

One screen checks, all at once:

- **Ollama**: installed, running, which models, and whether OpenAdmin 8B is pulled.
- **LM Studio**: installed, server running, loaded models.
- **Apple Intelligence** on a compatible Mac.
- **Claude Code** and **Codex**: installed and signed in.
- **GitHub Copilot CLI** (installed; its sign-in is checked when you select it), **Gemini CLI** (sign-in not confirmed until you test it), and a saved **Azure OpenAI** deployment.

Each tool appears around your device and resolves to found, not found, or could not check, with one line per check beside it. Press Escape, choose **Skip scan** or click to see the result at once. The scan reads local files and loopback ports and runs each CLI's own version and sign-in status command, which may check the sign-in with its provider. It sends no prompt to any model, and an Ollama or LM Studio endpoint on another machine is not contacted. **What ran**, under the result, lists every target and command.

The result is one choice of what answers in Chat:

- Models on this device come first, and the first one that can answer or be started is selected. Signed-in tools follow, each saying where prompts go, for example "Prompts leave this device through Claude Code; location set by your account". Where that is depends on your account, workspace or deployment: Claude Code can send prompts to Anthropic, Amazon Bedrock or Google Vertex, and on Anthropic's API inference can run in any region unless your workspace restricts it to the US. **What ran** has the detail for each tool. A hosted tool is never selected for you.
- One button follows your choice: **Open Chat** for a ready local model, **Start Ollama and open Chat** for one that is installed but not running (it keeps running after you quit OpenAdminOS), **Use Claude Code** for a signed-in tool, or **Get OpenAdmin 8B** when Ollama has no model yet. A start that fails says why under its row.
- A check that did not answer within 2.5 seconds shows **Retry** on its row.
- With nothing found, the screen shows the command for OpenAdmin 8B (`ollama run openadminos/openadmin-8b`) and all providers.

**Continue without a model** is below the choice. Chat shows the same choice when no model is selected. You can run the scan again from **Settings, Providers**, which shows the same answer for each runtime as the scan, for example "Installed, not running".

## Connect Microsoft 365

The second step shows your device in the centre again, with Intune, Entra and Defender around it. A service that is not connected is dashed.

1. Pick the services you manage. Nothing is picked for you. The step lists the read-only Microsoft Graph permissions those services need, plus the four sign-in permissions.
2. Choose how to connect:
   - **Sign in with Microsoft** opens the connect dialog with your services picked. Choose the app that signs in (the OpenAdminOS app or your own app registration) and sign in in your system browser.
   - **Use our own app registration** opens the same dialog with your own app registration chosen.
   - **Ask an admin to approve** copies a message with the admin consent link for an admin who can grant the permissions. If the clipboard refuses, the message is shown to copy yourself.
3. After a successful sign-in the step shows your organization's name and each connected service with its parts, and **Open Chat** opens Chat with questions for what you connected, for example **Ask about Intune**.

**Not now** opens Chat without connecting anything. If sign-in cannot reach Microsoft, for example offline or behind a proxy, the connect dialog names the host, whether a proxy was in the path and what to do next, and the step stays open. You can open this step again from **Connections** with **Set up Microsoft 365**.

## Chat Without an Organization

If you chose **Not now**, Chat opens with nothing connected. Questions about products, KQL, PowerShell and documentation are answered from the model, the local docs index and any public references you add. A question about your own devices or users answers with a card that names the service it needs (for example Intune), the exact read permissions, and three ways forward: **Connect**, **Use our own app registration**, or **Ask an admin to approve**, which copies a message with the admin consent link. No tenant data is read, your question is kept, and after connecting you choose **Ask again**.

The empty Chat suggests public references such as Microsoft Learn, each with the host it sends question words to. None is added until you add it through the Marketplace install review.

With a hosted model and nothing connected, the first question asks you to confirm, above the composer so your question stays in view: where it goes (for example "Claude Code · location set by your account", with what that location depends on), what is sent (your question and the conversation, and results from references you added) and what stays on this device. You can choose not to be asked again for that model. The first question after you connect a tenant asks again with the tenant-bound confirmation.

If a sign-in, the Marketplace or a model download cannot reach the internet, the message names the host that could not be reached, whether this device has a system proxy (OpenAdminOS connects directly; Ollama uses the proxy set in its own environment) and what to do next.

## Connecting Your Tenant

When you connect from the Connect Microsoft 365 step, Chat's card, the organization menu or Connections, or start an agent without an active organization:

1. Choose the app that signs in (the OpenAdminOS app or your own app registration), then review the read-only Microsoft Graph permissions by service. See [Authentication and permissions](../trust/authentication.md).
2. Complete Microsoft sign-in in your system browser.
3. Pick or repair an LLM provider if the action needs one.
4. Review and explicitly resume the original action.

After sign-in, OpenAdminOS shows which enterprise application was added to your tenant and how many delegated permissions it holds. Canceling keeps a Chat draft but discards the pending action. OpenAdminOS never sends a question or starts an agent automatically after sign-in, and an agent that reads a service cannot start until that service is connected in the active organization.

## Provider Choice

Local providers (Ollama, LM Studio, Apple Intelligence) keep prompts and tenant data on the device. Hosted providers (Claude Code, Codex, GitHub Copilot CLI, Gemini CLI, Azure OpenAI) send prompts off the device because the selected model is hosted. The CLI-backed providers reuse the vendor CLI's existing authentication instead of storing an API key.

If you have not picked a provider, OpenAdminOS selects a ready local provider automatically. A detected hosted provider is suggested with a note about where data goes, and you choose it explicitly. The UI changes its data-residency messaging based on the active provider.
