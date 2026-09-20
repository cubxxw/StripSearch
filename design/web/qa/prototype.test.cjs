"use strict";

/*
 * Offline DOM checks for design/web/index.html.
 *
 * These tests run the prototype's inline script inside jsdom with stubbed
 * matchMedia / scrollIntoView / Blob URL helpers. They assert prototype
 * behaviour (validation, revocation, export gating, drawers, focus). They do
 * not measure real rendering, layout or browser behaviour.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const HTML_PATH = path.join(__dirname, "..", "index.html");
const HTML = fs.readFileSync(HTML_PATH, "utf8");

function boot(options) {
  const opts = options || {};
  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: opts.url || "https://stripsearch.test/design/web/index.html",
    beforeParse(window) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value(query) {
          return {
            matches: Boolean(opts.reducedMotion) && String(query).indexOf("prefers-reduced-motion") >= 0,
            media: String(query),
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
          };
        },
      });
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: opts.width || 1024,
      });
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.scrollTo = function () {};
      window.URL.createObjectURL = function () { return "blob:stripsearch-mock"; };
      window.URL.revokeObjectURL = function () {};
      window.HTMLAnchorElement.prototype.click = function () {};
    },
  });
  const win = dom.window;
  const doc = win.document;
  return {
    dom,
    win,
    doc,
    demo: win.StripSearchDemo,
    $: (selector) => doc.querySelector(selector),
    $$: (selector) => Array.from(doc.querySelectorAll(selector)),
    id: (id) => doc.getElementById(id),
    click(selector) {
      const el = typeof selector === "string" ? doc.querySelector(selector) : selector;
      assert.ok(el, "missing element to click: " + selector);
      el.click();
    },
    submit(formId) {
      const form = doc.getElementById(formId);
      form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    },
    keydown(key, shiftKey) {
      doc.dispatchEvent(new win.KeyboardEvent("keydown", { key, shiftKey: Boolean(shiftKey), bubbles: true, cancelable: true }));
    },
  };
}

function fillValidForm(ctx, question) {
  ctx.id("research-question").value = question || "林舟在 Lantern 中如何做设计取舍？";
  ctx.id("profile-url").value = "";
}

function enterDemo(ctx) {
  ctx.click("#open-example");
  assert.equal(ctx.demo.view(), "app");
}

function withdrawS2(ctx) {
  const button = ctx.$("[data-toggle-withdraw]");
  assert.ok(button, "S2 withdrawal control should be rendered");
  button.click();
}

// ---------------------------------------------------------------------------

test("no external scripts, stylesheets or font imports are required", () => {
  assert.ok(!/<script[^>]+src=/i.test(HTML), "prototype must not load remote scripts");
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(HTML), "prototype must not load remote stylesheets");
  assert.ok(!/@import/i.test(HTML), "prototype must not import remote CSS");
  assert.ok(!/\bfetch\s*\(/.test(HTML), "prototype must not call fetch");
  assert.ok(!/XMLHttpRequest/.test(HTML), "prototype must not use XMLHttpRequest");
});

test("initial state: home view, report absent, export disabled", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  assert.equal(ctx.demo.view(), "home");
  assert.equal(ctx.id("home-view").hidden, false);
  assert.equal(ctx.id("app-view").hidden, true);
  assert.equal(ctx.id("report").hidden, true);
  assert.equal(ctx.id("download-md").disabled, true);
  assert.equal(ctx.demo.isReportReady(), false);
});

test("follow-up composer cannot answer before a report and resets with a new research", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  assert.equal(ctx.id("chat-input").disabled, true);
  ctx.id("chat-input").value = "还有哪些关键未知？";
  ctx.submit("chat-form");
  assert.equal(ctx.id("chat-log").children.length, 0);
  enterDemo(ctx);
  assert.equal(ctx.id("chat-input").disabled, false);
  ctx.id("chat-input").value = "还有哪些关键未知？";
  ctx.submit("chat-form");
  assert.equal(ctx.id("chat-log").children.length, 2);
  ctx.click("#new-research");
  assert.equal(ctx.id("chat-input").disabled, true);
  assert.equal(ctx.id("chat-log").children.length, 0);
});

test("validation rejects a malformed https:// URL, exposes aria-invalid and focuses it", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  fillValidForm(ctx);
  ctx.id("profile-url").value = "https://";
  ctx.submit("research-form");
  assert.equal(ctx.id("profile-error").textContent.length > 0, true);
  assert.equal(ctx.id("profile-url").getAttribute("aria-invalid"), "true");
  assert.equal(ctx.id("question-error").textContent, "");
  assert.equal(ctx.doc.activeElement, ctx.id("profile-url"));
  assert.equal(ctx.id("more-settings").open, true);
  assert.equal(ctx.demo.view(), "home");
});

test("validation rejects non-http schemes and bare hostnames", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  fillValidForm(ctx);
  ctx.id("profile-url").value = "ftp://example.org/profile";
  ctx.submit("research-form");
  assert.equal(ctx.id("profile-url").getAttribute("aria-invalid"), "true");
  assert.match(ctx.id("profile-error").textContent, /http/i);

  ctx.id("profile-url").value = "example.org/profile";
  ctx.submit("research-form");
  assert.equal(ctx.id("profile-url").getAttribute("aria-invalid"), "true");

  ctx.id("profile-url").value = "https://example.org/about";
  ctx.submit("research-form");
  assert.equal(ctx.id("profile-url").getAttribute("aria-invalid"), null);
  assert.equal(ctx.id("profile-error").textContent, "");
});

test("validation requires a question and focuses the question field", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  ctx.id("research-question").value = "   ";
  ctx.submit("research-form");
  assert.equal(ctx.id("research-question").getAttribute("aria-invalid"), "true");
  assert.match(ctx.id("question-error").textContent, /研究问题/);
  assert.equal(ctx.doc.activeElement, ctx.id("research-question"));
  assert.equal(ctx.id("app-view").hidden, true);
});

test("a valid submission opens the app view with an unconfirmed identity and no report", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  fillValidForm(ctx, "林舟在 Lantern 中如何处理来源冲突？");
  ctx.submit("research-form");
  assert.equal(ctx.demo.view(), "app");
  assert.equal(ctx.id("app-view").hidden, false);
  assert.equal(ctx.id("home-view").hidden, true);
  assert.equal(ctx.id("identity-panel").hidden, false);
  assert.equal(ctx.id("activity-panel").hidden, true);
  assert.equal(ctx.id("report").hidden, true);
  assert.equal(ctx.id("download-md").disabled, true);
  assert.match(ctx.id("report-question").textContent, /来源冲突/);
  assert.equal(ctx.id("nav-links").hidden, true, "marketing navigation hidden in app view");
  assert.equal(ctx.id("site-footer").hidden, true, "marketing footer hidden in app view");
});

test("wrong identity candidate cannot start Lantern research", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  fillValidForm(ctx);
  ctx.submit("research-form");
  const materials = ctx.$('input[name="candidate"][value="materials"]');
  materials.checked = true;
  ctx.click("#confirm-identity");
  assert.equal(ctx.id("activity-panel").hidden, true);
  assert.equal(ctx.id("identity-panel").hidden, false);
  assert.match(ctx.id("identity-note").textContent, /没有公开关联/);
  assert.equal(ctx.demo.isReportReady(), false);
  assert.equal(ctx.id("download-md").disabled, true);
  assert.equal(ctx.demo.timerActive(), false);
});

test("pause and resume use a single run timer and complete the scripted run", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  ctx.demo.setRunDelay(100000);
  fillValidForm(ctx);
  ctx.submit("research-form");
  ctx.click("#confirm-identity");
  assert.equal(ctx.demo.isRunning(), true);
  assert.equal(ctx.demo.timerActive(), true);
  assert.equal(ctx.demo.runStep(), 1);

  ctx.click("#stop-run");
  assert.equal(ctx.demo.isPaused(), true);
  assert.equal(ctx.demo.timerActive(), false);
  assert.equal(ctx.id("stop-run").disabled, true);
  assert.equal(ctx.id("resume-run").hidden, false);

  ctx.click("#resume-run");
  assert.equal(ctx.demo.isPaused(), false);
  assert.equal(ctx.demo.timerActive(), true);
  assert.equal(ctx.id("resume-run").hidden, true);

  for (let i = 0; i < 6; i += 1) ctx.demo.advanceRun();
  assert.equal(ctx.demo.isReportReady(), true);
  assert.equal(ctx.demo.timerActive(), false);
  assert.equal(ctx.id("report").hidden, false);
  assert.equal(ctx.id("download-md").disabled, false);
  assert.equal(ctx.id("desk-state").textContent.startsWith("COMPLETE"), true);
  const statuses = ctx.$$(".activity-item").map((item) => item.dataset.status);
  assert.deepEqual(statuses, ["done", "done", "done", "error", "done"]);
});

test("new research clears messages, errors, report, selection and disables export", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  assert.equal(ctx.id("download-md").disabled, false);
  ctx.id("chat-input").value = "哪些结论只依赖本人自述？";
  ctx.submit("chat-form");
  assert.equal(ctx.id("chat-log").children.length, 2);
  withdrawS2(ctx);
  ctx.click("#new-research");
  assert.equal(ctx.demo.view(), "home");
  assert.equal(ctx.id("download-md").disabled, true);
  assert.equal(ctx.id("report").hidden, true);
  assert.equal(ctx.id("chat-log").children.length, 0);
  assert.equal(ctx.id("research-question").value, "");
  assert.equal(ctx.id("profile-error").textContent, "");
  assert.equal(ctx.id("question-error").textContent, "");
  assert.equal(ctx.id("retry-status").textContent, "");
  assert.equal(ctx.id("retry-source").disabled, false);
  assert.equal(ctx.demo.sourceStatus("S2"), "active");
  assert.equal(ctx.demo.isReportReady(), false);
  assert.equal(ctx.$$(".filter").filter((b) => b.getAttribute("aria-pressed") === "true").length, 2);
});

test("withdrawing S2 marks every dependent displayed statement and the export", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);

  const dependents = ["fact-s2", "inference", "mechanism-claim", "timeline-2024"];
  const independents = ["fact-s1", "timeline-2022", "timeline-2025", "counter"];
  dependents.forEach((id) => {
    const nodes = ctx.$$('[data-statement="' + id + '"]');
    assert.ok(nodes.length >= 1, "statement " + id + " should be rendered");
    nodes.forEach((node) => assert.equal(node.getAttribute("data-validity"), "supported"));
  });

  withdrawS2(ctx);
  assert.equal(ctx.demo.sourceStatus("S2"), "withdrawn");
  dependents.forEach((id) => {
    ctx.$$('[data-statement="' + id + '"]').forEach((node) => {
      assert.equal(node.getAttribute("data-validity"), "review", id + " should be pending review");
      const status = node.querySelector("[data-statement-status]");
      assert.match(status.textContent, /待复核/);
      assert.match(status.textContent, /S2/);
    });
  });
  independents.forEach((id) => {
    ctx.$$('[data-statement="' + id + '"]').forEach((node) => {
      assert.equal(node.getAttribute("data-validity"), "supported", id + " must not be marked pending");
    });
  });

  const markdown = ctx.demo.buildMarkdown();
  dependents.forEach((id) => {
    const text = ctx.$('[data-statement="' + id + '"] strong, [data-statement="' + id + '"] p').textContent;
    assert.ok(text.length > 0);
  });
  assert.match(markdown, /\[待复核 · S2 已撤下\]/);
  const lines = markdown.split("\n");
  const factS2Line = lines.find((line) => line.indexOf("Lantern 的公开界面区分事实") >= 0);
  const inferenceLine = lines.find((line) => line.indexOf("界面结构约束") >= 0);
  const mechanismLine = lines.find((line) => line.indexOf("落实为界面约束这一有限分析") >= 0);
  const timelineLine = lines.find((line) => line.indexOf("Evidence Threads") >= 0);
  assert.match(factS2Line, /\*\*\[待复核 · S2 已撤下\]\*\*/, "fact export line must carry the marker");
  assert.match(inferenceLine, /\*\*\[待复核 · S2 已撤下\]\*\*/);
  assert.match(mechanismLine, /\*\*\[待复核 · S2 已撤下\]\*\*/);
  assert.match(timelineLine, /\*\*\[待复核 · S2 已撤下\]\*\*/);
  const factS1Line = lines.find((line) => line.indexOf("判断应能回到材料") >= 0);
  assert.doesNotMatch(factS1Line, /待复核/);
  const counterLine = lines.find((line) => line.indexOf("不能外推到全部项目") >= 0);
  assert.doesNotMatch(counterLine, /待复核/);
  assert.match(markdown, /- S2 实际作品：待复核（已撤下）/);
});

