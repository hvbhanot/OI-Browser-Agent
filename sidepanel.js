const frame = document.getElementById("frame");
const loader = document.getElementById("loader");
const captureOverlay = document.getElementById("capture");
const capturePreview = document.getElementById("capturePreview");
const sendBtn = document.getElementById("sendBtn");
const cancelBtn = document.getElementById("cancelBtn");
const statusEl = document.getElementById("status");
const captureBtn = document.getElementById("captureBtn");
const fabStack = document.getElementById("fabStack");
const agentToast = document.getElementById("agentToast");
const connBadge = document.getElementById("connBadge");
const connLabel = document.getElementById("connLabel");

function normalizeUrl(url) {
  let u = (url || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  return u.replace(/\/+$/, "");
}

function loadUrl(url) {
  const finalUrl = normalizeUrl(url) || "http://localhost:3000";
  loader.style.display = "flex";
  frame.src = finalUrl;
}

chrome.storage.sync.get(["openwebuiUrl"], (result) => {
  loadUrl(result.openwebuiUrl || "http://localhost:3000");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.openwebuiUrl) {
    loadUrl(changes.openwebuiUrl.newValue);
  }
});

frame.addEventListener("load", () => {
  loader.style.display = "none";
  sidekickReady = false;
  refreshConnectionStatus();
  chrome.storage.sync.get(["targetMatchUrl", "openwebuiUrl"], (result) => {
    const target =
      result.targetMatchUrl ||
      `${(result.openwebuiUrl || "http://localhost:3000").replace(/\/+$/, "")}/*`;
    chrome.runtime.sendMessage({ type: "RELOAD_SCRIPTS", targetMatchUrl: target }).catch(() => {});
  });
});

let currentScreenshot = null;
let sidekickReady = false;

function showAgentToast(message, isError) {
  if (!agentToast) return;
  agentToast.textContent = message;
  agentToast.classList.toggle("error", !!isError);
  agentToast.classList.add("show");
  clearTimeout(showAgentToast._timer);
  showAgentToast._timer = setTimeout(() => agentToast.classList.remove("show"), isError ? 5000 : 3500);
}

function formatBrowserStep(command) {
  const action = command?.action || "action";
  const p = command?.params || {};
  const parts = [action];
  if (action === "solve_quiz_step" && (p.answer || p.text)) {
    parts.push(`answer ${String(p.answer || p.text).slice(0, 1).toUpperCase()}`);
  } else if (action === "click_quiz_answer" && (p.answer || p.text)) {
    parts.push(`answer ${String(p.answer || p.text).slice(0, 1).toUpperCase()}`);
  } else if (p.query) parts.push(`"${String(p.query).slice(0, 40)}"`);
  else if (p.url) parts.push(String(p.url).slice(0, 50));
  else if (p.text) parts.push(`"${String(p.text).slice(0, 30)}"`);
  else if (action === "click_at" && p.x != null) parts.push(`(${p.x}, ${p.y})`);
  else if (action === "scroll") parts.push(`${p.direction || "down"} ${p.amount || 400}px`);
  if (p.thought) parts.push(`— ${String(p.thought).slice(0, 50)}`);
  return parts.join(" ");
}

function setConnectionBadge(state, label) {
  if (!connBadge || !connLabel) return;
  connBadge.classList.remove("ready", "warn", "error");
  if (state) connBadge.classList.add(state);
  connLabel.textContent = label;
}

async function refreshConnectionStatus() {
  const settings = await chrome.storage.sync.get(["browserControlEnabled"]);
  if (settings.browserControlEnabled === false) {
    setConnectionBadge("warn", "Browser control disabled");
    return;
  }
  if (!sidekickReady) {
    setConnectionBadge("warn", "Open WebUI not ready — reload chat");
    return;
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: "sidekick-ping" });
    if (!resp?.ok) {
      setConnectionBadge("error", "Extension error");
      return;
    }
    const tab = resp.browsedTab;
    if (tab?.title) {
      setConnectionBadge("ready", `Ready · ${tab.title.slice(0, 42)}`);
    } else if (tab?.url) {
      setConnectionBadge("ready", `Ready · ${tab.url.replace(/^https?:\/\//, "").slice(0, 48)}`);
    } else {
      setConnectionBadge("warn", "Ready — click a website tab");
    }
  } catch (_e) {
    setConnectionBadge("error", "Extension disconnected");
  }
}

