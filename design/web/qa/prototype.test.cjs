"use strict";

/*
 * Offline DOM checks for design/web/index.html.
 *
 * These tests run the prototype's inline script inside jsdom with stubbed
 * matchMedia / scrollIntoView / clipboard / Blob URL helpers. They assert
 * prototype behaviour (validation, revocation, export gating, clipboard
 * fallback, progress, drawers, focus). They do not measure real rendering,
 * layout or browser behaviour, and they make no network requests.
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
  const clipboardTexts = [];
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
      if (opts.clipboard !== false) {
        Object.defineProperty(window.navigator, "clipboard", {
          configurable: true,
          value: {
            writeText(text) {
              clipboardTexts.push(String(text));
              if (typeof opts.clipboard === "function") return opts.clipboard(text);
              if (opts.clipboard === "throw") throw new Error("clipboard blocked");
              if (opts.clipboard === "reject") return Promise.reject(new Error("clipboard blocked"));
              if (opts.clipboard === "sync") return undefined;
              return Promise.resolve();
            },
          },
        });
      }
    },
  });
  const win = dom.window;
  const doc = win.document;
  return {
    dom,
    win,
    doc,
    demo: win.StripSearchDemo,
    clipboardTexts,
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
  assert.ok(button, "S2 exclusion control should be rendered");
  button.click();
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------

test("no external scripts, stylesheets or font imports are required", () => {
  assert.ok(!/<script[^>]+src=/i.test(HTML), "prototype must not load remote scripts");
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(HTML), "prototype must not load remote stylesheets");
  assert.ok(!/@import/i.test(HTML), "prototype must not import remote CSS");
  assert.ok(!/\bfetch\s*\(/.test(HTML), "prototype must not call fetch");
  assert.ok(!/XMLHttpRequest/.test(HTML), "prototype must not use XMLHttpRequest");
});

test("initial state: home view, report absent, export actions disabled", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  assert.equal(ctx.demo.view(), "home");
  assert.equal(ctx.id("home-view").hidden, false);
  assert.equal(ctx.id("app-view").hidden, true);
  assert.equal(ctx.id("report").hidden, true);
  assert.equal(ctx.id("download-md").disabled, true);
  assert.equal(ctx.id("copy-report").disabled, true);
  assert.equal(ctx.id("followup-rail").hidden, true);
  assert.equal(ctx.demo.isReportReady(), false);
});

test("follow-up composer cannot answer before a report and resets with a new research", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  assert.equal(ctx.id("chat-input").disabled, true);
  ctx.id("chat-input").value = "还缺哪些证据？";
  ctx.submit("chat-form");
  assert.equal(ctx.id("chat-log").children.length, 0);
  enterDemo(ctx);
  assert.equal(ctx.id("chat-input").disabled, false);
  ctx.id("chat-input").value = "还缺哪些证据？";
  ctx.submit("chat-form");
  assert.equal(ctx.id("chat-log").children.length, 2);
  ctx.click("#new-research");
  assert.equal(ctx.id("chat-input").disabled, true);
  assert.equal(ctx.id("chat-log").children.length, 0);
});

test("the clear control appears only with content and returns focus", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  const clear = ctx.id("clear-question");
  const input = ctx.id("research-question");
  assert.equal(clear.hidden, true);
  input.value = "林舟做过什么？";
  input.dispatchEvent(new ctx.win.Event("input", { bubbles: true }));
  assert.equal(clear.hidden, false);
  clear.click();
  assert.equal(input.value, "");
  assert.equal(clear.hidden, true);
  assert.equal(ctx.doc.activeElement, input);
});

test("Cmd/Ctrl+Enter submits once, ignoring IME composition and key repeat", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  ctx.demo.setRunDelay(100000);
  const input = ctx.id("research-question");
  input.value = "林舟如何设计 Lantern？";
  const fire = (init) => {
    const event = new ctx.win.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ctrlKey: Boolean(init.ctrlKey),
      metaKey: Boolean(init.metaKey),
      repeat: Boolean(init.repeat),
    });
    if (init.isComposing) Object.defineProperty(event, "isComposing", { value: true });
    input.dispatchEvent(event);
  };

  fire({ ctrlKey: true, isComposing: true });
  assert.equal(ctx.demo.view(), "home", "IME composition must not submit");
  fire({ metaKey: true, repeat: true });
  assert.equal(ctx.demo.view(), "home", "key repeat must not submit");

  fire({ ctrlKey: true });
  assert.equal(ctx.demo.view(), "app");
  assert.equal(ctx.id("identity-panel").hidden, false);
  ctx.click("#confirm-identity");
  assert.equal(ctx.demo.isRunning(), true);
  assert.equal(ctx.demo.runStep(), 1);

  fire({ ctrlKey: true });
  assert.equal(ctx.demo.runStep(), 1, "a second shortcut must not restart the run");
  assert.equal(ctx.demo.timerActive(), true);
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
  assert.match(ctx.id("question-error").textContent, /想查什么/);
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
  assert.equal(ctx.id("desk-state").textContent, "等待确认");
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

  for (let i = 0; i < 8; i += 1) ctx.demo.advanceRun();
  assert.equal(ctx.demo.isReportReady(), true);
  assert.equal(ctx.demo.timerActive(), false);
  assert.equal(ctx.id("report").hidden, false);
  assert.equal(ctx.id("download-md").disabled, false);
  assert.equal(ctx.id("desk-state").textContent, "已完成");
  const statuses = ctx.$$(".activity-item").map((item) => item.dataset.status);
  assert.deepEqual(statuses, ["done", "done", "done", "error", "done"]);
});

test("progress follows completed steps, holds while paused and finishes once", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  ctx.demo.setRunDelay(100000);
  fillValidForm(ctx);
  ctx.submit("research-form");
  const bar = ctx.id("run-progress");
  assert.equal(bar.getAttribute("role"), "progressbar");
  assert.equal(bar.getAttribute("aria-valuemax"), "5");
  assert.equal(bar.getAttribute("aria-valuenow"), "0");
  assert.equal(bar.getAttribute("aria-valuetext"), "0 / 5 步已完成");
  assert.equal(ctx.id("run-indicator").hidden, true);

  ctx.click("#confirm-identity");
  assert.equal(bar.getAttribute("aria-valuenow"), "0", "an active step is not completed yet");
  assert.equal(ctx.id("run-indicator").hidden, false);

  ctx.demo.advanceRun();
  assert.equal(bar.getAttribute("aria-valuenow"), "1");

  ctx.click("#stop-run");
  ctx.demo.advanceRun();
  assert.equal(bar.getAttribute("aria-valuenow"), "1", "progress holds while paused even if a queued callback runs");
  assert.equal(ctx.id("run-indicator").hidden, true, "indicator stops while paused");

  ctx.click("#resume-run");
  for (let i = 0; i < 8; i += 1) ctx.demo.advanceRun();
  assert.equal(ctx.demo.isReportReady(), true);
  assert.equal(bar.getAttribute("aria-valuenow"), "5");
  assert.equal(bar.getAttribute("aria-valuetext"), "5 / 5 步已完成");
  assert.equal(ctx.demo.finishCount(), 1, "finishRun runs exactly once");
  ctx.demo.advanceRun();
  assert.equal(ctx.demo.finishCount(), 1, "later advance calls are no-ops");
  assert.equal(ctx.id("run-indicator").hidden, true);
});

test("new research clears messages, errors, report, selection and disables export", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  assert.equal(ctx.id("download-md").disabled, false);
  ctx.id("chat-input").value = "哪些只是本人说的？";
  ctx.submit("chat-form");
  assert.equal(ctx.id("chat-log").children.length, 2);
  withdrawS2(ctx);
  ctx.click("#new-research");
  assert.equal(ctx.demo.view(), "home");
  assert.equal(ctx.id("download-md").disabled, true);
  assert.equal(ctx.id("copy-report").disabled, true);
  assert.equal(ctx.id("report").hidden, true);
  assert.equal(ctx.id("chat-log").children.length, 0);
  assert.equal(ctx.id("research-question").value, "");
  assert.equal(ctx.id("clear-question").hidden, true);
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
  const independents = ["fact-s1", "timeline-self", "timeline-2025", "counter"];
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
  const inferenceLine = lines.find((line) => line.indexOf("似乎更重视读者能否核对结论") >= 0);
  const mechanismLine = lines.find((line) => line.indexOf("把「方便核对」做进了界面") >= 0);
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
  assert.equal(ctx.id("desk-state").textContent, "已完成");
});

test("excluding S2 offers an in-context undo, and reset clears stale undo state", (t) => {
  const ctx = boot({ width: 1440 });
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  withdrawS2(ctx);
  assert.equal(ctx.demo.sourceStatus("S2"), "withdrawn");
  assert.equal(ctx.id("desk-state").textContent, "4 处待复核");
  assert.equal(ctx.demo.pendingCount(), 4);
  const undos = ctx.$$("[data-undo-exclusion]");
  assert.ok(undos.length >= 1, "an in-context undo should be rendered");
  undos[0].click();
  assert.equal(ctx.demo.sourceStatus("S2"), "active");
  assert.equal(ctx.id("desk-state").textContent, "已完成");
  assert.equal(ctx.$$("[data-undo-exclusion]").length, 0);

  withdrawS2(ctx);
  ctx.click("#new-research");
  assert.equal(ctx.demo.sourceStatus("S2"), "active");
  assert.equal(ctx.$$("[data-undo-exclusion]").length, 0, "no stale undo survives reset");
  enterDemo(ctx);
  assert.equal(ctx.id("desk-state").textContent, "已完成");
  assert.doesNotMatch(ctx.demo.buildMarkdown(), /待复核/);
});

test("undo works inside the mobile source drawer while the background stays inert", (t) => {
  const ctx = boot({ width: 375 });
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  ctx.click("#open-mobile-sources");
  const drawer = ctx.id("source-drawer");
  assert.equal(drawer.hidden, false);
  assert.equal(ctx.id("page").hasAttribute("inert"), true, "background is inert while the drawer is open");

  const withdrawButton = ctx.$("#drawer-source-detail [data-toggle-withdraw]");
  withdrawButton.click();
  assert.equal(drawer.hidden, false, "drawer stays open after excluding");
  assert.equal(ctx.id("page").hasAttribute("inert"), true, "background stays inert");
  const undo = ctx.$("#drawer-source-detail [data-undo-exclusion]");
  assert.ok(undo, "undo is reachable inside the open drawer");
  assert.ok(drawer.contains(ctx.doc.activeElement), "focus stays inside the open dialog");

  undo.click();
  assert.equal(ctx.demo.sourceStatus("S2"), "active");
  assert.equal(drawer.hidden, false);
  assert.ok(drawer.contains(ctx.doc.activeElement), "focus stays inside the dialog after undo");

  ctx.keydown("Escape", false);
  assert.equal(drawer.hidden, true);
  assert.equal(ctx.id("page").hasAttribute("inert"), false);
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

test("quick follow-ups sit next to the composer and leave the draft untouched", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  assert.equal(ctx.id("followup-rail").hidden, true);
  enterDemo(ctx);
  assert.equal(ctx.id("followup-rail").hidden, false);
  const dock = ctx.$(".chat-dock");
  assert.ok(dock.contains(ctx.id("followup-rail")), "follow-ups live in the docked composer");
  const chips = ctx.$$("#followup-rail .prompt-chip");
  assert.equal(chips.length, 3);
  ctx.id("chat-input").value = "我的草稿";
  chips[0].click();
  assert.equal(ctx.id("chat-input").value, "我的草稿", "quick follow-ups do not clear the composer draft");
  assert.equal(ctx.$$("#chat-log .message").length, 2);
});

test("sending a follow-up clears the input only after a successful send and keeps focus", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  ctx.id("chat-input").value = "   ";
  ctx.submit("chat-form");
  assert.equal(ctx.id("chat-input").value, "   ", "an empty send must not clear the draft");
  ctx.id("chat-input").value = "他信任哪些人？";
  ctx.submit("chat-form");
  assert.equal(ctx.id("chat-input").value, "");
  assert.equal(ctx.doc.activeElement, ctx.id("chat-input"));
  assert.equal(ctx.$$("#chat-log .message").length, 2);
});

test("arbitrary follow-ups state the scripted prototype boundary honestly", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  ctx.id("chat-input").value = "他信任哪些人？";
  ctx.submit("chat-form");
  const messages = ctx.$$("#chat-log .message");
  assert.equal(messages.length, 2);
  assert.match(messages[1].textContent, /示例暂不支持这个问题/);
  assert.doesNotMatch(messages[1].textContent, /示例回答[\s\S]*关键未知/);

  ctx.id("chat-input").value = "还缺哪些证据？";
  ctx.submit("chat-form");
  const after = ctx.$$("#chat-log .message");
  assert.match(after[after.length - 1].textContent, /还缺长期使用记录/);
  assert.match(after[after.length - 1].querySelector("small").textContent, /示例回答/);
});

test("copy report resolves asynchronously, then reports success", async (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  const button = ctx.id("copy-report");
  assert.equal(button.disabled, false);
  button.click();
  assert.equal(ctx.id("export-toast").hidden, true, "success is not claimed before the promise resolves");
  await flush();
  const toast = ctx.id("export-toast");
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /已复制/);
  assert.equal(toast.dataset.tone, "success");
  assert.equal(ctx.clipboardTexts.length, 1);
  assert.match(ctx.clipboardTexts[0], /合成样例/);
  assert.match(ctx.clipboardTexts[0], /## 来源状态/);
  assert.notEqual(ctx.id("desk-state").textContent, toast.textContent, "toast does not overwrite lifecycle state");
});

test("a rejected clipboard reports the download fallback instead of success", async (t) => {
  const ctx = boot({ clipboard: "reject" });
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  ctx.id("copy-report").click();
  await flush();
  const toast = ctx.id("export-toast");
  assert.match(toast.textContent, /复制失败/);
  assert.match(toast.textContent, /下载报告/);
  assert.doesNotMatch(toast.textContent, /已复制/);
  assert.equal(toast.dataset.tone, "error");
});

test("a synchronously blocked clipboard never claims success", (t) => {
  const ctx = boot({ clipboard: "throw" });
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  ctx.id("copy-report").click();
  const toast = ctx.id("export-toast");
  assert.match(toast.textContent, /复制失败/);
  assert.match(toast.textContent, /下载报告/);
  assert.doesNotMatch(toast.textContent, /已复制/);
});

test("copy stays gated before a report and warns when the clipboard is missing", (t) => {
  const gated = boot();
  t.after(() => gated.dom.window.close());
  assert.equal(gated.id("copy-report").disabled, true);
  gated.id("copy-report").click();
  assert.equal(gated.id("export-toast").hidden, true);

  const noApi = boot({ clipboard: false });
  t.after(() => noApi.dom.window.close());
  enterDemo(noApi);
  noApi.id("copy-report").click();
  assert.match(noApi.id("export-toast").textContent, /复制不可用/);
  assert.doesNotMatch(noApi.id("export-toast").textContent, /已复制/);
});

test("report headings keep fact, inference and unknown separation", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  const headings = ctx.$$("#report .report-section h4").map((heading) => heading.textContent);
  assert.deepEqual(headings, ["这个人是谁", "做过什么", "查到的事实", "可能的解释", "还不确定", "继续追问"]);
});

test("source panel uses plain labels and explains what a source cannot show", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  const detail = ctx.id("inspector-detail").textContent;
  ["原文", "日期", "能说明什么", "还不能说明什么"].forEach((label) => {
    assert.ok(detail.includes(label), "missing source label: " + label);
  });
  assert.match(detail, /不采用这条来源/);
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
  assert.match(ctx.id("drawer-source-detail").textContent, /个人主页/);

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
  assert.match(ctx.id("report-question").textContent, /林舟如何设计 Lantern/);
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
  fillValidForm(ctx);
  ctx.submit("research-form");
  ctx.click("#confirm-identity");
  assert.equal(ctx.demo.isReportReady(), true);
  assert.equal(ctx.demo.timerActive(), false);
  assert.equal(ctx.id("report").hidden, false);
  assert.equal(ctx.id("run-progress").getAttribute("aria-valuenow"), "5");
});

test("markdown export carries the question and the synthetic badge", (t) => {
  const ctx = boot();
  t.after(() => ctx.dom.window.close());
  ctx.demo.setRunDelay(100000);
  fillValidForm(ctx, "林舟在 Lantern 中如何保留反证？");
  ctx.submit("research-form");
  ctx.click("#confirm-identity");
  for (let i = 0; i < 8; i += 1) ctx.demo.advanceRun();
  const markdown = ctx.demo.buildMarkdown();
  assert.match(markdown, /合成样例/);
  assert.match(markdown, /林舟在 Lantern 中如何保留反证？/);
  assert.match(markdown, /## 来源状态/);
  assert.match(markdown, /## 还不确定/);
});

// Parent review: a late clipboard result belongs to the report that was copied.
test("pending copy cannot show success in a new research", async (t) => {
  let resolveCopy;
  const ctx = boot({ clipboard: () => new Promise(resolve => { resolveCopy = resolve; }) });
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  ctx.click("#copy-report");
  assert.equal(ctx.id("copy-report").disabled, true);
  ctx.click("#copy-report");
  assert.equal(ctx.clipboardTexts.length, 1);
  ctx.click("#new-research");
  resolveCopy();
  await flush();
  assert.equal(ctx.id("export-toast").hidden, true);
  assert.equal(ctx.id("copy-report").disabled, true);
});

test("source changes during copy require copying the updated report", async (t) => {
  let resolveCopy;
  const ctx = boot({ clipboard: () => new Promise(resolve => { resolveCopy = resolve; }) });
  t.after(() => ctx.dom.window.close());
  enterDemo(ctx);
  ctx.click("#copy-report");
  withdrawS2(ctx);
  resolveCopy();
  await flush();
  assert.match(ctx.id("export-toast").textContent, /报告已变化/);
  assert.equal(ctx.id("copy-report").disabled, false);
  assert.equal(ctx.id("desk-state").textContent, "4 处待复核");
});