test("restoring S2 restores every statement and clears the export marker", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  withdrawS2(ctx);
  assert.match(ctx.demo.buildMarkdown(), /\[待复核 · S2 已撤下\]/);
  withdrawS2(ctx);
  assert.equal(ctx.demo.sourceStatus("S2"), "active");
  ctx.$$("[data-statement]").forEach((node) => {
    assert.equal(node.getAttribute("data-validity"), "supported");
  });
  assert.doesNotMatch(ctx.demo.buildMarkdown(), /待复核/);
  assert.equal(ctx.id("desk-state").textContent, "COMPLETE / 报告可检查");
});

test("scripted responses given before withdrawal are marked pending review too", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  ctx.click('[data-prompt="self"]');
  ctx.click('[data-prompt="withdraw"]');
  const assistants = ctx.$$("#chat-log .message.assistant");
  assert.equal(assistants.length, 2);
  assistants.forEach((message) => assert.equal(message.querySelector(".message-review"), null));
  withdrawS2(ctx);
  assert.equal(assistants[0].querySelector(".message-review"), null, "S1-only answer should not be marked");
  assert.ok(assistants[1].querySelector(".message-review"), "previous scripted S2 answer must be marked pending review");
  assert.match(assistants[1].querySelector(".message-review").textContent, /待复核/);
});

