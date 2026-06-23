chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

const EXTENSION_VERSION = "1.8.1";
const inFlightBrowserCommands = new Map();

const ENRICH_PAGE_STATE_ACTIONS = new Set([
  "navigate",
  "search",
  "reload",
  "click",
  "click_at",
  "click_quiz_answer",
  "click_quiz_next",
  "solve_quiz_step",
  "click_product",
  "type",
  "type_and_submit",
  "select",
  "press_key",
  "scroll",
  "go_back",
  "go_forward",
  "wait",
  "switch_tab",
  "open_tab",
  "screenshot",
  "get_active_tab",
  "get_page_text",
  "get_page_summary",
  "get_page_html",
  "get_interactive_elements",
  "get_quiz_options",
  "dismiss_popups",
  "takeover",
  "use_current_page",
]);

const OPTIONAL_SCREENSHOT_PASTE_ACTIONS = new Set([
  "navigate",
  "search",
  "reload",
  "click",
  "click_at",
  "click_quiz_answer",
  "click_quiz_next",
  "solve_quiz_step",
  "click_product",
  "type",
  "type_and_submit",
  "select",
  "press_key",
  "scroll",
  "go_back",
  "go_forward",
  "wait",
  "takeover",
  "use_current_page",
]);

const SCREENSHOT_NAV_ACTIONS = new Set([
  ...OPTIONAL_SCREENSHOT_PASTE_ACTIONS,
  "screenshot",
  "dismiss_popups",
  "get_active_tab",
  "open_tab",
  "switch_tab",
]);

function buildActionSummary(action, params, result) {
  const p = params || {};
  const parts = [action];
  if (p.query) parts.push(`"${String(p.query).slice(0, 50)}"`);
  else if (p.url) parts.push(String(p.url).slice(0, 60));
  else if (action === "solve_quiz_step" && (p.answer || p.text)) {
    parts.push(`answer ${String(p.answer || p.text).slice(0, 1).toUpperCase()}`);
  } else if (p.text) parts.push(`type "${String(p.text).slice(0, 36)}"`);
  else if (action === "click_at" && p.x != null) parts.push(`(${p.x}, ${p.y})`);
  const url = result?.page_url || result?.url;
  if (url) parts.push(`→ ${String(url).slice(0, 70)}`);
  return parts.join(" ");
}

function isSolveQuizGoal(goal) {
  const g = String(goal || "").toLowerCase();
  return /solve|answer|complete|finish/.test(g);
}

function isQuizContext(enriched, goal) {
  const url = enriched.page_url || enriched.url || "";
  return (
    enriched.page_type === "quiz_page" ||
    enriched.quiz_mode ||
    /quiz|assessment|question|wildlife-quiz/i.test(url) ||
    isSolveQuizGoal(goal)
  );
}

function buildQuizSuggestedActions(enriched) {
  const actions = [{ action: "dismiss_popups", why: "Close cookie/consent overlays" }];
  const opts = (enriched.quiz_options || []).filter((o) => o.in_viewport !== false);
  const pick = opts.find((o) => o.letter) || opts[0];
  if (pick?.letter) {
    actions.push({
      action: "solve_quiz_step",
      answer: pick.letter,
      why: `Select answer ${pick.letter} and click Next in one step: ${String(pick.text || "").slice(0, 50)}`,
    });
    actions.push({
      action: "click_quiz_answer",
      answer: pick.letter,
      why: `Click answer ${pick.letter} only (if solve_quiz_step fails)`,
    });
  } else if (pick) {
    actions.push({
      action: "click_at",
      x: pick.x,
      y: pick.y,
      coordinate_system: "normalized",
      why: `Click answer on page: ${String(pick.text || "").slice(0, 50)}`,
    });
  } else {
    actions.push({
      action: "click_quiz_answer",
      answer: "A",
      why: "Click answer A (preferred over raw coordinates)",
    });
  }
  actions.push({ action: "click_quiz_next", why: "Click Next after selecting answer" });
  return actions;
}

function isQuizChoiceText(text) {
  return /^[A-F][\).:\s—–-]/i.test(text || "") || /^option\s*[A-F]/i.test(text || "");
}

async function enrichQuizContext(tab, enriched, command) {
  const goal = command?.params?.goal || enriched.goal || "";
  if (!isQuizContext(enriched, goal) && !isSolveQuizGoal(goal)) return enriched;

  enriched.page_type = "quiz_page";
  enriched.quiz_mode = true;
  enriched.solve_on_page_required = true;
  enriched.task_done = false;

  try {
    const quiz = await withTimeout(runAgentAction(tab.id, "get_quiz_options", {}), 2500, "quiz options");
    if (quiz?.options?.length) enriched.quiz_options = quiz.options;
    if (quiz?.controls?.length) enriched.quiz_controls = quiz.controls;
    if (quiz?.question_text) enriched.quiz_question = quiz.question_text;
  } catch (_e) {}

  enriched.forbidden_responses = [
    ...(enriched.forbidden_responses || []),
    "listing quiz answers in chat without clicking",
    "summarizing quiz solutions instead of click_at",
    "giving quiz answers before clicking on the webpage",
  ];
  enriched.model_instruction =
    "QUIZ SOLVE MODE — Do NOT write answers in chat. Prefer solve_quiz_step with answer='A'-'F' " +
    "(selects answer + clicks Next in one call). Fallback: click_quiz_answer then click_quiz_next. " +
    "Or click_at with normalized x,y between 0.0 and 1.0 ONLY (never >1). Repeat until quiz_submitted.";
  enriched.coordinate_hint =
    "quiz_options are for the CURRENT question only — each has distinct x,y. " +
    "Prefer solve_quiz_step answer='A'-'F'. normalized x,y must be 0.0–1.0.";
  enriched.suggested_actions = buildQuizSuggestedActions(enriched);
  enriched.agent_loop = buildAgentLoop(enriched, command?.params?.thought, command?.action);
  return enriched;
}

