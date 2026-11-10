# Service logos

Product names and logos are trademarks or registered trademarks of their respective owners. OpenAdminOS is not affiliated with, endorsed by, or sponsored by any of them.

To request removal of a logo, contact the maintainers through GitHub issues or the security contact in SECURITY.md.

OpenAdminOS shows each icon beside the service's name to identify the service it connects to: the Microsoft 365 services, vendor services such as Splashtop, the result connectors a run report can be sent to, and the public reference hosts Chat can query. The icons are not covered by the MIT license of OpenAdminOS. Every file is used as its owner provides it: not redrawn, recoloured, cropped or combined with other marks. Microsoft provides one colour file for each of its services, shown on light and dark surfaces alike. Splashtop's square logo has a dark wordmark, so its tile is always white.

| File | Icon | Owner | Source | Retrieved |
|---|---|---|---|---|
| `intune.svg` | Microsoft Intune | Microsoft Corporation | `Azure_Public_Service_Icons/Icons/intune/10329-icon-service-Intune.svg` in https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V25.zip (from https://learn.microsoft.com/en-us/azure/architecture/icons/) | 2026-11-09 |
| `entra-id-color.svg` | Microsoft Entra ID, colour | Microsoft Corporation | `Microsoft Entra architecture icons - Oct 2023/Microsoft Entra color icons SVG/Microsoft Entra ID color icon.svg` in https://download.microsoft.com/download/3/1/a/31a56038-856a-4489-88e4-ee5a1c4352be/Microsoft%20Entra%20architecture%20icons%20-%20Oct%202023.zip (from https://learn.microsoft.com/en-us/entra/architecture/architecture-icons) | 2026-11-09 |
| `defender-for-cloud.svg` | Microsoft Defender for Cloud | Microsoft Corporation | `Azure_Public_Service_Icons/Icons/security/10241-icon-service-Microsoft-Defender-for-Cloud.svg` in the Azure icons archive above. Microsoft publishes no Microsoft Defender XDR icon in its icon downloads; this is its official Defender icon closest to the service OpenAdminOS reads (Defender alerts and incidents, Secure Score). | 2026-11-09 |
| `splashtop-logo-120.png` | Splashtop logo, square (splash icon above the wordmark) | Splashtop Inc. | Digital Artwork section of the Splashtop press kit, https://www.splashtop.com/about/press-kit, file https://images.ctfassets.net/5i1m3im8l2b5/3U4Qlx9ZomodR87DCkRET1/ae2b8f5dd9376247317b7950dbb52804/Splashtop-Logo-120.png (SHA-256 `478e124fa0c4018452ec3fc0d9bda3141767fb6edc61a338d664443e130a8e6e`) | 2026-11-09 |

## Result connectors

Shown on the Connections reach map and on each connector under Results go to. Where an owner publishes a logo download, the file comes from it. Microsoft publishes no download of the current Teams and Outlook icons (its Microsoft 365 icon archive holds content glyphs only, and its Fluent icon CDN still serves the 2019 designs), so those two are the icons Microsoft serves in the web app manifest of each product.

| File | Icon | Owner | Source | Retrieved |
|---|---|---|---|---|
| `microsoft-teams.png` | Microsoft Teams icon, 192 px | Microsoft Corporation | https://teams.public.onecdn.static.microsoft/evergreen-assets/icons/windows/teams-icon-pwa-v2025-192.png, the 192 px icon in the Teams web app manifest https://teams.microsoft.com/v2/manifest.json (SHA-256 `e0016e2812cc669f5db9e7bbf4c02faf37a0a28878be102e19c42739f64e8fcd`) | 2026-11-10 |
| `microsoft-outlook.png` | Microsoft Outlook icon, 192 px | Microsoft Corporation | https://res.public.onecdn.static.microsoft/assets/mail/pwa/v4/pngs/Outlook.192x192.png, the 192 px icon in the Outlook web app manifest https://outlook.office.com/mail/manifests/pwa.json (SHA-256 `68d06094380edcfc542ac141cbe48d23269b1d519ba94264e5b012d975fc9fac`) | 2026-11-10 |
| `slack-mark.svg` | Slack icon, colour | Slack Technologies, LLC | `SLA-Slack-icon-RGB.svg` in the collection "Slack Media Kit Logos", https://salesforce.widencollective.com/c/yn6bxnam (from https://slack.com/media-kit). The download link is signed per session, so the file is pinned by SHA-256 `08f20f65a7d900c40358ca441caa7b834d82083356aa40d1f17d0844e8b3f73f`. | 2026-11-10 |
| `discord-symbol-blurple.svg` | Discord Symbol, Blurple | Discord Inc. | `Discord_Symbol_Color/Discord-Symbol-Blurple.svg` in https://cdn.discordapp.com/assets/content/a736b95923ddbc155e828651c92471292e40727655d770a06cec89c48ba0b41f.zip (from https://discord.com/branding) | 2026-11-10 |
| `signal-logo.svg`, `signal-logo-white.svg` | Signal logo, Ultramarine for light and white for dark surfaces | Signal Technology Foundation | `Logo/SVG/Signal-Logo-Ultramarine.svg` and `Logo/SVG/Signal-Logo-White.svg` in https://signal.org/brand/bundles/Signal%20Logo.zip (from https://signal.org/brand/). Signal asks for a minimum of 26 px; the mark tiles show it at 13 to 20 px. | 2026-11-10 |
| `whatsapp-logo.svg` | WhatsApp glyph, green | WhatsApp LLC | `Brand Resource Center Page Downloads/01_Glyph/01_Digital RGB/03_SVG/Digital_Glyph_Green_RGB_2026.svg` in the logo pack `WhatsApp-Brand-Resource-Center.zip` on https://about.meta.com/brand/resources/whatsapp/whatsapp-brand/ (archive SHA-256 `31cd2eaacb0abfd3640e51cb807c21dafba872e3aff8e520ff20ee6a1b01498f`). Meta offers the pack under its WhatsApp brand guidelines. | 2026-11-10 |

## Public reference hosts

Shown beside the host name wherever a public reference appears. A host shows the icon of whoever runs its domain; none of these owners publishes a logo download, so each file is the icon the owner serves on its own site. Three are the largest frame of the site's `favicon.ico`, decoded to PNG pixel for pixel without resampling. The KQL Search icon has a white background, so its tile is always white.

| File | Icon | Owner | Source | Retrieved |
|---|---|---|---|---|
| `microsoft-logo.png` | Microsoft logo, the four squares (shown for learn.microsoft.com and www.microsoft.com) | Microsoft Corporation | The 128 px frame of https://www.microsoft.com/favicon.ico, byte-identical at https://learn.microsoft.com/favicon.ico (ICO SHA-256 `90cdaf487716184e4034000935c605d1633926d348116d198f355a98b8c6cd21`) | 2026-11-10 |
| `kqlsearch.png` | KQL Search site icon, 48 px | Ugur Labs | The 48 px frame of https://www.kqlsearch.com/favicon.ico (ICO SHA-256 `d4b6630fb535af1f38c3892f3f648c04acce63e5bb88ad6bd8d8b6354d085f32`), the only icon the site serves | 2026-11-10 |
| `intuneautomation.png` | IntuneAutomation site icon, 192 px | Ugur Labs | https://www.intuneautomation.com/icon-192.png, the 192 px icon in https://www.intuneautomation.com/manifest.json | 2026-11-10 |
| `windowsforum.png` | WindowsForum site icon, 48 px | Fara Technologies LLC (WindowsForum.com) | The 48 px frame of https://mcp.windowsforum.com/favicon.ico (ICO SHA-256 `cbfb0d3f8a8e49b965c3d64561ee37996499f3b0f7f565776d92458503c86589`), the host OpenAdminOS queries; windowsforum.com refuses scripted requests | 2026-11-10 |
| `endoflife-ai.svg` | endoflife.ai site icon | EndofLife AI Inc. | https://endoflife.ai/favicon.svg, the icon linked from https://endoflife.ai/ | 2026-11-10 |

Splashtop's logo above is also shown for support-splashtopbusiness.splashtop.com.

A service, connector or host OpenAdminOS does not know yet shows its first two letters until its icon is added here.