test("arbitrary follow-ups state the scripted prototype boundary honestly", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  ctx.id("chat-input").value = "他信任哪些人？";
  ctx.submit("chat-form");
  const messages = ctx.$$("#chat-log .message");
  assert.equal(messages.length, 2);
  assert.match(messages[1].textContent, /不会假装理解任意问题/);
  assert.doesNotMatch(messages[1].textContent, /脚本答案/);

  ctx.id("chat-input").value = "还有哪些关键未知？";
  ctx.submit("chat-form");
  const after = ctx.$$("#chat-log .message");
  assert.match(after[after.length - 1].textContent, /关键未知/);
  assert.match(after[after.length - 1].querySelector("small").textContent, /脚本答案/);
});

test("source filters work, empty state appears, and retry keeps S4 excluded", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  const visibleIds = () => ctx.$$("#inspector-source-list .source-row").filter((r) => !r.hidden).map((r) => r.dataset.source);

  ctx.click('.filter[data-filter="self"]');
  assert.deepEqual(visibleIds(), ["S1"]);
  ctx.click('.filter[data-filter="work"]');
  assert.deepEqual(visibleIds(), ["S2"]);
  ctx.click('.filter[data-filter="unavailable"]');
  assert.deepEqual(visibleIds(), ["S4"]);

  ctx.click("#retry-source");
  assert.match(ctx.id("retry-status").textContent, /S4 仍无法访问/);
  assert.equal(ctx.id("retry-source").disabled, true);
  assert.equal(ctx.demo.sourceStatus("S4"), "unavailable");
  assert.deepEqual(visibleIds(), ["S4"], "S4 stays excluded from other filters");
  assert.match(ctx.demo.buildMarkdown(), /- S4 无法访问：无法访问，未纳入支持/);

  withdrawS2(ctx);
  ctx.click('.filter[data-filter="work"]');
  assert.deepEqual(visibleIds(), [], "no work sources remain after S2 withdrawal");
  assert.equal(ctx.$("#inspector-source-list [data-empty-state]").hidden, false);
  ctx.click('.filter[data-filter="all"]');
  assert.equal(ctx.$("#inspector-source-list [data-empty-state]").hidden, true);
});