function buildSuggestedActions(enriched) {
  if (enriched.quiz_mode || enriched.page_type === "quiz_page") {
    return buildQuizSuggestedActions(enriched);
  }
  if (enriched.navigation_mode === "screenshot") {
    return [
      {
        action: "click_at",
        x: 0.5,
        y: 0.5,
        coordinate_system: "normalized",
        why: "Click center of visible page (adjust x,y from screenshot)",
      },
      { action: "scroll", direction: "down", amount: 600, why: "Scroll inner page containers" },
      { action: "press_key", key: "PageDown", why: "Scroll when window scroll is stuck" },
      { action: "press_key", key: "Tab", why: "Focus next interactive element" },
      { action: "type", text: "search query", prefer_search: true, why: "Type into search box" },
      { action: "press_key", key: "Enter", why: "Submit search/form" },
    ];
  }

  const actions = [];
  const products = enriched.products || [];
  const under30 = enriched.products_under_30_usd || [];

  if (enriched.took_over) {
    actions.push({ action: "get_interactive_elements", why: "Find clickable elements on this page" });
    actions.push({ action: "click", index: 0, why: "Click element after reading clickable_elements" });
    actions.push({ action: "scroll", direction: "down", amount: 500, why: "See more of the page" });
  } else if (products.length) {
    const pick = under30[0] || products.find((p) => !p.sponsored) || products[0];
    const idx = pick?.index || 1;
    actions.push({
      action: "click_product",
      product_index: idx,
      why: `Open product #${idx}: ${(pick?.title || "").slice(0, 60)}`,
    });
    actions.push({ action: "scroll", direction: "down", amount: 600, why: "Load more results" });
    actions.push({ action: "get_page_text", why: "Re-read page after scroll" });
  } else if (/amazon\.com\/dp\//i.test(enriched.page_url || enriched.url || "")) {
    actions.push({ action: "get_page_text", why: "Read product detail page" });
  } else if (enriched.clickable_elements?.length) {
    actions.push({
      action: "get_interactive_elements",
      why: "Find clickable index before click",
    });
  }

  return actions.slice(0, 4);
}

function buildAgentLoop(enriched, thought, lastAction) {
  const pageUrl = enriched.page_url || enriched.url || "";
  const onProductPage = /amazon\.com\/(?:dp|gp\/product)\//i.test(pageUrl);
  const isScreenshotNav = enriched.navigation_mode === "screenshot";

  if (isScreenshotNav) {
    const isQuiz = enriched.quiz_mode || enriched.page_type === "quiz_page";
    const taskLikelyDone = isQuiz
      ? enriched.quiz_submitted === true
      : enriched.task_done === true ||
        (onProductPage && ["click_at", "click", "click_product"].includes(lastAction));
    let next_step;
    if (taskLikelyDone) {
      next_step = isQuiz
        ? "Quiz submitted on the webpage. Summarize results for the user. Loop complete."
        : "You reached the target page. Summarize what you see in the screenshot for the user. Loop complete.";
    } else if (enriched.skipped_takeover || enriched.already_controlled) {
      next_step = enriched.screenshot_attached
        ? "Already connected. Study the screenshot, then click_at or dismiss_popups. NEVER call takeover again."
        : "Already connected. Call browser_agent action=click_at or action=takeover (screenshot auto-chains). NEVER call action=screenshot separately.";
    } else if (
      enriched.screenshot_attached &&
      (lastAction === "takeover" || lastAction === "use_current_page")
    ) {
      next_step =
        "Screenshot attached. Study it, then call browser_agent with dismiss_popups or click_at. Do NOT ask user to paste anything.";
    } else if (lastAction === "takeover" || lastAction === "use_current_page") {
      next_step =
        enriched.page_type === "quiz_page"
          ? "Quiz page ready. Screenshot auto-chains — use click_at on answers. NEVER call takeover or screenshot separately."
          : "Takeover complete. Screenshot auto-chains on each action — use click_at/scroll. NEVER call takeover again.";
    } else {
      next_step =
        "Study the new screenshot. THINK, then call browser_agent with ONE action (click_at, type, scroll, search).";
    }

    return {
      pattern: isQuiz
        ? "READ screenshot → solve_quiz_step answer=A-F → repeat → DO NOT chat answers"
        : "THINK → browser_agent(thought, action) → VIEW screenshot → THINK → repeat",
      your_thought: thought || null,
      observe: {
        url: pageUrl,
        title: enriched.page_title || enriched.title,
        viewport: enriched.viewport || null,
        screenshot_attached: !!enriched.screenshot_attached,
        on_product_page: onProductPage,
        quiz_mode: !!isQuiz,
        quiz_answers_clicked: enriched.quiz_answers_clicked || 0,
        quiz_submitted: !!enriched.quiz_submitted,
      },
      task_done: taskLikelyDone,
      continue_loop: !taskLikelyDone,
      next_step,
    };
  }

  const hasProducts = (enriched.products || []).length > 0;
  const openedProduct = lastAction === "click_product" && onProductPage;
  const taskLikelyDone = onProductPage && lastAction === "get_page_text";

  let next_step;
  if (taskLikelyDone) {
    next_step = "Product page read — summarize for the user. Loop complete.";
  } else if (lastAction === "takeover" || lastAction === "use_current_page") {
    next_step =
      "You now control the user's current tab. Read page_text/products, THINK, then act (click, click_product, type, scroll).";
  } else if (openedProduct) {
    next_step =
      "Product page opened. THINK, then call browser_agent with action=get_page_text to read details.";
  } else if (hasProducts) {
    next_step =
      "Search results loaded. THINK which product fits the goal, then action=click_product, product_index=N.";
  } else {
    next_step = "THINK about what is missing, then call browser_agent with the next single action.";
  }

  return {
    pattern: "THINK → browser_agent(thought, action) → OBSERVE this JSON → THINK → repeat",
    your_thought: thought || null,
    observe: {
      url: pageUrl,
      page_type: enriched.page_type || (onProductPage ? "amazon_product" : null),
      product_count: (enriched.products || []).length,
      on_product_page: onProductPage,
    },
    task_done: taskLikelyDone,
    continue_loop: !taskLikelyDone,
    next_step,
  };
}

