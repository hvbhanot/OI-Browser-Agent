const relayedCommandIds = new Set();

function relayBrowserCommand(detail) {
  if (!detail?.id || !detail.command) return;
  if (relayedCommandIds.has(detail.id)) return;
  relayedCommandIds.add(detail.id);
  setTimeout(() => relayedCommandIds.delete(detail.id), 60000);

  chrome.runtime
    .sendMessage({
      type: "browser-command",
      command: detail.command,
      requestId: detail.id,
    })
    .then((response) => {
      const payload = {
        type: "OWUI_BRIDGE_RESULT",
        id: detail.id,
        result: response?.ok ? response.result : undefined,
        error: response?.ok ? undefined : response?.error || "Browser command failed",
      };
      window.postMessage(payload, "*");
      window.dispatchEvent(new CustomEvent("owui-browser-result", { detail: payload }));
    })
    .catch((err) => {
      const payload = {
        type: "OWUI_BRIDGE_RESULT",
        id: detail.id,
        error: String(err?.message || err),
      };
      window.postMessage(payload, "*");
      window.dispatchEvent(new CustomEvent("owui-browser-result", { detail: payload }));
    });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "EXECUTE_PASTE") {
    window.dispatchEvent(
      new CustomEvent("START_PASTE_PROCESS", {
        detail: {
          data: event.data.data,
          contentType: event.data.contentType,
        },
      })
    );
    return;
  }

  if (event.data?.type === "OWUI_BRIDGE_CMD") {
    relayBrowserCommand(event.data);
  }
});

window.addEventListener("owui-browser-command", (event) => {
  relayBrowserCommand(event.detail);
});