test("home citations open a visible source drawer, trap focus and close with Escape", (t) => {
  const ctx = boot({ width: 1440 });
  t.after(() => ctx.dom.window.close());
  const trigger = ctx.$('.track-node[data-source="S1"]');
  trigger.click();
  const drawer = ctx.id("source-drawer");
  assert.equal(drawer.hidden, false);
  assert.equal(drawer.getAttribute("aria-hidden"), "false");
  assert.equal(ctx.id("drawer-backdrop").hidden, false);
  assert.equal(ctx.id("page").hasAttribute("inert"), true, "background is inert while a drawer is open");
  assert.ok(drawer.contains(ctx.doc.activeElement), "focus moves into the drawer");

  const focusables = Array.from(drawer.querySelectorAll("a[href], button, input, textarea, select, [tabindex]"))
    .filter((el) => !el.disabled && !el.closest("[hidden]"));
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  last.focus();
  ctx.keydown("Tab", false);
  assert.equal(ctx.doc.activeElement, first, "Tab wraps from last to first inside the dialog");
  ctx.keydown("Tab", true);
  assert.equal(ctx.doc.activeElement, last, "Shift+Tab wraps from first to last inside the dialog");

  ctx.keydown("Escape", false);
  assert.equal(drawer.hidden, true);
  assert.equal(drawer.getAttribute("aria-hidden"), "true");
  assert.equal(ctx.id("drawer-backdrop").hidden, true);
  assert.equal(ctx.id("page").hasAttribute("inert"), false);
  assert.equal(ctx.doc.activeElement, trigger, "focus returns to the opener");
});