let lastBrowsedTabId = null;
let lastUserTabId = null;
let agentControlActive = false;
let agentControlledTabId = null;

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === lastUserTabId) lastUserTabId = null;
  if (tabId === lastBrowsedTabId) lastBrowsedTabId = null;
  if (tabId === agentControlledTabId) {
    agentControlActive = false;
    agentControlledTabId = null;
  }
});

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (await isAgentTargetTab(tab)) return;
    if (isBrowsableTab(tab)) {
      lastUserTabId = tab.id;
      lastBrowsedTabId = tab.id;
    }
  } catch (_e) {}
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "capture-and-send",
    title: "Send screenshot to Open WebUI",
    contexts: ["page", "frame", "image", "selection", "link"],
  });
  chrome.contextMenus.create({
    id: "send-page-text",
    title: "Send page text to Open WebUI",
    contexts: ["page", "frame"],
  });
  chrome.storage.sync.get(
    ["openwebuiUrl", "targetMatchUrl", "browserControlEnabled", "autoScreenshotPaste"],
    (result) => {
      if (!result.openwebuiUrl) {
        chrome.storage.sync.set({ openwebuiUrl: "http://localhost:3000" });
      }
      if (result.browserControlEnabled === undefined) {
        chrome.storage.sync.set({ browserControlEnabled: true });
      }
      if (result.autoScreenshotPaste === undefined) {
        chrome.storage.sync.set({ autoScreenshotPaste: true });
      }
      if (!result.targetMatchUrl) {
        const url = result.openwebuiUrl || "http://localhost:3000";
        chrome.storage.sync.set({ targetMatchUrl: url + "/*" });
        registerScripts(url + "/*");
      } else if (result.targetMatchUrl) {
        registerScripts(result.targetMatchUrl);
      }
    }
  );
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "capture-and-send") captureAndSend(tab.id);
  if (info.menuItemId === "send-page-text") sendPageTextToChat(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "capture-and-send" && tab) captureAndSend(tab.id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "capture-request") {
    captureTabScreenshotForChat()
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === "page-text-request") {
    getCurrentUserTab()
      .then((tab) => {
        if (!tab) {
          throw new Error("Click the website tab you want to read, then click Page text again");
        }
        return sendPageTextToChat(tab.id);
      })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "sidekick-ping") {
    getCurrentUserTab()
      .then((tab) =>
        sendResponse({
          ok: true,
          browsedTab: tab
            ? { id: tab.id, url: tab.url, title: tab.title }
            : null,
        })
      )
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "RELOAD_SCRIPTS") {
    registerScripts(msg.targetMatchUrl);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "browser-command") {
    const requestId = msg.requestId || "";
    let run;
    if (requestId && inFlightBrowserCommands.has(requestId)) {
      run = inFlightBrowserCommands.get(requestId);
    } else {
      run = handleBrowserCommand(msg.command);
      if (requestId) {
        const tracked = run.finally(() => inFlightBrowserCommands.delete(requestId));
        inFlightBrowserCommands.set(requestId, tracked);
        run = tracked;
      }
    }
    run
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
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
  } catch (e) {
    console.error("register failed", e);
  }
}

function normalizeUrl(url) {
  let u = (url || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

function isValidTabId(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
}

function isUsableUserTab(tab) {
  return !!tab && isValidTabId(tab.id) && isBrowsableTab(tab);
}

async function resolveCaptureTab(preferredTabId) {
  if (isValidTabId(preferredTabId)) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (isUsableUserTab(tab) && !(await isAgentTargetTab(tab))) {
        rememberTab(tab);
        return tab;
      }
    } catch (_e) {}
  }

  const current = await getCurrentUserTab();
  if (current && isValidTabId(current.id)) return current;

  const win = await chrome.windows.getLastFocused({ populate: true }).catch(() => null);
  if (!win?.tabs?.length) return null;

  const browsable = [];
  for (const t of win.tabs) {
    if (!isUsableUserTab(t)) continue;
    if (!(await isAgentTargetTab(t))) browsable.push(t);
  }

  const active = browsable.find((t) => t.active);
  if (active) {
    rememberTab(active);
    return active;
  }
  if (browsable.length) {
    rememberTab(browsable[0]);
    return browsable[0];
  }

  return null;
}

async function captureTabScreenshotForChat(preferredTabId) {
  const tab = await resolveCaptureTab(preferredTabId);
  if (!tab || !isValidTabId(tab.id)) {
    throw new Error("Click the website tab you want to capture, then try again");
  }

  try {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
  } catch (_e) {}

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  rememberTab(tab);
  await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  return dataUrl;
}

async function deliverScreenshotToSidepanel(dataUrl) {
  try {
    await chrome.runtime.sendMessage({ type: "screenshot-ready", dataUrl });
    return true;
  } catch (_e) {
    return false;
  }
}

async function deliverCaptureErrorToSidepanel(error) {
  try {
    await chrome.runtime.sendMessage({
      type: "capture-error",
      error: String(error?.message || error),
    });
  } catch (_e) {}
}

async function captureAndSend(preferredTabId) {
  try {
    const dataUrl = await captureTabScreenshotForChat(preferredTabId);
    await deliverScreenshotToSidepanel(dataUrl);
  } catch (e) {
    console.error("capture failed", e);
    await deliverCaptureErrorToSidepanel(e);
  }
}

async function sendPageTextToChat(tabId) {
  rememberTab(await chrome.tabs.get(tabId));
  await ensureAgent(tabId);
  const page = await runAgentAction(tabId, "get_page_summary", {});
  await chrome.sidePanel.open({ tabId }).catch(() => {});
  const header = `[${page.title || "Page"}] ${page.url || ""}\n\n`;
  const body = page.text || "";
  const todo =
    page.todo_lines && page.todo_lines.length
      ? "\n\n---\nLikely tasks:\n" + page.todo_lines.join("\n")
      : "";
  await chrome.runtime
    .sendMessage({
      type: "auto-paste-text",
      text: header + body.slice(0, 12000) + todo,
    })
    .catch(() => {});
}

function rememberTab(tab) {
  if (isUsableUserTab(tab)) {
    lastBrowsedTabId = tab.id;
    lastUserTabId = tab.id;
  }
}

