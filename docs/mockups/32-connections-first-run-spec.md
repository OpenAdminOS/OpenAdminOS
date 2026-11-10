# Redesign spec: first run without sign-in (PR #175) and organizations with Connections (PR #174)

Reference mockup: `32-connections-first-run.html` (revision 2) in this folder. Section letters below match it.
Priorities: **M** must ship before merge, **S** should ship in these PRs, **C** could follow later.

## 0. Principles for both PRs

1. One figure, one product. Both PRs draw the same thing: this device in the center, the models it can use around it (scan), the services it reads and the places data goes (Connections). Build it once:
   - `DeviceTile` (new shared component): fill `--color-accent`, oa mark in `--color-on-accent`. Sizes: `xl` 104 px, radius 28 px, shadow `0 18px 40px -18px rgba(0,0,0,.45)`; `lg` 72 px, radius 20 px; `sm` 40 px, radius 12 px. This replaces the scan's white or graphite tile (`.scan-device`) and the inverted "This device" text slab (`.reach-device`). **M**
   - `ServiceMark`: keep the production `.svc-mark`. Not connected is always `data-off` (dashed 1 px `--color-border-strong`, letters `--color-text-muted`), everywhere: reach map, service rows, agent chips, the not-connected card, the review dialog. **M**
   - Connector line: 1.25 px, `--color-text-faint`. Incoming solid, outgoing dashed 3/4. A missing service uses `--color-border`. Only a line that carries prompts to a hosted provider is `--color-warning`, solid. The scan uses the same rule: a local model's link is `--color-success`, a hosted tool's link is `--color-warning`. **M**
