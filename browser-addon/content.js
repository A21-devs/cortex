/*
 * Cortex live capture: the page side. Runs only on the sites you approved on the options page. It reads the visible
 * conversation, waits until a turn is finished (core.js), and hands it to the background script, which posts it to
 * Cortex on 127.0.0.1. It never reads anything but the chat messages, and never changes the page.
 *
 * The selectors below are the one place that knows how each site draws its messages. Sites change their markup now
 * and then: if a site stops being captured, this table is what needs updating.
 */
(function () {
  "use strict";
  var core = globalThis.CortexCaptureCore;
  if (!core || typeof chrome === "undefined" || !chrome.runtime) return;
  var site = core.siteOfHost(location.hostname);
  if (!site) return;

  function textOf(el) {
    return (el.innerText || el.textContent || "").trim();
  }

  var SELECTORS = {
    chatgpt: {
      turns: function (doc) {
        var out = [];
        doc.querySelectorAll("[data-message-author-role]").forEach(function (el) {
          var role = el.getAttribute("data-message-author-role");
          if (role !== "user" && role !== "assistant") return;
          out.push({ id: el.getAttribute("data-message-id") || undefined, role: role, text: textOf(el) });
        });
        return out;
      },
      busy: function (doc) {
        return !!doc.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"]');
      }
    },
    claude: {
      turns: function (doc) {
        var out = [];
        var any = '[data-testid="user-message"], .font-claude-response, .font-claude-message';
        doc.querySelectorAll(any).forEach(function (el) {
          if (el.parentElement && el.parentElement.closest(any)) return;
          out.push({ role: el.matches('[data-testid="user-message"]') ? "user" : "assistant", text: textOf(el) });
        });
        return out;
      },
      busy: function (doc) {
        return !!doc.querySelector('[data-is-streaming="true"], button[aria-label*="Stop"]');
      }
    },
    gemini: {
      turns: function (doc) {
        var out = [];
        doc.querySelectorAll("user-query, model-response").forEach(function (el) {
          var user = el.tagName.toLowerCase() === "user-query";
          var body = user ? el.querySelector(".query-text") || el : el.querySelector("message-content") || el;
          out.push({ role: user ? "user" : "assistant", text: textOf(body) });
        });
        return out;
      },
      busy: function (doc) {
        return !!doc.querySelector('button[aria-label*="Stop"], .stop-icon');
      }
    }
  };

  var sel = SELECTORS[site];
  var tracker = null;
  var trackerFor = null;
  var backfill = false;
  var timer = null;

  function schedule(ms) {
    if (timer === null) timer = setTimeout(scan, ms);
  }

  function scan() {
    timer = null;
    var conversation = core.conversationOf(site, location.pathname);
    if (!conversation) {
      tracker = null;
      trackerFor = null;
      return;
    }
    if (trackerFor !== conversation) {
      tracker = core.createTracker({ backfill: backfill });
      trackerFor = conversation;
    }
    var turns = core.withIds(conversation, sel.turns(document));
    var ready = tracker.update(Date.now(), turns, sel.busy(document));
    if (ready.length > 0) {
      try {
        chrome.runtime.sendMessage({ type: "cortex-turns", site: site, conversation: conversation, title: core.cleanTitle(document.title), turns: ready });
      } catch (e) {
        return; /* the extension was reloaded: this page's copy of the script stops */
      }
    }
    if (tracker.pending()) schedule(1000);
  }

  chrome.storage.local.get({ backfill: false }, function (v) {
    backfill = v.backfill === true;
    new MutationObserver(function () { schedule(1000); }).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(function () { if (trackerFor !== core.conversationOf(site, location.pathname)) schedule(0); }, 1500);
    schedule(1000);
  });
})();