async function getOpenWebUIOrigins() {
  const settings = await chrome.storage.sync.get(["openwebuiUrl", "targetMatchUrl"]);
  const origins = new Set();
  const add = (raw) => {
    const u = (raw || "").trim().replace(/\/+$/, "");
    if (!u) return;
    try {
      origins.add(new URL(u.includes("://") ? u : `http://${u}`).origin.toLowerCase());
    } catch (_e) {
      origins.add(u.toLowerCase());
    }
  };
  add(settings.openwebuiUrl);
  const match = (settings.targetMatchUrl || "").replace(/\/\*$/, "");
  add(match);
  return origins;
}

async function isAgentTargetTab(tab) {
  if (!tab?.url) return false;
  const url = tab.url.toLowerCase();
  if (url.startsWith("chrome-extension://")) return true;
  const origins = await getOpenWebUIOrigins();
  for (const origin of origins) {
    if (url.startsWith(origin)) return true;
  }
  return false;
}

async function getCurrentUserTab() {
  const [focusedActive] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (
    isUsableUserTab(focusedActive) &&
    !(await isAgentTargetTab(focusedActive))
  ) {
    return focusedActive;
  }

  if (isValidTabId(lastUserTabId)) {
    try {
      const tab = await chrome.tabs.get(lastUserTabId);
      if (isUsableUserTab(tab) && !(await isAgentTargetTab(tab))) return tab;
    } catch (_e) {
      lastUserTabId = null;
    }
  }

  const win = await chrome.windows.getLastFocused({ populate: true });
  const candidates = [];
  for (const t of win.tabs || []) {
    if (!isUsableUserTab(t)) continue;
    if (!(await isAgentTargetTab(t))) candidates.push(t);
  }
  const activeInWin = candidates.find((t) => t.active);
  if (activeInWin) return activeInWin;

  const highlighted = candidates.filter((t) => t.highlighted);
  if (highlighted.length) return highlighted[highlighted.length - 1];

  return candidates[0] || null;
}

async function getBrowsedTab(opts = {}) {
  const tabId = Number(opts.tabId || 0);
  const useCurrent = !!opts.useCurrent;

  if (tabId > 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isBrowsableTab(tab) && !(await isAgentTargetTab(tab))) {
        rememberTab(tab);
        return tab;
      }
    } catch (_e) {}
  }

  if (useCurrent) {
    const current = await getCurrentUserTab();
    if (current) {
      rememberTab(current);
      return current;
    }
    throw new Error(
      "No website tab found. Click the page you want to control (e.g. Amazon), then call action=takeover."
    );
  }

  const current = await getCurrentUserTab();
  if (current) {
    if (lastBrowsedTabId && lastBrowsedTabId !== current.id) {
      try {
        const last = await chrome.tabs.get(lastBrowsedTabId);
        if (last.windowId === current.windowId) {
          rememberTab(current);
          return current;
        }
      } catch (_e) {
        lastBrowsedTabId = null;
      }
    } else if (!lastBrowsedTabId) {
      rememberTab(current);
      return current;
    }
  }

  if (lastBrowsedTabId) {
    try {
      const tab = await chrome.tabs.get(lastBrowsedTabId);
      if (isBrowsableTab(tab) && !(await isAgentTargetTab(tab))) return tab;
    } catch (_e) {
      lastBrowsedTabId = null;
    }
  }

  if (current) {
    rememberTab(current);
    return current;
  }

  return null;
}

function isBrowsableTab(tab) {
  if (!tab?.url) return false;
  return (
    !tab.url.startsWith("chrome://") &&
    !tab.url.startsWith("chrome-extension://") &&
    !tab.url.startsWith("edge://") &&
    !tab.url.startsWith("about:")
  );
}

async function ensureAgent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "AGENT_PING" });
    return;
  } catch (_e) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-agent.js"],
    });
  }
}

async function runAgentAction(tabId, action, params) {
  await ensureAgent(tabId);
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "AGENT_ACTION",
    action,
    params: params || {},
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Agent action failed");
  }
  return response.result;
}

function buildSearchUrl(query, engine, tabUrl) {
  const q = encodeURIComponent(query);
  const engineName = (engine || "google").toLowerCase();

  if (engineName === "site" || engineName === "current") {
    if (!tabUrl) throw new Error("site search requires an active tab URL");
    const parsed = new URL(tabUrl);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("amazon.")) {
      return `https://${host}/s?k=${q}`;
    }
    if (host.includes("ebay.")) {
      return `https://${host}/sch/i.html?_nkw=${q}`;
    }
    if (host.includes("walmart.")) {
      return `https://${host}/search?q=${q}`;
    }
    return `https://${host}/search?q=${q}`;
  }

  switch (engineName) {
    case "amazon":
      return `https://www.amazon.com/s?k=${q}`;
    case "bing":
      return `https://www.bing.com/search?q=${q}`;
    case "duckduckgo":
      return `https://duckduckgo.com/?q=${q}`;
    case "google":
    default:
      return `https://www.google.com/search?q=${q}`;
  }
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}

const SCREENSHOT_CAPTURE_OPTS = { format: "jpeg", quality: 72 };
const SCREENSHOT_INLINE_MAX_CHARS = 180000;

async function deliverScreenshotPayload(result, dataUrl) {
  const out = { ...result, screenshot_attached: !!dataUrl };
  if (!dataUrl) return out;

  if (dataUrl.length <= SCREENSHOT_INLINE_MAX_CHARS) {
    out.screenshot = dataUrl;
    return out;
  }

  try {
    await chrome.runtime.sendMessage({ type: "auto-paste-screenshot", dataUrl });
    out.screenshot_delivered_via = "paste";
    out.screenshot_bytes = dataUrl.length;
  } catch (_e) {
    out.screenshot = dataUrl.slice(0, SCREENSHOT_INLINE_MAX_CHARS);
    out.screenshot_truncated = true;
  }
  return out;
}

async function captureTabScreenshotFast(tab) {
  try {
    await withTimeout(chrome.tabs.update(tab.id, { active: true }), 900, "activate tab");
    await sleep(60);
  } catch (_e) {}
  const dataUrl = await withTimeout(
    chrome.tabs.captureVisibleTab(tab.windowId, SCREENSHOT_CAPTURE_OPTS),
    4000,
    "screenshot capture"
  );
  const fresh = await chrome.tabs.get(tab.id);
  return deliverScreenshotPayload(
    { url: fresh.url, title: fresh.title },
    dataUrl
  );
}