2. Colour means one thing each. Green means it stays on this device. Amber means it leaves this device (SPEC section 3). Today amber also marks "Partial", "Entra sign-in logs" and the scan's "Signed in" labels, and green marks "Works now". Change those to neutral text with a dot or dashed mark; the action button carries the fix. The one other amber use is an operational warning with a fixing action (background runs off). **M**
3. One filled button per view (SPEC section 3), and it is the next step. Today the scan result has nine actions and the run review has a disabled filled button as its main action. **M**
4. Type stays on the production scale: 12, 13, 14, 16, 24, 34, answer 17.5; weights 400/500/600; letter spacing 0. Remove `text-[2.75rem]`, `text-[3.25rem]`, `text-[1.65rem]`, `text-[15px]`, `text-[13px]`, `11.5px`, `tracking-[-0.022em]` and `tracking-[-0.025em]` from `FirstRunScan.tsx` and the `.reach-*` CSS. The scan title uses `text-display` (34/42 Newsreader 500). **M**
5. Radii come from tokens: `rounded-sm` 8, `rounded-md` 10, `rounded-lg` 14, `rounded-xl` 18 (dialogs only). Replace `rounded-2xl` (Tailwind's 16) in `ChatFirstRun.tsx`, `border-radius: 16px` and `9px` in `.reach-*`. Cards and grouped surfaces use `rounded-lg`. **M**
6. One vocabulary across both PRs. PR #175 still says "No tenant", "0 tenants", "No active tenant"; PR #174 says "No organization". Provider names differ between the scan ("Claude Code", "Codex", "Apple Intelligence", "Gemini CLI") and Settings ("Anthropic, Hosted via CLI", "OpenAI Codex", "Apple Foundation", "Google Gemini"). Use organization everywhere once #174 lands. For a CLI tool, the name is the tool and the destination is the provider: "Claude Code", where line "Prompts go to Anthropic API · US". **M**
7. Proposed motion tokens. These name values the code already uses; there are no new colours. Add to `globals.css`: **S**
   ```css
   --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);      /* companion-rise today */
   --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);   /* scan-link-draw today */
   --ease-spring: cubic-bezier(0.34, 1.36, 0.64, 1);/* replaces 1.56 overshoot */
   --dur-fast: 140ms; --dur-state: 240ms; --dur-enter: 420ms;
   ```
   Reduced motion keeps the existing global 0.01 ms rule. Every orchestrated sequence below must also render its final state directly when `data-motion="reduced"`.

## A. First launch: the scan, while checking (PR #175)

Layout at 1280 x 800 (960 is the same grid with 32 px gaps):
```
| oa OpenAdminOS (Newsreader 16)                                  Skip scan |
|                                                                           |
|      [orbit, square, min(520px, 100cqh-100px)]   Looking for models on   |
|        8 nodes on r=38%, DeviceTile xl center      this device  (34/42)  |
|        sweep + 2 rings while checking              one sentence (14/21)  |
|                                                    6 of 8 checked ====-- |
|                                                    . Ollama   Installed..|
|                                                    . ... 8 rows x 32 px  |
```
- Grid: `grid-cols-[7fr_5fr]`, gap 48 px (32 px below 1000 px window), padding 0 48 px, `max-w-[1180px]`, both columns vertically centered. The right column has `max-w-[440px]`. **M**
- Intro copy, one sentence: "Checks the model runtimes and AI tools on this device, and whether you are signed in to them. Nothing is sent to a model." The full technical sentence moves to "What ran". **M**
- Progress: 13 px muted tabular text plus an 8-segment bar (3 px high, 3 px gap, max 200 px, `--color-border`, a resolved segment `--color-text-muted`). It replaces the 26 px serif counter. **S**
- Check list: one line per probe, 32 px rows, hairline dividers. 8 px mark, name 13/400, status right-aligned 13 `--color-text-soft`. No buttons, no monospace targets, no second line during the scan. The list stays the `aria-live` source. **M**
- Node: 44 px circle (not 56), monogram 13/600. Label 13/500 and status 12/400 sit on a plate (`background: var(--color-bg)`, padding 0 6 px, radius 6 px) so the orbit line never crosses text. **M**
- Node states: checking has a dashed `--color-border-strong` border and the breathe animation. Installed, not running has a 1.5 px `--color-success` ring. Ready local is filled `--color-success` with letters in `--color-bg`. Ready hosted is filled `--color-warning-soft` with a 1.5 px `--color-warning` ring and amber letters. Not found has a 1 px `--color-border` ring and faint letters. **M**
- When the scan settles, not-found nodes shrink to 32 px and drop their status line. Their name uses `--color-text-muted`, never `opacity: .32`: today "Not installed" fails contrast. **M**
- Motion, about 2.4 s total: **S**
  - Device tile: scale .92 to 1, opacity 0 to 1, 360 ms `--ease-spring`.
  - Two rings radiate from scale .32 to 1.08 every 1.8 s `--ease-out`, offset .9 s (today there are three).
  - The sweep is a 40 degree conic wedge, `color-mix(in srgb, var(--color-text) 9%, transparent)` at its leading edge, turning in 2.2 s linear. It replaces the single line. This is the one gradient on the screen, and it has a job (radar).
  - Nodes enter staggered 60 ms, opacity and scale .8 to 1 in 240/320 ms `--ease-spring`. On resolve, the node pops 1 to 1.1 to 1 in 280 ms and, if found, its link draws 420 ms `--ease-in-out`.
  - Settle: rings and sweep fade in 300 ms; the result column children rise 8 px and fade in 420 ms `--ease-out`, staggered 60 ms.
  - Skip scan, a click on the stage, or any key settles at once.
- Header: the wordmark in Newsreader 500 16 px (SPEC wordmark), "Skip" renamed "Skip scan", ghost sm button. **S**

## B. First launch: the result (PR #175)

```
|  [orbit, settled; selected node gets a 2px    4 of 8 found on this device |
|   ring offset 3px; its link 2.25px full       Choose what answers in Chat |
|   colour, others 50%]                         Models on this device keep..|
|                                               ( ) Ollama        Not running|
|                                                   On this device. ...      |
|                                               ( ) LM Studio                |
|                                               ( ) Claude Code     Signed in|
|                                                   Prompts go to Anthropic..|
|                                               ( ) Codex                    |
|                                               [Start Ollama and open Chat] |
|                                               Ollama keeps running after...|
|                                               --------------------------- |
|                                               Continue without a model     |
|                                               Preview with sample data     |
|                                               What ran +   Scan again      |
```
- Replace the nine actions (Use Claude Code, Use Codex, Start Ollama twice, Start LM Studio, Continue to Chat without a model, Preview with sample data, Scan again, Skip) with one radio group of found options and one filled button. **M**
- Order: local runtimes first, then signed-in tools. Preselect the first local option that can answer or be started. Never preselect a hosted tool; this keeps the rule that a hosted tool needs one explicit choice. With only hosted options found, nothing is preselected and the button reads "Choose a model", disabled, until a row is picked. **M**
- Row: 16 px radio, name 14/500, where line 13 (`--color-text-soft` for local; `--color-warning` for hosted, "Prompts go to Anthropic API · US"), state 12 muted on the right. Row padding 10 x 12, radius `rounded-md`, hover `--color-hover`, checked `--color-active`. Group surface `--color-surface`, `rounded-lg`, inset 1 px `--color-border-soft`, padding 4. **M**
- The button label follows the selection: "Start Ollama and open Chat", "Start LM Studio and open Chat", "Use Claude Code", "Use Codex"; for a ready local model, "Open Chat". It is a `lg` 36 px button. A note under it in 12 muted: "Ollama keeps running after you quit OpenAdminOS." or "Uses your Claude Code sign-in. No API key is stored." While starting, a 16 px spinner sits inside the button and the label stays. A failed start writes the reason under that row in 12 `--color-danger`, not a banner. **M**
- Selection is mirrored in the orbit: the selected node gets `outline: 2px solid var(--color-text); outline-offset: 3px`, and its link goes to full opacity at 2.25 px. Found nodes are clickable and select their row. **S**
- Quiet alternatives below a hairline: "Continue without a model" and "Preview with sample data" as text links, 13 px. Footer in 12 muted: a "What ran" disclosure (the targets, the commands and the "No prompt was sent" ledger) and "Scan again". **M**
- Titles per outcome: "OpenAdmin 8B is ready on this device" (Open Chat); "Choose what answers in Chat" (several found); "No model on this device yet" (body with the `ollama run` command in a code block, then "Show all providers"). Drop "It is not selected until you choose it, because prompts leave this device when it answers." **M**
- The in-chat "Choose a model to answer with" card (`ModelChoice` in `ChatFirstRun.tsx`) reuses this exact choice list, so first launch and Chat show the same choice the same way. Today it is a card of nested cards with a white filled "Set up" button and different provider names. **S**

## C. Empty Chat, no organization (PR #175)

- Remove the duplicate trust lines. Today the page states the destination three times: the model line under the subtitle, the amber paragraph under the composer, and the top bar chip. Keep the chip and one 12 px line under the composer: "Prompts go to Anthropic API · US. Nothing is connected, so no tenant data is sent." Delete "Answering with ... through ... Change model"; the composer's model menu already does that. **M**
- Starters become two columns of plain rows ("Works now", and "Needs Intune" with a dashed 17 px service mark), heading 13/500 `--color-text-soft`. Each row is a 40 px button with no border and a hover fill `--color-hover`. It replaces the 4 bordered cards with a green "Works now" label. One column below 600 px of content width. **M**
- Public references become a divided list under a hairline, not a card. Heading 13/500 with "Hide" as a ghost sm button; a 12 px hint; rows of 22 px mark, name 14, "Questions go to host" 12 muted, "Add" secondary sm. Show 2 rows and "4 more in the Marketplace". **S**
- Composer toolbar: replace "No active tenant" with the organization chip vocabulary from #174, or remove it from the composer, since the top bar owns scope. **M** (vocabulary), **C** (removal)

## D. First send to a hosted model, no organization (PR #175)

Today this is a modal of five filled tiles, an amber callout and a "What leaves this device" box that repeats it, plus a checkbox. At 960 x 720 the Send and Cancel buttons are cut off (see `before/175-hosted-confirm-960-*`). **M**
- Make it an inline confirmation above the composer (popover surface `--color-surface`, `--shadow-pop`, `rounded-lg`, padding 16 x 18), so the typed question stays visible and nothing can be cut off. **M**
- Content: a title, 14/500, "Send this question to Anthropic?"; one sentence of 13 soft text, "Claude Code answers through Anthropic. Nothing is connected, so no tenant data is included."; a 2-column definition list in 13 px: Goes to, "Anthropic API · US" in amber; What is sent, "Your question and this conversation" (add "and results from the references you added" when on); Stays here, "Chat history". Then the checkbox "Do not ask again for questions without an organization on claude-sonnet-5". Actions: primary "Send to Anthropic", ghost "Cancel", a link on the right "Use a model on this device". **M**
- Enter sends, Escape cancels and returns focus to the composer; entry 240 ms rise. **S**

## E. Not-connected card in an answer (PR #175)

- Use the Intune service mark (30 px, `data-off`) instead of the generic shield. Title 16/500 "This needs Intune". **M**
- Fold the permissions behind a disclosure, "7 read-only Microsoft Graph permissions"; open it to show grouped mono lists. Nine monospace chips no longer lead the card. **S**
- Actions in weight order: primary "Connect Intune", secondary "Use our own app registration", ghost "Ask an admin to approve". The fine print stays at 12 muted. Indent body, permissions and actions 42 px to align with the title. **M**
- Remove "Other Intune parts (users and groups, apps) can be added now or later." from the card; the connect dialog says it. **C**

## F. Connections with an organization (PR #174)

```
| Woodgrove Bank connections (24 serif)                                      |
| What Chat and agents can read ...                                          |
| +-----------------------------------------------------------------------+ |
| | Reads from                         .-.       Leaves this device         | |
| | [In] Intune   . Connected   ~~~~> | oa | ~~> Prompts and tenant data    | |
| | [En] Entra    o 4 of 6 parts ~~~> |    | --> [An] Anthropic API · US    | |
| | [De] Defender o Not connected ~~> '-'   --> Words from questions        | |
| |                                This device     learn.microsoft.com     | |
| |                          History, cache and    www.kqlsearch.com       | |
| |                          sign-in tokens stay   Run reports             | |
| |                                                 Microsoft Teams  IT Ops | |
| +-----------------------------------------------------------------------+ |
| Services  ...  Microsoft 365  woodgrove.example, signed in as ... Manage v |
| [In] Intune ... parts                       . Connected     Permissions   |
| [En] Entra  ... parts (2 hollow)            o 4 of 6 parts  [Add access]  |
| [De] Defender                               o Not connected [Connect]     |
```
- Reach map grid (revised 2026-11-10): `minmax(0,max-content) 128px minmax(0,440px)`, centred as one block, column gap 76 px, padding 20/24/28, one surface (`--color-surface`, `rounded-lg`, inset `--color-border-soft`). Center: `DeviceTile lg`, with a 128 px caption absolutely positioned under it so the tile sits on the row midline: "This device" 13/500, then 12 muted "History, cache and sign-in tokens stay here". The model name moves to the prompts row on the right. **M**
- Rows are plain 32 px lines (22 px mark, name 13, state 13), not boxed pills. Wide: the services sit next to the tile with names and states in columns, and a model name follows its destination. Stacked: the state sits at the right edge. A reference host or result connector shows its owner's logo on the mark, two letters when OpenAdminOS has none. Group labels 12 muted. The zone titles are "Reads from" and "Leaves this device", 13/500. **M**
- Connectors (revised 2026-11-10): SVG computed from row and tile rects (cubic curve that meets the row at its mark, runs level from the tile until it is 2 px past the caption under the tile, then bends 35 percent of the way from the row, so it stays out of the caption with any number of rows), fanned 9 px apart at the tile edge and tighter when the ends would leave it, colours per section 0. Redraw on resize and theme change. On first paint they draw once, 420 ms `--ease-in-out` with a 40 ms stagger (incoming and hosted lines; dashed lines fade in). After that they only redraw for a row whose state changed. Reduced motion draws them static. The `figcaption` text alternative stays as today. **S**
- Below 760 px of content width (the 960 window with the sidebar open), stack the map: Reads from, then a 40 px device row with its caption to the right between hairlines, then Leaves this device. Drop the connectors there. Today at 960 the black slab and arrows fill the first screen. **M**
- Microsoft 365 group row: the name 14/500, then "domain, signed in as user" 13 soft, then a "Manage" ghost menu: Permissions, Rename organization, a separator, Disconnect (danger, opens the existing dialog). Today Disconnect sits as a plain text button beside Permissions. Move the license line into the menu or a tooltip. **M**
- Service rows: grid `30px 1fr 132px 120px` so status and action columns align across all rows. Parts are 12 px text with a 6 px dot, filled for granted, hollow for missing; no pills. Status is a dot plus words; "Partial" becomes "4 of 6 parts". **M**
- Remove planned connectors ("Considering", "View details") from "Results go to". The 2026-11-04 decision keeps planned services in the docs only, and they read as unfinished here. **M**
- "Organizations on this device" and "Saved app registrations" do not belong on a page titled "Woodgrove Bank connections". Move them to a second tab on Connections, "All organizations", or to Settings. The page header loses its "Add organization" button; the switcher has it. **S** (flag for the flow reviewer)
- Top bar boundary chip: one sentence, never truncated by "+1". At window widths up to 1100 px it reads "Anthropic API · US +2 references"; wider, "Prompts and tenant data go to Anthropic API · US +2 references". Click opens Connections. **S**

## G. Connections with no organization (PR #174)

- Replace the info notice and the empty map with an empty state, above the fold at 960 x 720: dashed service marks, a short dashed wire, `DeviceTile lg`, a wire, reference marks. Then the title "No organization connected" (24 serif) and the body "Chat answers from the model and public references. Connect Microsoft 365 to read Intune, Entra and Defender for an organization." Primary `lg` "Connect Microsoft 365", secondary `lg` "Preview with sample data". Today the primary button is below the fold even at 1440 x 900. **M**
- Below it, "Leaves this device now": prompts (amber where line, "Change model") and words from questions ("References"). The services list with three "Not connected" rows is removed in this state. **S**
- The page subtitle drops "for this organization" when none is active. **M**

## H. Organization switcher (PR #174)

- Menu 320 px wide, `--color-bg-elevated`, `--shadow-pop`, `rounded-lg`, padding 6. Search field first from 6 organizations ("Find an organization", filters name and domain). Rows are 24 px neutral avatars (two letters, `--color-bg-raised`), name 14, then one 12 muted line of services in words ("Intune, Entra, Defender. Own app registration"), with a check on the active one. **M**
- Remove the per-row remove buttons from the menu; removal lives in the organization list with its dialog. **M**
- The footer items, 13 soft with 14 px icons: Add organization, Preview with sample data (flask icon, not a play triangle), Manage connections. **S**
- No organization gets a dashed 24 px avatar, both in the chip and in the menu. **S**

## I. Agents with service needs (PR #174)

- Drop the identical shield tiles on every row. **M**
- Row: name 14/500, then meta 13 muted with an 8 px gap ("Read-only. Every day"); one-line description 13 soft; a needs row of chips (22 px high, 6 px radius, service mark sm plus name). A missing service or part is a dashed chip ("Defender, not connected", "Sign-in logs, not granted"), never amber. The action on the right is the fix ("Connect Defender", "Add sign-in logs") or "Run". **M**
- Move the two-line usage boilerplate ("About 30 runs per 30 days. Usage counts against ...") to the agent page. **M**

## J. Run review without an organization (PR #174)

- One blocker block at the top: the dashed service mark, a title 14/500 "Needs Intune in an active organization", a 13 soft body, primary "Connect Intune", secondary "Choose organization". **M**
- The facts become a hairline definition list (120 px term column): Organization, Reads, Model (with the 12 px amber where line), Permissions (mono), Changes. This replaces the five filled tiles, the amber callout and the "What happens" box, which repeat each other. **M**
- Footer: a 13 muted hint "Connect Intune to start this run.", ghost Cancel, and Start run as a disabled secondary. It is not the filled primary while blocked. **M**

## K. Schedules after the move (PR #174)

- Order: the persistent warning first (amber soft surface, "Background runs are off. Schedules run only while OpenAdminOS is open.", secondary sm "Turn on"), then the one-time note as plain 13 muted text with an inline "Dismiss" link. Today it is two stacked banners of equal weight. **M**
- Rows: name, then "Every day at 07:00. Woodgrove Bank" muted, then "Next run ... Results go to ..." 13 soft, with Edit. Drop the "Scheduled only" info-blue chip; the tab already says Schedules. **S**

## L. Settings, Providers (PR #175)

- Head the section with `DeviceTile sm`, "On this device", and "Last checked today at 09:14. 4 of 8 found.", with "Scan again" as a secondary sm button. Below it, the same compact check list as A. Scan again runs in place; it does not open the full-window scan. **S**
- Fix the contradiction: Settings says Ollama and LM Studio are "Not installed" while the scan says "Installed, not running" (`before/175-settings-providers-*`). Both must read the same probe result. **M**
- Per-row controls today are a filled badge, an "Active" radio, Test and Details. Reduce them to a status dot and words, plus one action (Use, Start, Test) and an overflow. **C**

## Flow notes (visual or clarity, not process)

1. The scan result asks too many questions at once. Fixed in B with one choice and one button. Decide whether an installed but not running Ollama should be preselected over a signed-in Claude Code. The spec says yes (SPEC: the default provider is local); if Ollama has no model pulled, its row should say "No model yet" and the action becomes "Get OpenAdmin 8B".
2. "Continue without a model" lands on a Chat that asks for a model again (`before/175-chat-empty-*`). Fine, but it must be the same choice list as B, or the user meets two designs for one decision.
3. Vocabulary drift between the PRs (tenant and organization; provider names) is the biggest "two products" tell. Merge order matters: whichever lands second must adopt the other's words.
4. The Connections page mixes one organization's connections with all organizations and saved app registrations. See F.
5. "Preview with sample data" appears in the scan, the switcher, Connections empty and Chat. That is fine as a quiet link; it is never a filled button.
6. Not reviewed: the PR #174 confirmation page; no capture was made of it. The same rules apply: one filled action, facts as a definition list, amber only for destinations.

## Screens and files

| Screen | Before | After (mockup frame) |
|---|---|---|
| A scan running | `before/175-scan-running-1280-{light,dark}.png` | `after/sec-{1280,960}-{light,dark}-00.png` |
| B scan result | `before/175-scan-done-{1280,960}-{light,dark}.png` | `...-01.png` |
| C empty Chat | `before/175-chat-empty-hosted-*`, `before/175-chat-empty-*` | `...-02.png` |
| D hosted confirm | `before/175-hosted-confirm-*` | `...-03.png` |
| E needs a service | `before/175-not-connected-*` | `...-04.png` |
| F Connections | `before/174-connections-*`, `before/174-connections-bottom-*` | `...-05.png` |
| G Connections, none | `before/174-connections-none-*` | `...-06.png` |
| H switcher | `before/174-switcher-960-*` | `...-07.png` |
| I Agents | PR #174 `docs/screenshots/organizations/agents-service-needs-*.png` | `...-08.png` |
| J run review | `before/174-preflight-960-*` | `...-09.png` |
| K schedules | PR #174 `docs/screenshots/organizations/schedules-migrated-*.png` | `...-10.png` |
| L Settings | `before/175-settings-providers-*` | `...-11.png` |

Full-page captures of the mockup: `after/full-{1280,960}-{light,dark}.png`.