test("closed drawers are hidden, inert and out of the tab order", (t) => {
  const ctx = boot({ width: 1440 });
  t.after(() => ctx.dom.window.close());
  ["source-drawer", "history-drawer", "menu-drawer"].forEach((id) => {
    const drawer = ctx.id(id);
    assert.equal(drawer.hidden, true);
    assert.equal(drawer.getAttribute("aria-hidden"), "true");
    const control = drawer.querySelector("button");
    assert.ok(control, id + " should contain controls");
    assert.equal(control.closest("[hidden]"), drawer, id + " controls live in a hidden (display:none) subtree");
  });
  assert.equal(ctx.id("page").hasAttribute("inert"), false);
});

test("nav and example shortcuts open the full demo", (t) => {
  const ctx = boot({ width: 1440 });
  t.after(() => ctx.dom.window.close());
  ctx.click("#nav-demo");
  assert.equal(ctx.demo.view(), "app");
  assert.equal(ctx.id("app-view").hidden, false);
  assert.equal(ctx.id("report").hidden, false);
  assert.equal(ctx.id("download-md").disabled, false);
  assert.equal(ctx.demo.isReportReady(), true);
  assert.match(ctx.id("report-question").textContent, /可解释性/);
  assert.equal(ctx.win.location.hash, "#/app", "app view is addressable by hash route");
  ctx.click("#app-return-home");
  assert.equal(ctx.demo.view(), "home");
  assert.equal(ctx.id("home-view").hidden, false);
  assert.equal(ctx.id("app-view").hidden, true);
  assert.equal(ctx.win.location.hash, "#/", "return home restores the home route");
});

test("narrow-screen app sources open a drawer and widening does not strand the inspector", (t) => {
  const ctx = boot({ width: 375 });
  t.after(() => ctx.dom.window.close());
  ctx.click("#open-example");
  ctx.click("#open-mobile-sources");
  assert.equal(ctx.id("source-drawer").hidden, false);
  assert.ok(ctx.id("source-drawer").contains(ctx.doc.activeElement));
  ctx.keydown("Escape", false);
  assert.equal(ctx.id("source-drawer").hidden, true);
  assert.equal(ctx.doc.activeElement, ctx.id("open-mobile-sources"));

  // Narrow app citation opens the drawer rather than an offscreen inspector.
  ctx.click('#report .citation[data-source="S3"]');
  assert.equal(ctx.id("source-drawer").hidden, false);
  assert.match(ctx.id("drawer-source-detail").textContent, /North Window/);
  ctx.keydown("Escape", false);

  // Widen the viewport: the desktop inspector is usable, no drawer stranded.
  ctx.win.innerWidth = 1440;
  ctx.win.dispatchEvent(new ctx.win.Event("resize"));
  assert.equal(ctx.id("source-drawer").hidden, true);
  assert.equal(ctx.id("app-shell").classList.contains("inspector-collapsed"), false);
  ctx.click('#report .citation[data-source="S3"]');
  assert.equal(ctx.id("source-drawer").hidden, true, "desktop app citations use the inspector, not a drawer");
  assert.match(ctx.id("inspector-detail").textContent, /North Window/);
});

test("reduced-motion mode still completes the scripted run", (t) => {
  const ctx = boot({ reducedMotion: true });
  t.after(() => ctx.dom.window.close());
  ctx.demo.setRunDelay(5);
  fillValidForm(ctx);
  ctx.submit("research-form");
  ctx.click("#confirm-identity");
  const finish = Date.now() + 4000;
  while (!ctx.demo.isReportReady() && Date.now() < finish) {
    ctx.demo.advanceRun();
  }
  assert.equal(ctx.demo.isReportReady(), true);
  assert.equal(ctx.demo.timerActive(), false);
  assert.equal(ctx.id("report").hidden, false);
});

test("markdown export carries the question and the synthetic badge", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  ctx.demo.setRunDelay(100000);
  fillValidForm(ctx, "林舟在 Lantern 中如何保留反证？");
  ctx.submit("research-form");
  ctx.click("#confirm-identity");
  for (let i = 0; i < 6; i += 1) ctx.demo.advanceRun();
  const markdown = ctx.demo.buildMarkdown();
  assert.match(markdown, /合成样例/);
  assert.match(markdown, /林舟在 Lantern 中如何保留反证？/);
  assert.match(markdown, /## 来源状态/);
});