async function captureTabScreenshot(tab) {
  try {
    await withTimeout(chrome.tabs.update(tab.id, { active: true }), 2500, "activate tab");
    await sleep(180);
  } catch (_e) {}

  try {
    await withTimeout(runAgentAction(tab.id, "prepare_screenshot", {}), 1500, "prepare_screenshot");
  } catch (_e) {}

  const dataUrl = await withTimeout(
    chrome.tabs.captureVisibleTab(tab.windowId, SCREENSHOT_CAPTURE_OPTS),
    8000,
    "screenshot capture"
  );

  let viewport = null;
  try {
    viewport = await withTimeout(runAgentAction(tab.id, "get_viewport", {}), 1500, "get_viewport");
  } catch (_e) {}

  const fresh = await chrome.tabs.get(tab.id);
  return deliverScreenshotPayload(
    { url: fresh.url, title: fresh.title, viewport },
    dataUrl
  );
}

async function quickPageSnapshot(tabId) {
  try {
    const snap = await withTimeout(runAgentAction(tabId, "get_page_summary", {}), 2000, "page snapshot");
    const text = snap.text || "";
    const combined = `${tabId} ${text}`;
    const isQuiz = /quiz|canvas|blackboard|moodle|assessment|question/i.test(combined);
    return {
      page_snapshot: {
        text: text.slice(0, 2500),
        todo_lines: (snap.todo_lines || []).slice(0, 12),
        headings: (snap.headings || []).slice(0, 10),
      },
      page_type: isQuiz ? "quiz_page" : snap.page_type || null,
    };
  } catch (_e) {
    return null;
  }
}

function analyzePageState(payload) {
  const text = (payload.page_text || payload.text || "").toLowerCase();
  const url = (payload.page_url || payload.url || "").toLowerCase();
  const loginHints = /sign in|log in|login|password|sso|authenticate|session expired/;
  const looksLikeLogin =
    loginHints.test(text) ||
    /login|signin|auth|sso/.test(url) ||
    (text.includes("password") && text.includes("email"));

  return {
    likely_login_page: looksLikeLogin,
    has_todo_content: /to do|todo|assignment|due|overdue|submit|missing|quiz/.test(text),
    hint: looksLikeLogin
      ? "Page looks like a login screen. Ask the user to sign in, then call browser_agent again."
      : payload.todo_lines?.length
        ? "todo_lines may list assignments or tasks on this page."
        : "Use page_text, headings, links, and clickable_elements to continue.",
  };
}

async function resolveEnrichTab(result) {
  const tabId = Number(result?.tab?.id || result?.id || 0);
  if (tabId > 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isBrowsableTab(tab) && !(await isAgentTargetTab(tab))) return tab;
    } catch (_e) {}
  }
  return getBrowsedTab();
}

async function enrichTakeoverFast(command, result, tabHint) {
  const action = command?.action;
  const thought = command?.params?.thought;
  let tab = tabHint;
  if (!tab) tab = await resolveEnrichTab(result);
  const enriched = {
    ...result,
    navigation_mode: "screenshot",
    can_control_browser: true,
    takeover_complete: !!(result?.took_over || result?.takeover_complete),
  };

  if (!tab) {
    enriched.enrich_error = "No website tab found. Ask user to click the quiz/page tab, then call takeover.";
    enriched.model_instruction =
      "Ask user to click their website tab, then call browser_agent action=takeover. YOU CAN control the browser — never say you cannot.";
    enriched.agent_loop = buildAgentLoop(enriched, thought, action);
    return enriched;
  }

  rememberTab(tab);
  enriched.page_url = tab.url;
  enriched.page_title = tab.title;
  enriched.tab = { id: tab.id, url: tab.url, title: tab.title };
  enriched.forbidden_actions = ["takeover", "use_current_page", "screenshot"];
  enriched.forbidden_responses = [
    "asking user to paste page text",
    "asking user to share or describe screenshots",
    "claiming you cannot control the browser",
    "claiming you can only produce text in chat",
    "explaining a plan instead of calling browser_agent",
  ];
  enriched.coordinate_hint =
    "Use click_at with coordinate_system=normalized and x,y in 0.0-1.0.";
  enriched.screenshot_deferred = true;
  enriched.screenshot_missing = true;
  enriched.next_required_action = "screenshot";
  enriched.do_not_reply_to_user = true;
  enriched.must_call_tool_before_reply = true;
  enriched.model_instruction =
    "Takeover complete. Screenshot auto-chains in the same tool call — use dismiss_popups then click_at. " +
    "NEVER call action=screenshot separately (causes session disconnect). NEVER ask the user to paste anything.";
  enriched.suggested_actions = [
    { action: "dismiss_popups", why: "Close cookie/consent overlays first" },
    { action: "click_at", x: 0.5, y: 0.4, why: "Click an answer (screenshot auto-chains)" },
    { action: "scroll", direction: "down", amount: 500, why: "Reveal more questions" },
  ];
  await enrichQuizContext(tab, enriched, command);
  enriched.agent_loop = buildAgentLoop(enriched, thought, action);
  enriched.step_summary = buildActionSummary(action, command?.params, enriched);
  return enriched;
}

