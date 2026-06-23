(function () {
  if (window.__OWUI_AGENT_READY__) return;
  window.__OWUI_AGENT_READY__ = true;

  const MAX_TEXT = 50000;
  const MAX_HTML = 100000;

  const INTERACTIVE_SELECTOR =
    'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="searchbox"], [role="combobox"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';

  const DISMISS_RE =
    /^(accept|accept all|agree|allow|allow all|got it|ok|okay|close|dismiss|continue|i understand|no thanks)$/i;

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function labelFor(el) {
    const text = (
      el.innerText ||
      el.textContent ||
      el.value ||
      el.placeholder ||
      el.getAttribute("aria-label") ||
      el.getAttribute("name") ||
      ""
    ).trim();
    return text.slice(0, 120);
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        part += "." + Array.from(node.classList)
          .slice(0, 2)
          .map((c) => CSS.escape(c))
          .join(".");
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      if (node.id) break;
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function isSearchField(el) {
    const name = (el.getAttribute("name") || "").toLowerCase();
    const id = (el.id || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
    const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
    return (
      name === "q" ||
      name === "field-keywords" ||
      name === "search" ||
      name === "query" ||
      id.includes("search") ||
      id === "twotabsearchtextbox" ||
      role === "searchbox" ||
      type === "search" ||
      placeholder.includes("search") ||
      ariaLabel.includes("search")
    );
  }

  function contentRoot() {
    const containers = collectScrollContainers();
    const top = containers.find((c) => c.el !== document.documentElement);
    if (top?.el) return top.el;
    return (
      document.querySelector(
        'main, [role="main"], #content, .ic-Layout-contentMain, #main, article, .content'
      ) || document.body
    );
  }

  function isScrollableElement(el, win = window) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === "html") {
      return (document.documentElement.scrollHeight || 0) > win.innerHeight + 8;
    }
    if (!visible(el)) return false;
    const canScroll = el.scrollHeight > el.clientHeight + 4;
    if (!canScroll) return false;
    const style = win.getComputedStyle(el);
    const oy = style.overflowY;
    const o = style.overflow;
    if (/(auto|scroll|overlay)/.test(oy) || /(auto|scroll|overlay)/.test(o)) return true;
    return el.clientHeight >= win.innerHeight * 0.3;
  }

  function collectScrollContainers(root = document) {
    const doc = root.ownerDocument || root;
    const win = doc.defaultView || window;
    const list = [];

    if ((doc.documentElement?.scrollHeight || 0) > win.innerHeight + 8) {
      list.push({
        el: doc.documentElement,
        overflow: doc.documentElement.scrollHeight - win.innerHeight,
        kind: "document",
      });
    }

    const nodes = root.querySelectorAll?.(
      "main, [role='main'], article, #content, .content, section, div, iframe"
    );
    if (nodes) {
      for (const el of nodes) {
        if (el.tagName === "IFRAME") {
          try {
            if (el.contentDocument) list.push(...collectScrollContainers(el.contentDocument));
          } catch (_e) {}
          continue;
        }
        if (isScrollableElement(el, win)) {
          list.push({
            el,
            overflow: el.scrollHeight - el.clientHeight,
            kind: "element",
          });
        }
      }
    }

    return list.sort((a, b) => b.overflow - a.overflow);
  }

  function scrollElementMetrics(el, win = window) {
    if (!el || el === document.documentElement) {
      return {
        target: "window",
        scrollTop: win.scrollY,
        scrollLeft: win.scrollX,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: win.innerHeight,
      };
    }
    return {
      target: cssPath(el),
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  }

  function getScrollState() {
    return {
      scroll_containers: collectScrollContainers()
        .slice(0, 4)
        .map((c) => ({
          ...scrollElementMetrics(c.el),
          overflow: c.overflow,
        })),
    };
  }

  function extractDocumentText(doc = document) {
    const win = doc.defaultView || window;
    const parts = [];
    const root =
      doc.querySelector(
        'main, [role="main"], #content, .ic-Layout-contentMain, #main, article, .content'
      ) || doc.body;
    if (root) parts.push(cleanText(root.innerText || ""));

    for (const iframe of doc.querySelectorAll("iframe")) {
      try {
        if (iframe.contentDocument) {
          const nested = extractDocumentText(iframe.contentDocument);
          if (nested) parts.push(nested);
        }
      } catch (_e) {}
    }

    const containers = collectScrollContainers(doc);
    for (const c of containers.slice(0, 3)) {
      if (c.el === doc.documentElement || c.el === doc.body) continue;
      const t = cleanText(c.el.innerText || "");
      if (t && t.length > 20 && !parts.join("\n").includes(t.slice(0, 80))) parts.push(t);
    }

    return parts.filter(Boolean).join("\n\n").slice(0, MAX_TEXT);
  }

  async function smartScroll(params) {
    const amount = Number(params.amount) || 400;
    const direction = params.direction || "down";
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
    const beforeWin = window.scrollY;
    const scrolled = [];

    if (params.selector) {
      const el = resolveTarget(params);
      const before = el.scrollTop;
      el.scrollBy({ left: dx, top: dy, behavior: "instant" });
      const delta = el.scrollTop - before;
      return {
        scrolled: true,
        direction,
        amount,
        scroll_target: cssPath(el),
        container_delta: delta,
        window_delta: window.scrollY - beforeWin,
        scroll_effective: Math.abs(delta) >= 20,
        ...getScrollState(),
      };
    }

    const containers = collectScrollContainers();
    const targets = containers.length
      ? containers.map((c) => c.el)
      : [document.documentElement];
    let totalDelta = 0;

    for (const el of targets.slice(0, 6)) {
      const before = el === document.documentElement ? window.scrollY : el.scrollTop;
      if (el === document.documentElement) {
        window.scrollBy({ left: dx, top: dy, behavior: "instant" });
      } else {
        el.scrollBy({ left: dx, top: dy, behavior: "instant" });
      }
      const after = el === document.documentElement ? window.scrollY : el.scrollTop;
      const delta = after - before;
      if (Math.abs(delta) > 2) {
        scrolled.push({
          target: el === document.documentElement ? "window" : cssPath(el),
          delta,
        });
        totalDelta += Math.abs(delta);
      }
      if (totalDelta >= Math.min(amount * 0.45, 120)) break;
    }

    if (dy > 0 && totalDelta < 50 && window.scrollY - beforeWin < 40) {
      const focusEl = containers.find((c) => c.el !== document.documentElement)?.el || document.body;
      if (focusEl?.focus) focusEl.focus({ preventScroll: true });
      const steps = Math.max(1, Math.min(6, Math.round(amount / 500)));
      for (let i = 0; i < steps; i++) {
        pressKey(focusEl, "PageDown");
        await new Promise((r) => setTimeout(r, 90));
      }
      scrolled.push({ target: "pagedown", steps });
      totalDelta += steps * 120;
    }

    const windowDelta = window.scrollY - beforeWin;
    const effective = totalDelta >= 40 || Math.abs(windowDelta) >= 40;
    return {
      scrolled: true,
      direction,
      amount,
      scroll_targets: scrolled,
      window_scrollY: window.scrollY,
      window_delta: windowDelta,
      scroll_effective: effective,
      hint: effective
        ? null
        : "Window barely moved — page likely uses a fixed layout. Use click_at on visible quiz options, or press_key PageDown/Tab.",
      ...getScrollState(),
    };
  }

  function cleanText(text) {
    return (text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function interactiveNodes() {
    return Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(visible);
  }

  function interactiveElements() {
    return interactiveNodes().slice(0, 80).map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || el.getAttribute("role") || "",
      text: labelFor(el),
      href: el.href || "",
      selector: cssPath(el),
      is_search: isSearchField(el),
    }));
  }

  function parseAmazonPrice(card) {
    const offscreen = card.querySelector(".a-price .a-offscreen, .a-price[data-a-color='price'] .a-offscreen");
    if (offscreen) return cleanText(offscreen.textContent);
    const whole = card.querySelector(".a-price-whole");
    const frac = card.querySelector(".a-price-fraction");
    if (whole) {
      const w = cleanText(whole.textContent).replace(/[^\d]/g, "");
      const f = frac ? cleanText(frac.textContent).replace(/[^\d]/g, "") : "";
      return w ? `$${w}${f ? "." + f : ""}` : "";
    }
    return "";
  }

  function parsePriceNumber(price) {
    const m = (price || "").replace(/,/g, "").match(/\$?\s*([\d]+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  function parseAmazonRating(card) {
    const alt = card.querySelector(".a-icon-alt");
    if (!alt) return "";
    const m = (alt.textContent || "").match(/([\d.]+)\s+out of/i);
    return m ? m[1] : "";
  }

  function extractAmazonProducts() {
    if (!/amazon\./i.test(location.hostname)) return [];

    const cards = Array.from(
      document.querySelectorAll(
        'div[data-component-type="s-search-result"][data-asin], div.s-result-item[data-asin], [data-asin][data-uuid]'
      )
    ).filter((el) => {
      const asin = el.getAttribute("data-asin");
      return asin && asin.length >= 8 && visible(el);
    });

    const seen = new Set();
    const products = [];

    for (const card of cards) {
      const asin = card.getAttribute("data-asin");
      if (seen.has(asin)) continue;
      seen.add(asin);

      const titleEl =
        card.querySelector("h2 a span") ||
        card.querySelector("h2 span.a-text-normal") ||
        card.querySelector("a.a-link-normal.s-line-clamp-2 span");
      const title = cleanText(titleEl?.textContent || "").slice(0, 220);
      if (!title || title.length < 8) continue;

      const price = parseAmazonPrice(card);
      const rating = parseAmazonRating(card);
      const reviewsEl = card.querySelector(
        "span.a-size-base.s-underline-text, a.s-underline-text span.a-size-base, .a-size-base.a-color-secondary"
      );
      const reviews = cleanText(reviewsEl?.textContent || "");
      const linkEl = card.querySelector('h2 a[href*="/dp/"], a.a-link-normal[href*="/dp/"]');
      const href = linkEl?.href || "";
      const sponsored = /\bsponsored\b/i.test((card.innerText || "").slice(0, 600));

      products.push({
        index: products.length + 1,
        asin,
        title,
        price,
        price_usd: parsePriceNumber(price),
        rating,
        reviews,
        href,
        sponsored,
      });
      if (products.length >= 24) break;
    }

    return products;
  }

  function formatProductLines(products) {
    return products.map((p) => {
      const bits = [`${p.index}. ${p.title}`];
      if (p.price) bits.push(p.price);
      if (p.rating) bits.push(`${p.rating}★`);
      if (p.reviews) bits.push(`(${p.reviews})`);
      if (p.sponsored) bits.push("[Sponsored]");
      bits.push(`→ click_product product_index=${p.index}`);
      return bits.join(" — ");
    });
  }

  function pageSnapshot() {
    const root = contentRoot();
    let text = extractDocumentText() || cleanText(root.innerText || document.body?.innerText || "");
    text = text.slice(0, MAX_TEXT);

    const products = extractAmazonProducts();
    const product_lines = formatProductLines(products);

    if (product_lines.length) {
      const block =
        "--- PRODUCTS VISIBLE ON THIS PAGE (use ONLY these; do not invent others) ---\n" +
        product_lines.join("\n") +
        "\n--- END PRODUCTS ---\n\n";
      text = (block + text).slice(0, MAX_TEXT);
    }

    const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5"))
      .filter(visible)
      .slice(0, 24)
      .map((h) => ({ level: h.tagName.toLowerCase(), text: cleanText(h.innerText).slice(0, 160) }))
      .filter((h) => h.text);

    const links = Array.from(root.querySelectorAll("a[href]"))
      .filter(visible)
      .slice(0, 35)
      .map((a) => ({
        text: cleanText(a.innerText || a.textContent).slice(0, 100),
        href: a.href,
      }))
      .filter((l) => l.text || l.href);

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const todo_lines = lines
      .filter((line) => /due|assignment|todo|to-do|submit|missing|overdue|quiz|exam/i.test(line))
      .slice(0, 20);

    const resultCountMatch = text.match(/(\d[\d,]*)\s+results for/i);
    const result_count = resultCountMatch ? resultCountMatch[1].replace(/,/g, "") : null;

    return {
      url: location.href,
      title: document.title,
      text,
      headings,
      links,
      todo_lines,
      products,
      product_lines,
      result_count,
      page_type: products.length
        ? "amazon_search_results"
        : /quiz|question|wildlife|assessment/i.test(`${text}\n${location.href}`)
          ? "quiz_page"
          : null,
    };
  }

  async function preparePageForSnapshot() {
    if (!/amazon\./i.test(location.hostname)) return;
    window.scrollTo({ top: 0, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 250));
    window.scrollBy({ top: 500, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 350));
    window.scrollTo({ top: 0, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 200));
  }

  function isTypable(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return !["button", "submit", "reset", "checkbox", "radio", "file", "hidden", "image"].includes(
        type
      );
    }
    return !!el.isContentEditable;
  }

  function resolveTarget(params) {
    if (typeof params.index === "number" && params.index >= 0) {
      const nodes = interactiveNodes();
      const el = nodes[params.index];
      if (!el) throw new Error(`No interactive element at index ${params.index}`);
      return el;
    }
    if (params.selector) {
      const el = document.querySelector(params.selector);
      if (!el) throw new Error(`Selector not found: ${params.selector}`);
      return el;
    }
    throw new Error("Provide selector or index");
  }

  function resolveTypeTarget(params) {
    if (
      (typeof params.index === "number" && params.index >= 0) ||
      params.selector
    ) {
      return { el: resolveTarget(params), auto_target: null };
    }

    const typable = interactiveNodes().filter(isTypable);
    const mode = (params.target || "auto").toLowerCase();

    if (mode === "focused" || mode === "auto") {
      const active = document.activeElement;
      if (active && isTypable(active) && visible(active)) {
        return { el: active, auto_target: "focused" };
      }
    }

    if (mode === "search" || mode === "auto" || params.prefer_search) {
      const search = typable.find(isSearchField);
      if (search) return { el: search, auto_target: "search" };
    }

    if (mode === "first_input" || mode === "auto") {
      const first = typable.find((el) => {
        const tag = el.tagName.toLowerCase();
        return tag === "textarea" || tag === "input";
      });
      if (first) return { el: first, auto_target: "first_input" };
    }

    const hint = interactiveElements()
      .filter((e) => e.tag === "input" || e.tag === "textarea")
      .slice(0, 5)
      .map((e) => `${e.index}: ${e.text || e.type || e.tag}`)
      .join("; ");

    throw new Error(
      "No input field found to type into. " +
        (hint ? `Try index from: ${hint}. ` : "") +
        "Call get_interactive_elements first, or use action=search for web search."
    );
  }

  function dispatchInput(el, text, clear) {
    el.focus();
    if ("value" in el) {
      if (clear) el.value = "";
      el.value = clear ? text : (el.value || "") + text;
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text,
        })
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    }
    if (el.isContentEditable) {
      if (clear) el.textContent = "";
      el.textContent = (el.textContent || "") + text;
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text,
        })
      );
      return el.textContent;
    }
    return text;
  }

  const KEY_SPECS = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13, which: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9, which: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27, which: 27 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34, which: 34 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33, which: 33 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, which: 38 },
    " ": { key: " ", code: "Space", keyCode: 32, which: 32 },
    Space: { key: " ", code: "Space", keyCode: 32, which: 32 },
  };

  function pressKey(target, key) {
    const spec = KEY_SPECS[key] || { key, code: key, keyCode: 0, which: 0 };
    const opts = { bubbles: true, cancelable: true, ...spec };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  function submitSearchForm(el) {
    const form = el.closest("form");
    if (!form) return null;

    const submitBtn = form.querySelector(
      'input[type="submit"], button[type="submit"], #nav-search-submit-button, [aria-label*="Search" i], [aria-label*="Go" i]'
    );
    if (submitBtn && visible(submitBtn)) {
      humanClick(submitBtn);
      return "search_button";
    }
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return "request_submit";
    }
    form.submit();
    return "form_submit";
  }

  function maybeAutoSubmitSearch(el, params) {
    if (!params.prefer_search || !isSearchField(el)) return null;
    const method = submitSearchForm(el);
    if (method) return method;
    pressKey(el, params.key || "Enter");
    return "enter_key";
  }

  function humanClick(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    clickAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, el);
  }

  function resolveClickCoords(params) {
    let system = (params.coordinate_system || "normalized").toLowerCase();
    let x = Number(params.x);
    let y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("click_at requires numeric x and y");
    }

    if ((system === "normalized" || system === "norm") && (x > 1.05 || y > 1.05)) {
      if (x <= 1000 && y <= 1000) system = "permille";
      else system = "pixel";
    }

    let clamped = false;
    if (system === "pixel" || system === "pixels") {
      return { x, y, coordinate_system_used: "pixel" };
    }
    if (system === "permille" || system === "1000") {
      return {
        x: (x / 1000) * window.innerWidth,
        y: (y / 1000) * window.innerHeight,
        coordinate_system_used: "permille",
      };
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) clamped = true;
    x = Math.max(0.02, Math.min(0.98, x));
    y = Math.max(0.02, Math.min(0.98, y));
    return {
      x: x * window.innerWidth,
      y: y * window.innerHeight,
      coordinate_system_used: "normalized",
      coords_clamped: clamped,
      normalized_x: x,
      normalized_y: y,
    };
  }

  function elementNormalizedCenter(el, scrollFirst) {
    if (scrollFirst && el?.scrollIntoView) {
      try {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      } catch (_e) {}
    }
    const rect = el.getBoundingClientRect();
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const rawX = (rect.left + rect.width / 2) / w;
    const rawY = (rect.top + rect.height / 2) / h;
    const in_viewport =
      rect.bottom > 0 && rect.top < h && rect.right > 0 && rect.left < w;
    return {
      x: Math.round(Math.max(0.02, Math.min(0.98, rawX)) * 1000) / 1000,
      y: Math.round(Math.max(0.02, Math.min(0.98, rawY)) * 1000) / 1000,
      in_viewport,
    };
  }

  function clickElement(el) {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const coords = elementNormalizedCenter(el, false);
    const clickResult = clickAtPoint(
      coords.x * window.innerWidth,
      coords.y * window.innerHeight,
      el
    );
    return { ...clickResult, ...coords, selector: cssPath(el) };
  }

  function findQuizWrapper() {
    return document.querySelector(
      "section.ttw_quiz_wrapper, .ttw_quiz_wrapper, [class*='quiz_wrapper' i]"
    );
  }

  function findCurrentQuizQuestionRoot() {
    const wrapper = findQuizWrapper();
    const scope = wrapper || document;
    const unanswered = scope.querySelector(
      ".ttw_quiz_question_unanswered, fieldset.ttw_quiz_question_unanswered"
    );
    if (unanswered) return unanswered;

    const questions = scope.querySelectorAll("fieldset.ttw_quiz_question, .ttw_quiz_question");
    for (const q of questions) {
      if (q.classList.contains("ttw_quiz_question_unanswered")) return q;
      if (q.querySelector("input:checked, [aria-checked='true'], .ttw_quiz_answer_selected")) continue;
      return q;
    }
    return questions[0] || scope;
  }

  function measureCoords(el) {
    const rect = el.getBoundingClientRect();
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const rawX = (rect.left + rect.width / 2) / w;
    const rawY = (rect.top + rect.height / 2) / h;
    const in_viewport =
      rect.bottom > 4 && rect.top < h - 4 && rect.right > 4 && rect.left < w - 4;
    return {
      x: Math.round(Math.max(0, Math.min(1, rawX)) * 1000) / 1000,
      y: Math.round(Math.max(0, Math.min(1, rawY)) * 1000) / 1000,
      in_viewport,
    };
  }

  function prepareQuizViewport() {
    const root = findCurrentQuizQuestionRoot();
    const wrapper = findQuizWrapper();
    if (wrapper?.scrollIntoView) {
      try {
        wrapper.scrollIntoView({ block: "nearest", behavior: "instant" });
      } catch (_e) {}
    }
    if (root?.scrollIntoView) {
      try {
        root.scrollIntoView({ block: "start", behavior: "instant" });
      } catch (_e) {}
    }
    if (wrapper && isScrollableElement(wrapper)) {
      const rootRect = root.getBoundingClientRect();
      const wrapRect = wrapper.getBoundingClientRect();
      if (rootRect.top < wrapRect.top + 8) {
        wrapper.scrollTop += rootRect.top - wrapRect.top - 24;
      }
    }
  }

  function findQuizNextButton() {
    const wrapper = findQuizWrapper() || document;
    const candidates = [];
    for (const el of wrapper.querySelectorAll(
      'button, a[href], input[type="submit"], input[type="button"], [role="button"]'
    )) {
      if (!visible(el)) continue;
      if (el.closest(".ttw_quiz_answer, .ttw_quiz_answers")) continue;
      const text = labelFor(el).trim();
      if (!isQuizControlText(text)) continue;
      candidates.push({ el, text, score: /^next$/i.test(text) ? 0 : 1 });
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0]?.el || null;
  }

  function collectOptionsInRoot(root, kind) {
    const options = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || !visible(el)) return;
      const key = cssPath(el);
      if (seen.has(key)) return;
      seen.add(key);
      const text = labelFor(el);
      if (!text) return;
      const letter = (text.match(/^([A-F])[\).:\s—–-]/i) || [])[1] || null;
      options.push({
        kind,
        letter,
        text: text.slice(0, 140),
        ...measureCoords(el),
        selector: key,
      });
    };

    for (const el of root.querySelectorAll(
      ".ttw_quiz_answer label, label.ttw_quiz_answer_text, .ttw_quiz_answer_text, .ttw_quiz_answer"
    )) {
      add(el);
    }
    for (const el of root.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
      const label = el.labels?.[0] || el.closest("label");
      add(label || el);
    }
    for (const el of root.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]')) {
      add(el);
    }
    if (!options.length) {
      for (const el of root.querySelectorAll("label, li, button")) {
        const text = labelFor(el);
        if (isQuizChoiceText(text)) add(el);
      }
    }
    return options;
  }

  function findQuizAnswerElement(params) {
    const letter = String(params.answer || params.text || "")
      .trim()
      .toUpperCase()
      .match(/^([A-F])/)?.[1];
    const index = Number(params.index) || Number(params.option_index) || 0;
    prepareQuizViewport();
    const snap = findQuizOptions();
    const options = snap.options || [];
    const root = findCurrentQuizQuestionRoot();

    if (letter) {
      const match =
        options.find((o) => o.letter === letter) ||
        options.find((o) => new RegExp(`^${letter}[\\).:\\s—–-]`, "i").test(o.text || ""));
      if (match?.selector) {
        const el = document.querySelector(match.selector);
        if (el) return { el, match, snap };
      }
      for (const el of root.querySelectorAll(
        ".ttw_quiz_answer label, .ttw_quiz_answer_text, label.ttw_quiz_answer_text, .ttw_quiz_answer"
      )) {
        const t = labelFor(el);
        if (new RegExp(`^${letter}[\\).:\\s—–-]`, "i").test(t)) {
          return { el, match: { letter, text: t }, snap };
        }
      }
    }

    if (index > 0) {
      const match = options[index - 1];
      if (match?.selector) {
        const el = document.querySelector(match.selector);
        if (el) return { el, match, snap };
      }
      const scoped = root.querySelectorAll(
        ".ttw_quiz_answer label, .ttw_quiz_answer_text, label.ttw_quiz_answer_text"
      );
      if (scoped[index - 1]) {
        return {
          el: scoped[index - 1],
          match: { text: labelFor(scoped[index - 1]) },
          snap,
        };
      }
    }

    throw new Error(
      "click_quiz_answer requires answer='A'-'F' for the CURRENT question only. Call get_quiz_options first."
    );
  }

  function isQuizChoiceText(text) {
    return /^[A-F][\).:\s—–-]/i.test(text || "") || /^option\s*[A-F]/i.test(text || "");
  }

  function isQuizControlText(text) {
    return /^(next|submit|continue|check|finish|see results|done|start)/i.test((text || "").trim());
  }

  function findQuizOptions() {
    prepareQuizViewport();
    const root = findCurrentQuizQuestionRoot();
    const options = collectOptionsInRoot(root, findQuizWrapper() ? "wwf" : "quiz");
    options.sort((a, b) => a.y - b.y || a.x - b.x);

    const controls = [];
    const nextBtn = findQuizNextButton();
    if (nextBtn) {
      controls.push({
        text: labelFor(nextBtn).slice(0, 80),
        role: "next",
        ...measureCoords(nextBtn),
        selector: cssPath(nextBtn),
      });
    }
    const wrapper = findQuizWrapper() || document;
    for (const el of wrapper.querySelectorAll(
      'button, a[href], input[type="submit"], [role="button"]'
    )) {
      if (!visible(el) || el.closest(".ttw_quiz_answer, .ttw_quiz_answers")) continue;
      const text = labelFor(el).trim();
      if (!isQuizControlText(text)) continue;
      if (nextBtn && el === nextBtn) continue;
      controls.push({
        text: text.slice(0, 80),
        ...measureCoords(el),
        selector: cssPath(el),
      });
    }

    let question_text = "";
    const qEl =
      root.querySelector("legend, h2, h3, .ttw_quiz_question_text, [class*='question' i]") ||
      root.querySelector("h1, h2, h3");
    if (qEl) question_text = cleanText(qEl.innerText || "").slice(0, 400);

    const allQuestions = (findQuizWrapper() || document).querySelectorAll(
      "fieldset.ttw_quiz_question, .ttw_quiz_question"
    );
    let question_index = 1;
    for (let i = 0; i < allQuestions.length; i++) {
      if (allQuestions[i] === root || allQuestions[i].contains(root)) {
        question_index = i + 1;
        break;
      }
    }

    return {
      url: location.href,
      title: document.title,
      question_text,
      question_index,
      current_question_selector: cssPath(root),
      options,
      controls: controls.slice(0, 6),
      page_type: "quiz_page",
      coordinate_hint:
        "Each option has distinct x,y measured without scrolling. Use click_quiz_answer answer='A'-'F' for current question only, then click_quiz_next.",
    };
  }

  function clickAtPoint(x, y, preferredEl) {
    const px = Math.max(0, Math.min(window.innerWidth - 1, x));
    const py = Math.max(0, Math.min(window.innerHeight - 1, y));
    const hit = document.elementFromPoint(px, py);
    const el = preferredEl || hit;
    if (!el) throw new Error(`No element at viewport position (${px}, ${py})`);

    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: px,
      clientY: py,
      view: window,
    };
    (hit || el).dispatchEvent(new MouseEvent("mousedown", opts));
    (hit || el).dispatchEvent(new MouseEvent("mouseup", opts));
    (hit || el).dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") el.click();

    const linkEl = el.closest ? el.closest("a[href]") : null;
    const text = labelFor(el);
    return {
      x: px,
      y: py,
      element: cssPath(el),
      text,
      href: el.href || linkEl?.href || null,
      navigates: !!(el.href || linkEl?.href),
      is_quiz_option: isQuizChoiceText(text),
      is_quiz_control: isQuizControlText(text),
    };
  }

  function dismissPopups() {
    const clicked = [];
    const candidates = interactiveNodes().filter((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag !== "button" && tag !== "a" && el.getAttribute("role") !== "button") return false;
      const label = labelFor(el);
      return DISMISS_RE.test(label) || /accept|agree|close|dismiss|got it/i.test(label);
    });

    for (const el of candidates.slice(0, 3)) {
      humanClick(el);
      clicked.push(labelFor(el));
    }

    return { dismissed: clicked.length, labels: clicked };
  }

  async function executeAction(action, params) {
    switch (action) {
      case "get_page_text":
      case "get_page_summary": {
        await preparePageForSnapshot();
        const snap = pageSnapshot();
        return {
          url: snap.url,
          title: snap.title,
          text: snap.text,
          headings: snap.headings,
          links: snap.links,
          todo_lines: snap.todo_lines,
          products: snap.products,
          product_lines: snap.product_lines,
          result_count: snap.result_count,
          page_type: snap.page_type,
        };
      }

      case "get_page_html":
        return {
          url: location.href,
          title: document.title,
          html: document.documentElement.outerHTML.slice(0, MAX_HTML),
        };

      case "get_interactive_elements": {
        const elements = interactiveElements();
        const searchBoxes = elements.filter((e) => e.is_search);
        return {
          url: location.href,
          title: document.title,
          elements,
          search_box_indexes: searchBoxes.map((e) => e.index),
        };
      }

      case "get_quiz_options":
        return findQuizOptions();

      case "dismiss_popups":
        return { url: location.href, ...dismissPopups() };

      case "click_product": {
        const idx = Number(params.product_index ?? params.index) - 1;
        if (idx < 0) {
          throw new Error("product_index is required (1-based number from products list)");
        }
        const products = extractAmazonProducts();
        const product = products[idx];
        if (!product) {
          throw new Error(
            `No product at index ${idx + 1}. Page has ${products.length} product(s).`
          );
        }
        if (!product.href) {
          throw new Error(`Product #${idx + 1} has no link on this page`);
        }
        window.location.assign(product.href);
        return {
          clicked_product: true,
          product_index: idx + 1,
          title: product.title,
          price: product.price,
          href: product.href,
          navigates: true,
        };
      }

      case "get_viewport":
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          devicePixelRatio: window.devicePixelRatio || 1,
          ...getScrollState(),
        };

      case "prepare_screenshot": {
        window.scrollTo({ top: 0, behavior: "instant" });
        await new Promise((r) => setTimeout(r, 200));
        return {
          prepared: true,
          scrollY: window.scrollY,
          width: window.innerWidth,
          height: window.innerHeight,
        };
      }

      case "click_quiz_answer": {
        const { el, match } = findQuizAnswerElement(params);
        const clickResult = clickElement(el);
        return {
          clicked: true,
          click_quiz_answer: true,
          answer: match?.letter || params.answer || params.text,
          ...clickResult,
          is_quiz_option: true,
        };
      }

      case "click_quiz_next": {
        prepareQuizViewport();
        const el = findQuizNextButton();
        if (!el) throw new Error("No Next/Submit button found on quiz page");
        const clickResult = clickElement(el);
        return {
          clicked: true,
          click_quiz_next: true,
          ...clickResult,
          is_quiz_control: true,
        };
      }

      case "solve_quiz_step": {
        const answer = String(params.answer || params.text || "").trim();
        if (!answer) {
          throw new Error("solve_quiz_step requires answer='A'-'F'");
        }
        const answerResult = await executeAction("click_quiz_answer", { ...params, answer });
        await new Promise((r) => setTimeout(r, 450));
        let nextResult = null;
        let nextError = null;
        try {
          nextResult = await executeAction("click_quiz_next", {});
        } catch (e) {
          nextError = String(e.message || e);
        }
        const nextText = nextResult?.text || "";
        return {
          solve_quiz_step: true,
          answer: answerResult?.answer || answer,
          answer_clicked: !!answerResult?.clicked,
          next_clicked: !!nextResult?.clicked,
          next_error: nextError,
          quiz_submitted: !!(
            nextResult?.is_quiz_control &&
            /submit|finish|results|done|see/i.test(nextText)
          ),
          is_quiz_option: true,
          is_quiz_control: !!nextResult?.is_quiz_control,
          text: nextText || answerResult?.text,
          ...answerResult,
          next: nextResult || { clicked: false, error: nextError },
        };
      }

      case "click_at": {
        if (params.selector) {
          const el = document.querySelector(params.selector);
          if (!el) throw new Error(`Selector not found: ${params.selector}`);
          const clickResult = clickElement(el);
          return {
            clicked: true,
            click_at: true,
            via_selector: true,
            coordinate_system: "selector",
            selector: params.selector,
            ...clickResult,
            is_quiz_option: clickResult.is_quiz_option,
            is_quiz_control: clickResult.is_quiz_control,
          };
        }
        const coords = resolveClickCoords(params);
        const clickResult = clickAtPoint(coords.x, coords.y);
        return {
          clicked: true,
          click_at: true,
          coordinate_system: coords.coordinate_system_used || params.coordinate_system || "normalized",
          x: coords.normalized_x ?? params.x,
          y: coords.normalized_y ?? params.y,
          coords_clamped: coords.coords_clamped || false,
          viewport_x: clickResult.x,
          viewport_y: clickResult.y,
          selector: clickResult.element,
          text: clickResult.text,
          navigates: clickResult.navigates,
          href: clickResult.href,
          is_quiz_option: clickResult.is_quiz_option,
          is_quiz_control: clickResult.is_quiz_control,
        };
      }

      case "click": {
        const el = resolveTarget(params);
        const linkEl = el.closest ? el.closest("a[href]") : null;
        const href = el.href || linkEl?.href || "";
        humanClick(el);
        return {
          clicked: true,
          selector: cssPath(el),
          text: labelFor(el),
          navigates: !!href,
          href: href || null,
        };
      }

      case "type": {
        const { el, auto_target } = resolveTypeTarget(params);
        dispatchInput(el, params.text || "", !!params.clear);
        const submitMethod = maybeAutoSubmitSearch(el, params);
        return {
          typed: true,
          auto_submitted: !!submitMethod,
          submit_method: submitMethod,
          auto_target,
          selector: cssPath(el),
          text: params.text || "",
          field_label: labelFor(el),
        };
      }

      case "type_and_submit": {
        const { el, auto_target } = resolveTypeTarget(params);
        dispatchInput(el, params.text || "", !!params.clear);
        const submitMethod = maybeAutoSubmitSearch(el, { ...params, prefer_search: true }) || "enter_key";
        return {
          typed: true,
          submitted: true,
          submit_method: submitMethod,
          auto_target,
          selector: cssPath(el),
          text: params.text || "",
          field_label: labelFor(el),
        };
      }

      case "select": {
        const el = resolveTarget(params);
        if (el.tagName.toLowerCase() !== "select") {
          throw new Error("select action requires a <select> element");
        }
        el.value = params.value || "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { selected: true, value: el.value, text: labelFor(el) };
      }

      case "scroll":
        return smartScroll(params);

      case "press_key": {
        const key = params.key || "Enter";
        const target = params.selector
          ? resolveTarget(params)
          : document.activeElement || document.body;
        pressKey(target, key);
        return { pressed: key };
      }

      case "go_back":
        window.history.back();
        return { navigated: "back", url: location.href };

      case "go_forward":
        window.history.forward();
        return { navigated: "forward", url: location.href };

      case "wait":
        await new Promise((r) => setTimeout(r, Math.min(Number(params.ms) || 1000, 10000)));
        return { waited_ms: Number(params.ms) || 1000 };

      default:
        throw new Error(`Unknown agent action: ${action}`);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "AGENT_PING") {
      sendResponse({ ok: true, url: location.href, title: document.title });
      return;
    }
    if (msg.type !== "AGENT_ACTION") return;
    executeAction(msg.action, msg.params || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  });
})();