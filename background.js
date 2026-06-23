chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "capture-and-send",
    title: "Send screenshot to OpenWebUI",
    contexts: ["page", "frame", "image", "selection", "link"],
  });
  chrome.storage.sync.get(["openwebuiUrl", "targetMatchUrl"], (result) => {
    if (!result.openwebuiUrl) {
      chrome.storage.sync.set({ openwebuiUrl: "http://localhost:3000" });
    }
    if (!result.targetMatchUrl) {
      const url = result.openwebuiUrl || "http://localhost:3000";
      chrome.storage.sync.set({ targetMatchUrl: url + "/*" });
      registerScripts(url + "/*");
    } else if (result.targetMatchUrl) {
      registerScripts(result.targetMatchUrl);
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "capture-and-send" && tab) {
    captureAndSend(tab.id);
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "capture-and-send" && tab) {
    captureAndSend(tab.id);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "capture-request") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) captureAndSend(tabs[0].id);
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "RELOAD_SCRIPTS") {
    registerScripts(msg.targetMatchUrl);
    sendResponse({ ok: true });
    return true;
  }
});

async function registerScripts(targetMatchUrl) {
  const bridgeId = "owui-bridge";
  const mainId = "owui-main";
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ids = existing.map((s) => s.id);
    if (ids.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids });
    }
  } catch (e) {
    console.error("unregister failed", e);
  }
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: bridgeId,
        js: ["content-bridge.js"],
        matches: [targetMatchUrl],
        allFrames: true,
        runAt: "document_start",
      },
      {
        id: mainId,
        js: ["content-main.js"],
        matches: [targetMatchUrl],
        allFrames: true,
        world: "MAIN",
        runAt: "document_start",
      },
    ]);
    console.log("registered scripts for", targetMatchUrl);
  } catch (e) {
    console.error("register failed", e);
  }
}

async function captureAndSend(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    await chrome.sidePanel.open({ tabId }).catch(() => {});
    await chrome.runtime
      .sendMessage({ type: "screenshot-ready", dataUrl })
      .catch(() => {});
  } catch (e) {
    console.error("capture failed", e);
    chrome.runtime
      .sendMessage({
        type: "capture-error",
        error: String((e && e.message) || e),
      })
      .catch(() => {});
  }
}