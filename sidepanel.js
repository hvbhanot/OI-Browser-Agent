const frame = document.getElementById("frame");
const loader = document.getElementById("loader");
const captureOverlay = document.getElementById("capture");
const capturePreview = document.getElementById("capturePreview");
const sendBtn = document.getElementById("sendBtn");
const cancelBtn = document.getElementById("cancelBtn");
const statusEl = document.getElementById("status");
const captureBtn = document.getElementById("captureBtn");

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
});

let currentScreenshot = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

chrome.storage.sync.get(["fabPos"], (result) => {
  const pos = result.fabPos;
  let x = pos ? pos.x : window.innerWidth - 60;
  let y = pos ? pos.y : window.innerHeight - 60;
  x = Math.max(4, Math.min(x, window.innerWidth - 48));
  y = Math.max(4, Math.min(y, window.innerHeight - 48));
  captureBtn.style.left = x + "px";
  captureBtn.style.top = y + "px";
});

captureBtn.addEventListener("pointerdown", (e) => {
  isDragging = true;
  dragMoved = false;
  const rect = captureBtn.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;
  captureBtn.setPointerCapture(e.pointerId);
});

captureBtn.addEventListener("pointermove", (e) => {
  if (!isDragging) return;
  dragMoved = true;
  captureBtn.classList.add("dragging");
  let x = e.clientX - dragOffsetX;
  let y = e.clientY - dragOffsetY;
  x = Math.max(0, Math.min(x, window.innerWidth - 44));
  y = Math.max(0, Math.min(y, window.innerHeight - 44));
  captureBtn.style.left = x + "px";
  captureBtn.style.top = y + "px";
});

captureBtn.addEventListener("pointerup", (e) => {
  if (!isDragging) return;
  isDragging = false;
  captureBtn.classList.remove("dragging");
  if (dragMoved) {
    const x = parseInt(captureBtn.style.left, 10);
    const y = parseInt(captureBtn.style.top, 10);
    chrome.storage.sync.set({ fabPos: { x, y } });
  }
});

sendBtn.addEventListener("click", () => {
  if (!currentScreenshot) return;
  frame.contentWindow.postMessage(
    { type: "EXECUTE_PASTE", contentType: "image", data: currentScreenshot },
    "*"
  );
  statusEl.textContent = "Pasted into OpenWebUI chat.";
  statusEl.className = "ok";
  setTimeout(() => {
    captureOverlay.style.display = "none";
    currentScreenshot = null;
  }, 1000);
});