# OpenWebUI Sidekick

A Chrome extension that opens your [OpenWebUI](https://github.com/open-webui/open-webui) instance in the browser's side panel, with a floating button to capture screenshots from any tab and paste them directly into the OpenWebUI chat input.

## Features

- **Side Panel Integration** — OpenWebUI runs alongside whatever you're browsing, no tab switching needed.
- **Screenshot Capture** — Click the floating camera button (or use the keyboard shortcut / right-click menu) to grab the visible tab and paste it into the chat as an image.
- **Draggable Button** — Drag the floating button anywhere in the side panel; its position is saved.
- **Keyboard Shortcut** — `Ctrl+Shift+Y` (Windows/Linux) or `⌘+Shift+Y` (macOS) to capture the current tab.
- **Right-Click Menu** — "Send screenshot to OpenWebUI" on any page.
- **Configurable** — Point it at any OpenWebUI instance (local or remote) via the Options page.

## Requirements

- Google Chrome or Microsoft Edge (latest version recommended)
- A running [OpenWebUI](https://github.com/open-webui/open-webui) instance
- A vision-capable model configured in OpenWebUI (for screenshot understanding)

## Installation

1. **Download the code**

   Clone or download this folder to your machine:

   ```bash
   git clone https://github.com/hvbhanot/OpenWebUI-Sidekick.git
   ```

   (Or just use the folder directly if you already have it.)

2. **Load the extension**

   - Open Chrome and go to `chrome://extensions/`
   - Toggle **Developer mode** on (top-right)
   - Click **Load unpacked**
   - Select the `OpenChrome` folder

3. **Pin it (optional)**

   Click the puzzle-piece icon in the Chrome toolbar and pin "OpenWebUI Sidekick" for quick access.

## Configuration

1. Right-click the extension icon in the toolbar and select **Options**.
2. Set the following:
   - **OpenWebUI URL** — Your instance address, e.g. `http://localhost:3000` or `https://openwebui.mydomain.com`
   - **Target Match URL** — The match pattern for content scripts, usually your URL with `/*` appended, e.g. `http://localhost:3000/*`
3. Click **Save**.

## Usage

1. Navigate to any web page.
2. Click the extension icon (or the pinned icon) to open the side panel.
3. Log in to OpenWebUI if you haven't already.
4. Click the floating camera button to capture the current tab — a preview overlay appears.
5. Click **Paste into chat** to inject the screenshot into the OpenWebUI chat input.
6. Press Enter (or send) in OpenWebUI to submit it to your model.

### Moving the button

Drag the floating camera button anywhere in the side panel. Its position is remembered across sessions.

### Keyboard shortcut

Press `Ctrl+Shift+Y` (or `⌘+Shift+Y` on macOS) on any tab to capture and open the overlay. You can remap this at `chrome://extensions/shortcuts`.

### Right-click menu

Right-click anywhere on a page and select **"Send screenshot to OpenWebUI"**.

## How It Works

The extension uses Chrome's `sidePanel` API to host your OpenWebUI instance in an iframe. When you capture a screenshot:

1. `chrome.tabs.captureVisibleTab` grabs the visible area of the active tab as a PNG data URL.
2. The data URL is sent to the side panel via `chrome.runtime.sendMessage`.
3. The side panel posts the image to the OpenWebUI iframe via `window.postMessage`.
4. Content scripts injected into the OpenWebUI page (`content-bridge.js` → `content-main.js`) intercept the message, convert the data URL to a `File` object, and dispatch a synthetic `paste` event on the `#chat-input` element.

This approach mimics a real user pasting an image from the clipboard, so it works with whatever model and chat state OpenWebUI currently has — no API keys or model configuration needed in the extension.

## File Structure

```
OpenChrome/
├── manifest.json        # Extension manifest (MV3)
├── background.js        # Service worker: captures, opens panel, registers scripts
├── sidepanel.html       # Side panel UI (iframe + floating button + overlay)
├── sidepanel.js         # Side panel logic (drag, capture, paste)
├── content-bridge.js    # Injected into OpenWebUI: relays messages to MAIN world
├── content-main.js      # Injected into OpenWebUI MAIN world: simulates paste
├── options.html         # Options page UI
├── options.js           # Options page logic
└── icons/               # Extension icons (16/48/128px)
```

## Troubleshooting

**The side panel is blank / OpenWebUI doesn't load**
OpenWebUI may send `X-Frame-Options` or a restrictive CSP that blocks iframe embedding. If you're running via Docker, ensure it's not behind a proxy that adds those headers. For local dev, running without a reverse proxy usually works.

**The capture button is invisible**
Reload the extension in `chrome://extensions`. The button defaults to the bottom-right of the side panel. If you dragged it off-screen before, the position is clamped back into view on reload.

**Screenshot pastes but the model can't "see" it**
Make sure you have a vision-capable model selected in OpenWebUI (e.g. a model with vision/llava/multimodal support).

**"Capture failed: ..." error**
Ensure the extension has the `<all_urls>` host permission (granted on install). If you denied it, re-enable at `chrome://extensions` → Details for this extension.

**Keyboard shortcut doesn't work**
Another extension or Chrome itself may have claimed `Ctrl+Shift+Y`. Remap it at `chrome://extensions/shortcuts`.

## License

MIT