async function enrichWithPageState(command, result, tabHint) {
  try {
  const action = command?.action;
  const navigationMode = command?.navigation_mode || "text";
  const isScreenshotNav = navigationMode === "screenshot";
  if (
    isScreenshotNav &&
    (action === "takeover" || action === "use_current_page")
  ) {
    return enrichTakeoverFast(command, result, tabHint);
  }

  const shouldCaptureScreenshot =
    isScreenshotNav && SCREENSHOT_NAV_ACTIONS.has(action);
  const shouldEnrichText =
    !isScreenshotNav &&
    command?.auto_include_page_text !== false &&
    ENRICH_PAGE_STATE_ACTIONS.has(action);

  if (!shouldEnrichText && !shouldCaptureScreenshot && command?.auto_screenshot !== true) {
    return result;
  }

  const tab = await resolveEnrichTab(result);
  if (!tab) {
    return {
      ...result,
      enrich_error: "No browsable tab found. Click the website/quiz tab, then retry.",
    };
  }

  const enriched = { ...result, navigation_mode: navigationMode };

  if (shouldCaptureScreenshot) {
    await sleep(80);
    const snap = await quickPageSnapshot(tab.id);
    if (snap) {
      enriched.page_snapshot = snap.page_snapshot;
      if (snap.page_type) enriched.page_type = snap.page_type;
    }
    try {
      const shot = await captureTabScreenshot(tab);
      enriched.screenshot = shot.screenshot;
      enriched.page_url = shot.url || enriched.url;
      enriched.page_title = shot.title || enriched.title;
      enriched.viewport = shot.viewport;
      enriched.screenshot_attached = shot.screenshot_attached || !!shot.screenshot;
      if (shot.screenshot_delivered_via) {
        enriched.screenshot_delivered_via = shot.screenshot_delivered_via;
      }
      enriched.takeover_complete = !!(
        result?.took_over ||
        enriched.took_over ||
        result?.takeover_complete
      );
      enriched.step_summary = buildActionSummary(action, command?.params, enriched);
      enriched.coordinate_hint =
        "Use click_at with coordinate_system=normalized and x,y in 0.0-1.0 relative to the screenshot viewport.";
      if (enriched.skipped_takeover || enriched.already_controlled) {
        enriched.forbidden_actions = ["takeover", "use_current_page", "screenshot"];
        enriched.model_instruction = enriched.screenshot_attached
          ? "takeover is FORBIDDEN — already connected. NEXT: click_at, scroll, dismiss_popups, type, or press_key."
          : "takeover is FORBIDDEN — already connected. NEXT: dismiss_popups or click_at (screenshot auto-chains). Do NOT call action=screenshot separately.";
      } else if (enriched.page_type === "quiz_page") {
        enriched.model_instruction =
          "Quiz page open. Use click_at to select answers, scroll to see more, dismiss_popups if needed. NEVER call takeover again.";
      } else {
        enriched.model_instruction =
          "LOOP: Study the screenshot attached to this tool result. THINK in your reasoning, then call browser_agent with thought=... and ONE action. Prefer click_at (x,y) for clicks. Do NOT answer the user until agent_loop.task_done is true.";
      }
      enriched.suggested_actions = buildSuggestedActions(enriched);
      enriched.agent_loop = buildAgentLoop(enriched, command?.params?.thought, action);
    } catch (e) {
      enriched.screenshot_error = String(e.message || e);
      enriched.page_url = enriched.page_url || tab.url;
      enriched.page_title = enriched.page_title || tab.title;
      enriched.model_instruction =
        "Screenshot failed — use page_snapshot if present. NEXT: click_at, scroll, or dismiss_popups. Do NOT call takeover.";
    }
  }

  if (shouldEnrichText) {
    await sleep(300);

    if (!enriched.page_text && !enriched.text) {
      try {
        const page = await runAgentAction(tab.id, "get_page_summary", {});
        enriched.page_text = page.text;
        enriched.page_url = page.url || enriched.url;
        enriched.page_title = page.title || enriched.title;
        enriched.headings = page.headings || [];
        enriched.links = page.links || [];
        enriched.todo_lines = page.todo_lines || [];
        if (page.products?.length) {
          enriched.products = page.products;
          enriched.product_lines = page.product_lines || [];
          enriched.result_count = page.result_count;
          enriched.page_type = page.page_type;
        }
      } catch (e) {
        enriched.page_text_error = String(e.message || e);
      }
    } else {
      if (enriched.text && !enriched.page_text) enriched.page_text = enriched.text;
      enriched.page_url = enriched.page_url || enriched.url;
      enriched.page_title = enriched.page_title || enriched.title;
    }

    if (!enriched.clickable_elements) {
      try {
        const elements = await runAgentAction(tab.id, "get_interactive_elements", {});
        enriched.clickable_elements = (elements.elements || []).slice(0, 30).map((el) => ({
          index: el.index,
          tag: el.tag,
          text: el.text,
          is_search: el.is_search,
        }));
        enriched.search_box_indexes = elements.search_box_indexes || [];
      } catch (e) {
        enriched.elements_error = String(e.message || e);
      }
    }

    enriched.page_state = analyzePageState(enriched);
    if (result?.typed && !result?.submitted && !result?.auto_submitted) {
      enriched.next_action =
        "Text was typed but not submitted. Call browser_agent with action=type_and_submit or action=press_key key=Enter, or use action=search.";
    } else if (result?.auto_submitted || result?.submitted) {
      enriched.next_action =
        "Search/form was submitted. Read product_lines and page_text in this response. Only cite products listed in product_lines.";
    }

    if (enriched.products?.length) {
      const under30 = enriched.products.filter(
        (p) => p.price_usd != null && p.price_usd <= 30
      );
      if (under30.length) {
        enriched.products_under_30_usd = under30.map((p) => ({
          index: p.index,
          title: p.title,
          price: p.price,
          rating: p.rating,
          reviews: p.reviews,
          href: p.href,
        }));
      }
      enriched.model_instruction =
        "LOOP: Read agent_loop + products. THINK in your reasoning, then call browser_agent again with thought=... and ONE action. To open a product use action=click_product, product_index=N (from products[].index). Do NOT answer the user until agent_loop.task_done is true.";
    } else {
      enriched.model_instruction =
        "LOOP: Read agent_loop + page_text. THINK, then call browser_agent with thought=... and ONE next action. Do NOT answer the user until the browsing goal is complete.";
    }

    enriched.suggested_actions = buildSuggestedActions(enriched);
    enriched.agent_loop = buildAgentLoop(enriched, command?.params?.thought, action);
  }

  if (tab && (enriched.quiz_mode || isQuizContext(enriched, command?.params?.goal))) {
    await enrichQuizContext(tab, enriched, command);
  }

  if (
    enriched.quiz_mode &&
    (action === "click_at" ||
      action === "click_quiz_answer" ||
      action === "click_quiz_next" ||
      action === "solve_quiz_step")
  ) {
    if (
      result?.quiz_submitted ||
      (result?.is_quiz_control && /submit|finish|results|done|see/i.test(result?.text || "")) ||
      (result?.next?.is_quiz_control &&
        /submit|finish|results|done|see/i.test(result?.next?.text || ""))
    ) {
      enriched.quiz_submitted = true;
    } else if (result?.is_quiz_option || result?.answer_clicked || result?.clicked) {
      enriched.quiz_answers_clicked = (enriched.quiz_answers_clicked || 0) + 1;
    }
    enriched.agent_loop = buildAgentLoop(enriched, command?.params?.thought, action);
  }

  if (
    isScreenshotNav &&
    action === "scroll" &&
    enriched.scroll_effective === false
  ) {
    enriched.model_instruction =
      "Window scroll barely moved — this page scrolls inside an inner container (see scroll_targets). " +
      "Use click_at on visible quiz answers, or press_key PageDown / Tab. Do NOT ask the user to paste.";
    enriched.suggested_actions = [
      {
        action: "click_at",
        x: 0.5,
        y: 0.55,
        coordinate_system: "normalized",
        why: "Click a visible answer option",
      },
      { action: "press_key", key: "PageDown", why: "Scroll inner quiz content" },
      { action: "press_key", key: "Tab", why: "Focus next quiz option" },
    ];
  }

  const pasteScreenshot =
    command?.auto_screenshot === true &&
    OPTIONAL_SCREENSHOT_PASTE_ACTIONS.has(action);
  if (pasteScreenshot && tab) {
    const settings = await chrome.storage.sync.get(["autoScreenshotPaste"]);
    if (settings.autoScreenshotPaste !== false) {
      try {
        const shot = await captureTabScreenshot(tab);
        const dataUrl = shot.screenshot;
        if (dataUrl) {
          chrome.runtime
            .sendMessage({
              type: "auto-paste-screenshot",
              dataUrl,
              meta: { action, url: shot.url, title: shot.title },
            })
            .catch(() => {});
          enriched.screenshot_pasted_for_user = true;
        } else if (shot.screenshot_delivered_via === "paste") {
          enriched.screenshot_pasted_for_user = true;
        }
      } catch (_e) {}
    }
  }

  return enriched;
  } catch (e) {
    return {
      ...result,
      enrich_error: String(e.message || e),
      model_instruction:
        "Browser step had an error. Try click_at, scroll, or dismiss_popups. Do NOT call takeover again.",
    };
  }
}

