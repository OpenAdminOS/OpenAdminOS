---
title: "Marketplace"
description: "Registry agents and public, read-only MCP servers that Chat can call."
---

# Marketplace

The Marketplace lists registry agents and remote MCP servers. MCP servers are public reference sources: they need no sign-in, never connect to your tenant and cannot propose changes. Once a server is installed and on, Chat can call its tools with any provider, as long as the model is large enough for tool use.

## What leaves the device

A server receives only the query Chat sends it. That query is written in a separate step from your current question, never from Graph or cache data, earlier messages or tenant values. Words from your question can still reach the server, so a filter blocks known tenant names, IDs, email addresses and IP addresses before anything is sent. The filter cannot guarantee it catches every private detail. Every query is shown in its Chat step, and the status strip names each host that can receive one while its server is on.

Results come back as third-party reference material. Chat numbers and cites them, and never treats them as instructions or as facts about your tenant.

## Servers

| Server | Host | Publisher | Used for | Tools offered |
| --- | --- | --- | --- | --- |
| Microsoft Learn | learn.microsoft.com | Microsoft | Official documentation and code samples | Every tool the server lists |
| KQL Search | www.kqlsearch.com | KQL Search | Community KQL examples | Every tool the server lists |
| IntuneAutomation | www.intuneautomation.com | IntuneAutomation | PowerShell scripts for Intune automation | Every tool the server lists |
| Microsoft Release Communications | www.microsoft.com | Microsoft | Microsoft 365 roadmap items and Azure updates, including retirements | `get_recent_m365_roadmaps`, `get_m365_roadmap_by_id`, `get_recent_azure_updates`, `get_azure_update_by_id` |
| WindowsForum | mcp.windowsforum.com | WindowsForum.com | Windows update KB articles, release dates and known issues | `search_kb`, `get_kb_article` |
| Splashtop Docs MCP | support-splashtopbusiness.splashtop.com | Splashtop | Answers questions from the Splashtop documentation, with links to the articles. Built into OpenAdminOS | `search_articles`, `get_article` |
| endoflife.ai | mcp.endoflife.ai | EndofLife AI Inc. | End-of-life and end-of-support dates, lifecycles, upgrade paths, CISA KEV exposure | Every tool except `scan_stack` and `check_sbom` |

The **Splashtop** listing is a connection, not a reference: it opens the connect step on **Connections**, where the Splashtop Open API is connected to one organization with an API token. See [Splashtop](../services/splashtop.md).

## Tool allowlists

Some servers list more tools than OpenAdminOS needs. For those, the catalog names the tools that are offered. Other tools are never shown in the Marketplace, never offered to Chat and never called: a call to one is refused before anything is sent.

- **WindowsForum** lists 29 tools, including forum search and member lookups. Only the two Knowledge Base tools are offered, because Chat needs update articles, not forum or member data.
- **endoflife.ai** offers everything except `scan_stack` and `check_sbom`. Those take a whole software inventory or bill of materials, which would send a list of what runs in your estate.
- **Release Communications** offers all four of its tools.

If a server stops listing an offered tool, its card says "Installed · tools missing", its details name the missing tools, and Chat does not use the server until Check connection finds every offered tool again. Chat also notices this on its own: when a call opens a new session, for example after a restart, and the server no longer lists an offered tool, the call is refused before anything is sent, the answer says which tool is missing, and the card changes to "Installed · tools missing".

## Item IDs

A roadmap ID, an Azure update ID or a KB number is sent only when it appears in your question or in an earlier result from the same server in the same answer. Chat does not guess IDs. Links work the same way: a page link is sent only as an earlier result of that server listed it.

Each ID must have its tool's form: roadmap IDs are digits, Azure update IDs are digits or an older post's lowercase name such as `2021regions`, and KB numbers are digits with an optional KB prefix. Your question is read as separate tokens, so "109560-109561" names two roadmap items and never 109560109561. "KB5034441" and "5034441" are the same article; no other spelling counts.

The same rule covers filters. Release Communications' list tools take an OData filter such as `status eq 'Rolling out'`. Chat reads the filter before sending it: any comparison on `id` or `baseId` must name an ID from your question or an earlier result, and a filter Chat cannot read, such as plain words, is not sent. The Chat step says why. A blank filter is left out, as if none was written.

## Who runs each server

The install review names the operator, links its terms or privacy page where one exists, and lists the tools that will be offered.

- **Microsoft Release Communications** is run by Microsoft. The Microsoft API Terms of Use apply.
- **WindowsForum** says it is run by Fara Technologies LLC as an independent community, not affiliated with Microsoft. Its results are community text: treat them as third-party reference that can be wrong or out of date.
- **endoflife.ai** is run by EndofLife AI Inc., an Alberta (Canada) corporation, according to its privacy policy and terms. The privacy policy says it records the tool name and outcome of each call, and the product name when a call fails, but not the questions and answers of successful calls. Its terms cover using the data for your own IT estate; reporting on other organisations needs a data licence from the operator.

## Which server Chat asks

Naming a server in a question calls it, for example "Ask endoflife.ai about Windows Server 2016". A host counts as a name only when it belongs to that server: Release Communications runs on www.microsoft.com, which serves much more, so "microsoft.com" in a question does not call it. Its name, its aliases and its full address with the path still do. WindowsForum runs on mcp.windowsforum.com, and "windowsforum.com" names it too. For documentation questions, topic words choose a server:

- roadmap, retirement, what's new, rollout, Azure update: Microsoft Release Communications
- KB, cumulative update, known issue, patch, update history: WindowsForum
- end of life, end of support, lifecycle, EOL, support ends: endoflife.ai

Other documentation questions go to Microsoft Learn when it is installed.

## Empty answers and errors

When a server answers with nothing, the Chat step names it, for example "WindowsForum found nothing", and the answer says so instead of citing anything. When a server answers with an error, the step reads, for example, "endoflife.ai returned an error" with the server's message. When a server cannot be reached, the step reads "Could not reach" and the server name. Nothing fails silently.

## Long lists

Chat lists at most ten records from one result as sources. When a result holds more, or the server says it has more, Chat does not present the list as complete:

- The step says so, for example "10 of 33 results" or "10 of 50 results · the server has more".
- The model is given the server's own counts, such as `totalCount` and `hasMore`, and how many records were left out, and is told to say how many are shown, for example "Showing 10 of 515".
- When the tool can page, as Release Communications' list tools can with `skip`, a further call in the same answer can ask for the next page.

Records that cite one page, such as the CVEs of an endoflife.ai KEV answer, share one source number, and each keeps its own ID and name in what the model reads.
