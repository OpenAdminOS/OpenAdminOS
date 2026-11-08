---
title: "Organizations and Connections"
description: "How OpenAdminOS groups each company you manage into an organization, and what the Connections page shows."
---

# Organizations and Connections

An organization is a company you manage. It holds one Microsoft 365 tenant today, and later one instance of each other service it runs. Runs, conversations, the local cache, change history and schedules belong to one organization and never mix with another.

## Organizations

- **Created by the first connection.** Connecting a Microsoft 365 tenant creates an organization named after the tenant. Rename it in **Connections**, under **Organizations on this device**. Connecting the same tenant again uses the same organization.
- **One active at a time.** The organization menu in the top bar shows each organization with the services it has connected. Choose one to make it active, or choose **No organization**.
- **No organization** is a valid state. Chat still answers from the docs and the public references you added. Agents that read a service wait until an organization with that service is active.
- **Sample data.** **Preview with sample data** in the organization menu opens the sample organization: a fictional company with built-in data and no Microsoft sign-in. It is removed after your first real connection.
- **Disconnecting** Microsoft 365 removes the organization and deletes its local data from this device. Data in the tenant is not changed.

## Connections

**Connections** is in the sidebar after **Marketplace**, and **Manage connections** in the organization menu opens it. It replaces Settings, Tenants and Settings, Connectors. Old links to those pages open Connections.

The map at the top shows what the active organization reads into this device and everything that leaves it:

| Part of the map | What it lists |
|---|---|
| Read from your services | Each Microsoft 365 service with **Connected**, the number of parts granted, or **Not connected** |
| This device | The model, chat history and cache, and the encrypted sign-in tokens |
| Words from your questions | The hosts of the public references Chat can query. Nothing, when none is on |
| Run reports, by delivery rule | The result connectors that at least one agent sends reports to under a saved delivery rule |
| Prompts and tenant data | The hosted provider when the model is hosted, or nowhere when the model is local |

The map uses the same lists as the status strip in the top bar, and a screen reader reads the same facts as one paragraph.

Below the map:

- **Services**: Intune, Entra and Defender with their parts. **Connect** adds a service, **Add** with a part name adds one missing part, and **Check again** reads the permissions of your own app registration again. See [Connect with the shared app](connect-shared-app.md) and [Own app registration](own-app-registration.md).
- **Other services**: services from other vendors appear in the Marketplace when they ship.
- **Public references**: the reference servers you added from the Marketplace, with the host each one receives question words from. They are used in every organization and receive no Graph or cache data.
- **Results go to**: the result connectors such as Microsoft Teams, Outlook and Slack. See [Connectors](../connectors/README.md).
- **Saved app registrations** you connected with before.

## Agents and organizations

Every agent shows the services it reads. With everything connected the action says **Run**; otherwise it names what is missing, for example **Connect Defender** or **Add sign-in logs**. Starting an agent with no organization opens its run review, which names the services the agent needs. Only an agent that calls no service API at all, not even the Microsoft sign-in, is labeled **No service needed** and runs without an organization.

## Schedules

Each schedule belongs to one organization and runs only while that organization is active. A new schedule belongs to the organization that was active when you created it. The schedule card shows its organization, or **Unassigned** with an **Assign** action.

When you update from a version before organizations, schedules move to the organization of the real tenant that was active, and the schedules list says so. If no tenant or the pilot tenant was active, schedules stay paused and unassigned until you assign each one. They are never assigned to the sample organization.