window.addEventListener("message", async (event) => {
  if (event.data?.type === "SIDEKICK_READY") {
    sidekickReady = true;
    refreshConnectionStatus();
    return;
  }

  if (!event.data || event.data.type !== "BROWSER_COMMAND") return;
  if (frame.contentWindow && event.source !== frame.contentWindow) return;

  const { id, command } = event.data;
  showAgentToast(formatBrowserStep(command), false);

  try {
    const settings = await chrome.storage.sync.get(["browserControlEnabled"]);
    if (settings.browserControlEnabled === false) {
      throw new Error("Browser control is disabled in extension options");
    }
    const response = await chrome.runtime.sendMessage({
      type: "browser-command",
      command,
      requestId: id,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Browser command failed");
    }
    const summary =
      response.result?.step_summary ||
      response.result?.page_url ||
      response.result?.url ||
      "done";
    showAgentToast(`✓ ${formatBrowserStep(command)} — ${String(summary).slice(0, 80)}`, false);
    event.source.postMessage(
      { type: "BROWSER_RESULT", id, result: response.result },
      "*"
    );
  } catch (e) {
    showAgentToast(String(e.message || e), true);
    event.source.postMessage(
      { type: "BROWSER_RESULT", id, error: String(e.message || e) },
      "*"
    );
  }
});

function pasteIntoChat(contentType, data) {
  if (!frame.contentWindow) return false;
  frame.contentWindow.postMessage({ type: "EXECUTE_PASTE", contentType, data }, "*");
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "auto-paste-screenshot" && msg.dataUrl) {
    pasteIntoChat("image", msg.dataUrl);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "auto-paste-text" && msg.text) {
    pasteIntoChat("text", msg.text);
    showAgentToast("Page text added to chat");
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "screenshot-ready") {
    currentScreenshot = msg.dataUrl;
    capturePreview.src = msg.dataUrl;
    statusEl.textContent = "";
    statusEl.className = "";
    captureOverlay.style.display = "flex";
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "capture-error") {
    statusEl.textContent = "Capture failed: " + (msg.error || "unknown error");
    statusEl.className = "error";
    captureOverlay.style.display = "flex";
    sendResponse({ ok: true });
    return true;
  }
});

cancelBtn.addEventListener("click", () => {
  captureOverlay.style.display = "none";
  currentScreenshot = null;
});

captureBtn.addEventListener("click", (e) => {
  if (dragMoved) {
    e.preventDefault();
    e.stopPropagation();
    dragMoved = false;
    return;
  }
  chrome.runtime.sendMessage({ type: "capture-request" });
});

let isDragging = false;
let dragMoved = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragTarget = null;

function setupFabDrag(btn) {
  btn.addEventListener("pointerdown", (e) => {
    isDragging = true;
    dragMoved = false;
    dragTarget = btn;
    const rect = fabStack.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    btn.setPointerCapture(e.pointerId);
  });
}

setupFabDrag(captureBtn);

window.addEventListener("pointermove", (e) => {
  if (!isDragging || !dragTarget) return;
  dragMoved = true;
  fabStack.classList.add("dragging");
  let x = e.clientX - dragOffsetX;
  let y = e.clientY - dragOffsetY;
  x = Math.max(0, Math.min(x, window.innerWidth - 80));
  y = Math.max(0, Math.min(y, window.innerHeight - 120));
  fabStack.style.left = x + "px";
  fabStack.style.right = "auto";
  fabStack.style.bottom = "auto";
  fabStack.style.top = y + "px";
});

window.addEventListener("pointerup", () => {
  if (!isDragging || !dragTarget) return;
  isDragging = false;
  fabStack.classList.remove("dragging");
  if (dragMoved) {
    const x = parseInt(fabStack.style.left, 10) || window.innerWidth - 80;
    const y = parseInt(fabStack.style.top, 10) || window.innerHeight - 120;
    chrome.storage.sync.set({ fabStackPos: { x, y } });
  }
  dragTarget = null;
});

chrome.storage.sync.get(["fabStackPos", "fabPos"], (result) => {
  const pos = result.fabStackPos || result.fabPos;
  if (!pos) return;
  fabStack.style.left = pos.x + "px";
  fabStack.style.right = "auto";
  fabStack.style.bottom = "auto";
  fabStack.style.top = pos.y + "px";
});

setInterval(refreshConnectionStatus, 12000);
refreshConnectionStatus();

sendBtn.addEventListener("click", () => {
  if (!currentScreenshot) return;
  pasteIntoChat("image", currentScreenshot);
  statusEl.textContent = "Pasted into Open WebUI chat.";
  statusEl.className = "ok";
  setTimeout(() => {
    captureOverlay.style.display = "none";
    currentScreenshot = null;
  }, 1000);
});