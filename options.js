const urlInput = document.getElementById("url");
const targetInput = document.getElementById("target");
const saveBtn = document.getElementById("save");
const status = document.getElementById("status");

chrome.storage.sync.get(["openwebuiUrl", "targetMatchUrl"], (result) => {
  urlInput.value = result.openwebuiUrl || "http://localhost:3000";
  targetInput.value = result.targetMatchUrl || (urlInput.value + "/*");
});

saveBtn.addEventListener("click", () => {
  const url = (urlInput.value || "").trim() || "http://localhost:3000";
  let target = (targetInput.value || "").trim();
  if (!target) {
    let base = url.replace(/\/+$/, "");
    target = base + "/*";
  }
  chrome.storage.sync.set(
    { openwebuiUrl: url, targetMatchUrl: target },
    () => {
      chrome.runtime.sendMessage(
        { type: "RELOAD_SCRIPTS", targetMatchUrl: target },
        () => {
          status.style.opacity = "1";
          setTimeout(() => {
            status.style.opacity = "0";
          }, 1500);
        }
      );
    }
  );
});