async function navigateTab(tabId, url, waitMs) {
  const finalUrl = normalizeUrl(url);
  if (!finalUrl) throw new Error("url is required");
  await chrome.tabs.update(tabId, { url: finalUrl });
  await waitForTabLoad(tabId, waitMs);
  await sleep(350);
  const updated = await chrome.tabs.get(tabId);
  rememberTab(updated);
  return updated;
}

async function handleBrowserCommand(command) {
  const settings = await chrome.storage.sync.get(["browserControlEnabled"]);
  if (settings.browserControlEnabled === false) {
    throw new Error("Browser control is disabled in extension options");
  }

  const action = command?.action;
  const params = command?.params || {};
  if (!action) throw new Error("Missing browser action");

  const preferCurrent =
    !!params.use_current_tab ||
    ["takeover", "use_current_page", "get_active_tab"].includes(action);

  let result;
  let tab = await getBrowsedTab({
    tabId: params.tab_id,
    useCurrent: preferCurrent,
  });

  switch (action) {
    case "ping":
      result = {
        connected: true,
        extension: "Open WebUI Browser Agent",
        version: EXTENSION_VERSION,
        browsed_tab: tab
          ? { id: tab.id, url: tab.url, title: tab.title }
          : null,
      };
      break;

    case "takeover":
    case "use_current_page": {
      if (!tab) {
        throw new Error(
          "No website tab to take over. Click the quiz/website tab first (not the side panel), then call action=takeover once."
        );
      }
      rememberTab(tab);
      tab = await chrome.tabs.get(tab.id);

      const alreadyControlled =
        agentControlActive && agentControlledTabId === tab.id;

      if (alreadyControlled) {
        result = {
          skipped_takeover: true,
          already_controlled: true,
          takeover_complete: true,
          forbidden_actions: ["takeover", "use_current_page"],
          tab: { id: tab.id, url: tab.url, title: tab.title },
          url: tab.url,
          title: tab.title,
        };
        break;
      }

      agentControlActive = true;
      agentControlledTabId = tab.id;

      if ((command?.navigation_mode || "text") === "screenshot") {
        const isQuiz = /quiz|canvas|blackboard|moodle|assessment|question/i.test(
          tab.url || ""
        );
        result = {
          took_over: true,
          takeover_complete: true,
          tab: { id: tab.id, url: tab.url, title: tab.title },
          url: tab.url,
          title: tab.title,
          page_type: isQuiz ? "quiz_page" : null,
        };
      } else {
        const page = await runAgentAction(tab.id, "get_page_summary", {});
        result = {
          took_over: true,
          takeover_complete: true,
          tab: { id: tab.id, url: tab.url, title: tab.title },
          url: page.url,
          title: page.title,
          text: page.text,
          products: page.products,
          product_lines: page.product_lines,
          page_type: page.page_type,
        };
        tab = await chrome.tabs.get(tab.id);
      }
      break;
    }

    case "release_control":
      agentControlActive = false;
      agentControlledTabId = null;
      result = { released: true };
      break;

    case "get_active_tab": {
      if (!tab) throw new Error("No browsable tab found. Click a website tab, then call action=takeover.");
      result = { id: tab.id, url: tab.url, title: tab.title, active: tab.active };
      break;
    }

    case "list_tabs": {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      result = tabs
        .filter(isBrowsableTab)
        .map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
      break;
    }

    case "switch_tab": {
      const tabId = Number(params.tab_id);
      if (!tabId) throw new Error("tab_id is required");
      tab = await chrome.tabs.update(tabId, { active: true });
      rememberTab(tab);
      result = { id: tab.id, url: tab.url, title: tab.title, active: true };
      break;
    }

    case "open_tab": {
      const finalUrl = normalizeUrl(params.url || "");
      if (!finalUrl) throw new Error("url is required");
      tab = await chrome.tabs.create({ url: finalUrl, active: true });
      rememberTab(tab);
      const waitMs = Math.min(Number(params.wait_ms) || 2500, 10000);
      await waitForTabLoad(tab.id, waitMs);
      tab = await chrome.tabs.get(tab.id);
      result = { opened: true, id: tab.id, url: tab.url, title: tab.title };
      break;
    }

    case "search": {
      const query = (params.query || "").trim();
      if (!query) throw new Error("query is required");
      if (!tab) throw new Error("No browsable tab found");
      let engine = params.engine || "google";
      if (!params.engine && /amazon\./i.test(tab.url || "")) {
        engine = "site";
      }
      const searchUrl = buildSearchUrl(query, engine, tab.url);
      const waitMs = Math.min(Number(params.wait_ms) || 2500, 10000);
      const isAmazon = /amazon\./i.test(searchUrl);
      tab = await navigateTab(tab.id, searchUrl, isAmazon ? Math.max(waitMs, 4000) : waitMs);
      if (isAmazon) await sleep(800);
      result = {
        searched: true,
        query,
        engine: params.engine || engine,
        url: tab.url,
        title: tab.title,
      };
      break;
    }

    case "navigate": {
      if (!tab) throw new Error("No browsable tab found");
      const navWait = Math.min(Number(params.wait_ms) || 2500, 10000);
      const isAmazonNav = /amazon\./i.test(normalizeUrl(params.url || ""));
      tab = await navigateTab(
        tab.id,
        params.url,
        isAmazonNav ? Math.max(navWait, 4000) : navWait
      );
      if (isAmazonNav) await sleep(800);
      result = { id: tab.id, url: tab.url, title: tab.title };
      break;
    }

    case "reload": {
      if (!tab) throw new Error("No browsable tab found");
      await chrome.tabs.reload(tab.id);
      const waitMs = Math.min(Number(params.wait_ms) || 1500, 10000);
      await waitForTabLoad(tab.id, waitMs);
      tab = await chrome.tabs.get(tab.id);
      rememberTab(tab);
      result = { id: tab.id, url: tab.url, title: tab.title };
      break;
    }

    case "screenshot": {
      if (!tab) throw new Error("No browsable tab found");
      result = await captureTabScreenshot(tab);
      break;
    }

    case "get_page_text":
    case "get_page_summary":
    case "get_page_html":
    case "get_interactive_elements":
    case "solve_quiz_step": {
      if (!tab) throw new Error("No browsable tab found");
      const answer = String(params.answer || params.text || "").trim();
      if (!answer) {
        throw new Error("solve_quiz_step requires answer='A'-'F' (or text=...)");
      }
      const answerResult = await runAgentAction(tab.id, "click_quiz_answer", {
        ...params,
        answer,
      });
      await sleep(500);
      let nextResult = null;
      let nextError = null;
      try {
        nextResult = await runAgentAction(tab.id, "click_quiz_next", {});
      } catch (e) {
        nextError = String(e.message || e);
      }
      const nextText = nextResult?.text || "";
      const quizSubmitted =
        !!(
          nextResult?.is_quiz_control &&
          /submit|finish|results|done|see/i.test(nextText)
        );
      result = {
        solve_quiz_step: true,
        answer: answerResult?.answer || answer,
        answer_clicked: !!answerResult?.clicked,
        next_clicked: !!nextResult?.clicked,
        next_error: nextError,
        quiz_submitted: quizSubmitted,
        is_quiz_option: true,
        is_quiz_control: !!nextResult?.is_quiz_control,
        text: nextText || answerResult?.text,
        ...answerResult,
        next: nextResult || { clicked: false, error: nextError },
      };
      await sleep(quizSubmitted ? 900 : 650);
      tab = await chrome.tabs.get(tab.id);
      result.url = tab.url;
      result.title = tab.title;
      break;
    }

    case "get_quiz_options":
    case "click_quiz_answer":
    case "click_quiz_next":
    case "dismiss_popups":
    case "click_product":
    case "click_at":
    case "click":
    case "type":
    case "type_and_submit":
    case "select":
    case "scroll":
    case "press_key":
    case "go_back":
    case "go_forward":
    case "wait": {
      if (!tab) throw new Error("No browsable tab found");
      const agentAction = action === "get_page_text" ? "get_page_summary" : action;
      result = await runAgentAction(tab.id, agentAction, params);
      if (action === "wait") {
        await sleep(Math.min(Number(params.ms) || 1000, 10000));
      } else if (action === "go_back" || action === "go_forward") {
        await sleep(1200);
        tab = await chrome.tabs.get(tab.id);
        result = { ...result, url: tab.url, title: tab.title };
      } else if (
        ["click", "click_at", "click_product", "type", "type_and_submit", "select", "press_key", "dismiss_popups"].includes(
          action
        )
      ) {
        const submitted =
          result?.submitted || result?.auto_submitted || result?.submit_method;
        const navigates = result?.navigates || result?.clicked_product;
        if (submitted || navigates) {
          await waitForTabLoad(tab.id, 10000);
          await sleep(600);
          tab = await chrome.tabs.get(tab.id);
          rememberTab(tab);
          result = { ...result, url: tab.url, title: tab.title };
        } else {
          await sleep(700);
        }
      }
      break;
    }

    default:
      throw new Error(`Unknown browser action: ${action}`);
  }

  const isScreenshotNav = (command?.navigation_mode || "text") === "screenshot";
  if (action === "screenshot" && !isScreenshotNav) delete result.screenshot;

  if (action === "ping") {
    return { ...result, can_control_browser: true, connected: true };
  }

  if (isScreenshotNav && (action === "takeover" || action === "use_current_page")) {
    return enrichTakeoverFast(command, result, tab);
  }

  if (
    isScreenshotNav ||
    ENRICH_PAGE_STATE_ACTIONS.has(action) ||
    command?.auto_include_page_text !== false ||
    command?.auto_screenshot === true
  ) {
    return enrichWithPageState(command, result, tab);
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}