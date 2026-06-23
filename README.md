# Open WebUI Browser Agent

A Chrome extension that opens your [Open WebUI](https://github.com/open-webui/open-webui) instance in the browser side panel, with vision-based AI browser control, screenshot capture, and page automation.

![Open WebUI icon](icons/icon48.png)

## Distribution

| Component | Install from |
|-----------|--------------|
| **Chrome extension** (this repo) | Git — load unpacked at `chrome://extensions` |
| **Browser Agent tool** | [Open WebUI Community](https://openwebui.com/search?type=tool) — search “Browser Agent” |

## Features

- **Side Panel** — Open WebUI runs alongside whatever you're browsing
- **Screenshot Capture** — Camera button, `Ctrl/⌘+Shift+Y`, or right-click menu
- **Vision Browser Agent** — Screenshot-based navigation (like Claude for Chrome)
- **Quiz solving** — `solve_quiz_step` selects answers and clicks Next on-page
- **Connection Status** — Badge in the side panel when the agent bridge is ready
- **Configurable** — Point at any Open WebUI instance via Options

## Requirements

- Google Chrome or Microsoft Edge
- A running [Open WebUI](https://github.com/open-webui/open-webui) instance
- **Browser Agent** tool from [openwebui.com Community](https://openwebui.com/search?type=tool)
- Vision-capable model + Native function calling

## Install the extension

1. Clone this repo
2. Open `chrome://extensions/` → enable **Developer mode**
3. Click **Load unpacked** → select this folder
4. Pin **Open WebUI Browser Agent** in the toolbar

## Install the tool

1. Go to [openwebui.com → Tools](https://openwebui.com/search?type=tool)
2. Find and install **Open WebUI Browser Agent**
3. In a chat, enable the tool under **+**
4. Use a model with **Native** function calling

## Configuration

1. Right-click the extension icon → **Options**
2. Set **Open WebUI URL** (e.g. `http://localhost:3000`)
3. Set **Target Match URL** to your URL with `/*` (e.g. `http://localhost:3000/*`)
4. Keep **Enable AI browser control** on
5. Click **Save**

## Usage

1. Open any website tab
2. Click the extension icon to open the side panel
3. Log in to Open WebUI
4. Ask the model to browse — it calls `browser_agent` with `action=takeover` first
5. Click the website tab (not the side panel) before takeover

### Quiz pages

```
takeover → solve_quiz_step text="A" → repeat until quiz_submitted
```

## File structure

```
├── manifest.json           # Extension manifest (MV3)
├── background.js           # Service worker
├── sidepanel.html/js       # Side panel UI
├── content-bridge.js       # Injected into Open WebUI (isolated world)
├── content-main.js         # Paste + browser bridge (MAIN world)
├── content-agent.js        # DOM actions on browsed pages
├── options.html/js         # Extension options
└── icons/                  # Official Open WebUI icon (resized)
```

The Browser Agent tool is **not** in this repo — install it from [Open WebUI Community](https://openwebui.com/search?type=tool).

## Troubleshooting

**`__pycache__` blocks extension load**

Never run Python in the extension folder. Delete `__pycache__` if created:

```bash
rm -rf __pycache__
```

**Side panel blank**

Open WebUI may block iframe embedding via CSP. Local instances usually work; check reverse-proxy headers.

**Model says it can't control the browser**

- Side panel must be open
- Click the website tab before `takeover`
- Target Match URL must match your Open WebUI URL + `/*`
- Reload extension and re-import the community tool

## Brand

Extension icons use the official [Open WebUI brand assets](https://docs.openwebui.com/brand/). Open WebUI is a separate project — this is a community integration, not an official Open WebUI product.

## License

MIT
