# Linux desktop startup network capture

Captures ran without sudo on Ubuntu 26.04.1 with Electron 42.8.1 and Chromium
148.0.7778.280.
Each run started with a fresh profile. Playwright connected to the running
Electron renderer over CDP, opened Chat, typed a sample misspelling without
sending it, waited 21 seconds, and quit Electron.

## Observed requests

The baseline is `006ad3c0`. Hosts include Chromium NetLog and the Electron
main process Node HTTP trace.

| Host and request | Before | After |
| --- | --- | --- |
| `redirector.gvt1.com` GET `/edgedl/chrome/dict/en-us-10-1.bdic` or `/edgedl/chrome/dict/de-de-3-0.bdic` | 302 in both locales | Absent |
| `rr2---sn-fuoxu-i5hz.gvt1.com` GET `/edgedl/chrome/dict/en-us-10-1.bdic` | 200 in English | Absent |
| `rr2---sn-fuoxu-i5h6.gvt1.com` GET `/edgedl/chrome/dict/de-de-3-0.bdic` | 200 in German | Absent |
| `raw.githubusercontent.com` GET `/OpenAdminOS/OpenAdminOS/main/agents/index.json` | Registry index | Registry index |
| `github.com` GET `/OpenAdminOS/OpenAdminOS/releases/download/docs-index*/...` | Docs index pointer, metadata, checksum, chunks, and embeddings | Same |
| `release-assets.githubusercontent.com` GET `/github-production-release-asset/...` | Redirected GitHub release assets | Same |
| `127.0.0.1:5186` | Vite renderer and assets | Same |
| `127.0.0.1:11434` GET `/api/tags`, POST `/api/show` | Ollama model discovery | Same |
| `127.0.0.1:1234` and `127.0.0.1:13305` GET `/v1/models` | LM Studio and Lemonade discovery | Same |

Google's CDN was the unexpected destination. The initial request disclosed
platform and app/browser versions in `User-Agent` and language in
`Accept-Language`. Google's `Location` header included an IP address in its
`mip` parameter, which the redirected request carried in its `:path`.
The captured dictionary requests contained no cookie, authorization, or app
installation ID header. Neither request contained the typed word.

Before the change, `Dictionaries/` held `en-US-10-1.bdic` (451,968 bytes) or
`de-DE-3-0.bdic` (6,811,094 bytes). After the change, neither locale produced
a dictionary file or a Google request. The dev build does not exercise the
packaged auto-updater. The traces cover Chromium and in-process Node HTTP.
Traffic an installed CLI or local provider generates independently is outside
that capture.

The Linux default session clears its spellchecker languages before any app
window opens. In Electron 42.8.1, this also disables the spellchecker. In
separate trials, the session toggle and per-window toggle each left the
dictionary download active. macOS uses native spellchecking. Electron
42 supports Windows 10 and later, where its Chromium version uses Windows
spellchecking by default for supported languages and can fall back to
Hunspell. The captures ran on Linux. [Electron 42.8.1 spellchecker guide](https://github.com/electron/electron/blob/v42.8.1/docs/tutorial/spellchecker.md) · [Electron session implementation](https://github.com/electron/electron/blob/v42.8.1/shell/browser/api/electron_api_session.cc#L1449) · [Chromium Windows path](https://github.com/chromium/chromium/blob/148.0.7778.280/chrome/browser/spellchecker/spellcheck_service.cc#L430)

Follow-up: capture startup on Windows with a UI language unsupported by native
spellchecking, where Chromium may fall back to Hunspell.

## Repeat the capture

Install dependencies with `npm ci`. From the repository root, build Electron
and leave the Vite renderer running.

```sh
npm run build:packages -w @openadminos/desktop
npm run build:electron -w @openadminos/desktop
npm run dev:renderer -w @openadminos/desktop -- --host 127.0.0.1 --port 5186 --strictPort
```

From a second shell, launch Electron with a new profile for each locale and
revision. Set both `LANG` and `LC_ALL` to the installed locale. If the German
locale is missing, generate a private copy.

```sh
locale_dir=$(mktemp -d)
localedef --no-archive -i de_DE -f UTF-8 "$locale_dir/de_DE.UTF-8"
export LOCPATH="$locale_dir"
```

```sh
capture=$(mktemp -d)
env -u ELECTRON_RUN_AS_NODE LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
  OPENADMINOS_USER_DATA_DIR="$capture/profile" VITE_DEV_SERVER_URL=http://127.0.0.1:5186 \
  node_modules/.bin/electron apps/desktop --remote-debugging-port=0 \
  --log-net-log="$capture/netlog.json" --net-log-capture-mode=Default
```

If Chromium's sandbox cannot start on the isolated test machine, use
`--no-sandbox` as in the desktop screenshot harness.

Use the displayed CDP endpoint with Playwright's `chromium.connectOverCDP`,
or drive the window manually. Leave model setup, choose **Not now** at
Microsoft 365 setup, focus the Chat composer, and type a synthetic word.
Quit the app after 21 seconds so it flushes NetLog. Use the matching
`LC_ALL=de_DE.UTF-8` and `LANG=de_DE.UTF-8` for the German run.

```sh
python3 - "$capture" <<'PY'
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

root = Path(sys.argv[1])
log = json.loads((root / "netlog.json").read_text())
start = log["constants"]["logEventTypes"]["URL_REQUEST_START_JOB"]
requests = set()
for event in log["events"]:
    if event["type"] == start:
        url = urlsplit(event.get("params", {}).get("url", ""))
        if url.scheme in ("http", "https", "ws", "wss"):
            requests.add((url.netloc, url.path))
for host, path in sorted(requests):
    print(host, path)
for path in sorted((root / "profile" / "Dictionaries").glob("*.bdic")):
    print(path.name, path.stat().st_size)
PY
```

To include Node HTTP, preload a temporary script with
`NODE_OPTIONS=--require=/path/to/trace.cjs`. In the main process, subscribe
to the Node `diagnostics_channel` events `undici:request:create` and
`http.client.request.start` and record the method, host, and path only.
Review dictionary headers privately. Publish sanitized hosts, paths, status
codes, and file sizes. Keep raw logs and redirect query values private.
