(function () {
  const OriginalFile = window.File;
  let textToUse = "";
  let isAskAi = false;

  window.File = function (bits, name, options) {
    if (typeof name === "string" && name.startsWith("Pasted_Text_") && isAskAi) {
      isAskAi = false;
      const cleanBlob = new Blob([textToUse], { type: "text/plain" });
      return new OriginalFile([cleanBlob], name, options);
    }
    return new OriginalFile(bits, name, options);
  };

  async function dataURLtoFile(dataurl, filename) {
    const res = await fetch(dataurl);
    const blob = await res.blob();
    return new OriginalFile([blob], filename, { type: "image/png" });
  }

  const SCREENSHOT_INLINE_MAX = 180000;

  async function slimScreenshotResult(result) {
    if (!result || typeof result !== "object") return result;
    const shot = result.screenshot;
    if (!shot || typeof shot !== "string" || shot.length <= SCREENSHOT_INLINE_MAX) return result;
    try {
      window.parent.postMessage(
        { type: "EXECUTE_PASTE", contentType: "image", data: shot },
        "*"
      );
    } catch (_e) {}
    const { screenshot, ...rest } = result;
    return {
      ...rest,
      screenshot_attached: true,
      screenshot_delivered_via: "paste",
      screenshot_bytes: shot.length,
    };
  }

  async function executePipeline(primary, followup) {
    const first = await browserCommand(primary);
    const hasShot = !!(first?.screenshot || (first?.screenshot_attached && !first?.screenshot_deferred));
    const needsShot = followup && !hasShot;
    if (!needsShot) return first;

    const shotCmd = {
      ...followup,
      params: { ...(followup.params || {}), use_current_tab: true },
    };
    const tabId = first?.tab?.id;
    if (tabId) shotCmd.params.tab_id = tabId;

    try {
      const shot = await browserCommand(shotCmd);
      return {
        ...first,
        ...shot,
        screenshot: shot.screenshot,
        screenshot_attached: !!(shot.screenshot || shot.screenshot_attached),
        auto_screenshot: true,
        screenshot_deferred: false,
        screenshot_missing: false,
      };
    } catch (e) {
      return { ...first, screenshot_chain_error: String(e.message || e) };
    }
  }

  function browserCommand(command, timeoutMs) {
    const slowActions = new Set(["navigate", "search", "open_tab", "reload"]);
    const fastActions = new Set(["ping"]);
    const takeoverActions = new Set(["takeover", "use_current_page"]);
    const action = command?.action;
    let defaultTimeout = 30000;
    if (slowActions.has(action)) defaultTimeout = 45000;
    if (action === "ping") defaultTimeout = 8000;
    else if (takeoverActions.has(action)) defaultTimeout = 18000;
    else if (action === "screenshot") defaultTimeout = 15000;
    else if (fastActions.has(action)) defaultTimeout = 10000;

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      let settled = false;

      function finish(err, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        window.removeEventListener("owui-browser-result", onBridgeEvent);
        if (err) reject(err);
        else resolve(result);
      }

      async function handlePayload(payload) {
        if (!payload || payload.id !== id) return;
        if (payload.error) finish(new Error(payload.error));
        else {
          try {
            finish(null, await slimScreenshotResult(payload.result));
          } catch (err) {
            finish(err);
          }
        }
      }

      function onMessage(event) {
        const type = event.data?.type;
        if (type !== "OWUI_BRIDGE_RESULT" && type !== "BROWSER_RESULT") return;
        const fromBridge = event.source === window;
        const fromSidepanel = event.source === window.parent;
        if (!fromBridge && !fromSidepanel) return;
        handlePayload(event.data);
      }

      function onBridgeEvent(event) {
        handlePayload(event.detail);
      }

      const timeout = setTimeout(() => {
        finish(
          new Error(
            `Browser not responding (${action || "unknown"}). Reload Open WebUI tab and the extension. ` +
              "Ensure Open WebUI Browser Agent side panel is open."
          )
        );
      }, timeoutMs || defaultTimeout);

      window.addEventListener("message", onMessage);
      window.addEventListener("owui-browser-result", onBridgeEvent);

      window.postMessage({ type: "OWUI_BRIDGE_CMD", id, command }, "*");

      try {
        window.parent.postMessage({ type: "BROWSER_COMMAND", id, command }, "*");
      } catch (_e) {}
    });
  }

  window.__OWUI_SIDEKICK__ = {
    version: "1.8.1",
    execute(command) {
      return browserCommand(command);
    },
    executePipeline(primary, followup) {
      return executePipeline(primary, followup);
    },
    ping() {
      return browserCommand({ action: "ping", params: {}, auto_include_page_text: false });
    },
  };

  function notifyReady() {
    window.parent.postMessage({ type: "SIDEKICK_READY", version: "1.8.1" }, "*");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", notifyReady);
  } else {
    notifyReady();
  }

  function findChatInputTarget() {
    const root = document.querySelector("#chat-input");
    if (!root) return null;
    return (
      root.querySelector('.ProseMirror[contenteditable="true"]') ||
      root.querySelector('[contenteditable="true"]') ||
      root
    );
  }

  function pasteTextDirect(text) {
    const el = findChatInputTarget();
    if (!el) return false;

    el.focus();

    const fileName = `Pasted_Text_${Date.now()}.txt`;
    textToUse = text;
    isAskAi = true;
    const baitText = (text || "").substring(0, 5) + " ".repeat(1000);
    const file = new File([baitText], fileName, { type: "text/plain" });

    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", baitText);
    dataTransfer.items.add(file);

    const pasted = el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );

    if (!pasted && document.queryCommandSupported?.("insertText")) {
      document.execCommand("insertText", false, text);
      return true;
    }

    return pasted;
  }

  window.addEventListener("START_PASTE_PROCESS", async (e) => {
    const { contentType, data } = e.detail;

    if (contentType === "text") {
      pasteTextDirect(data || "");
      return;
    }

    const el = findChatInputTarget() || document.querySelector("#chat-input");
    if (!el) return;

    const dataTransfer = new DataTransfer();
    el.focus();

    if (contentType === "image") {
      const imageFile = await dataURLtoFile(data, `screenshot_${Date.now()}.png`);
      dataTransfer.items.add(imageFile);
    }

    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
  });
})();