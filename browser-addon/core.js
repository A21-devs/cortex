/*
 * Cortex live capture: the part that needs no page. Which sites, which conversation, which turns are finished.
 * Loaded before content.js on the sites you approve, and by the tests (which feed it made-up snapshots).
 */
(function (root) {
  "use strict";

  /* The only sites this add-on can ever read. You approve each one on the options page and can remove it again. */
  var SITES = {
    chatgpt: { label: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"], matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"], conversation: /\/c\/([A-Za-z0-9-]{8,})/ },
    claude: { label: "Claude", hosts: ["claude.ai"], matches: ["https://claude.ai/*"], conversation: /\/chat\/([A-Za-z0-9-]{8,})/ },
    gemini: { label: "Gemini", hosts: ["gemini.google.com"], matches: ["https://gemini.google.com/*"], conversation: /\/app\/([A-Za-z0-9_-]{8,})/ }
  };

  function siteOfHost(host) {
    var h = String(host || "").toLowerCase();
    for (var id in SITES) if (SITES[id].hosts.indexOf(h) >= 0) return id;
    return null;
  }

  /* The site's own conversation id from the address path; null on a page that is not a conversation yet. */
  function conversationOf(site, pathname) {
    var s = SITES[site];
    if (!s) return null;
    var m = s.conversation.exec(String(pathname || ""));
    return m ? m[1] : null;
  }

  /* cyrb53: a short stable fingerprint of a string (not a secret, only an id). */
  function hash53(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  /*
   * Ids for turns that carry none in the page: role and text, plus a counter for exact repeats, so a turn keeps its id
   * when older messages load above it. `turns` is [{ role, text, id? }] in page order; a given id is kept.
   */
  function withIds(conversation, turns) {
    var counts = {};
    return turns.map(function (t) {
      var text = String(t.text || "").trim();
      if (t.id) return { id: String(t.id), role: t.role, text: text };
      var key = t.role + "|" + hash53(text);
      var n = counts[key] || 0;
      counts[key] = n + 1;
      return { id: conversation + ":" + hash53(key) + (n ? "." + n : ""), role: t.role, text: text };
    });
  }

  /*
   * Decides which turns are finished. A turn counts when its text has not changed for `settleMs` and the page is not
   * still writing a reply. Turns already on the page when it opened (the first `baselineMs`) are not sent unless
   * `backfill` is on, so opening an old conversation does not copy it.
   */
  function createTracker(opts) {
    opts = opts || {};
    var settleMs = opts.settleMs == null ? 3000 : opts.settleMs;
    var baselineMs = opts.baselineMs == null ? 4000 : opts.baselineMs;
    var backfill = !!opts.backfill;
    var startedAt = null;
    var seen = Object.create(null);
    var done = Object.create(null);
    return {
      update: function (now, turns, busy) {
        if (startedAt === null) startedAt = now;
        var out = [];
        var present = Object.create(null);
        for (var i = 0; i < turns.length; i++) {
          var t = turns[i];
          if (!t.text) continue;
          present[t.id] = true;
          var s = seen[t.id];
          if (!s) s = seen[t.id] = { text: t.text, changedAt: now };
          else if (s.text !== t.text) { s.text = t.text; s.changedAt = now; }
          if (done[t.id]) continue;
          if (!backfill && now - startedAt < baselineMs) { done[t.id] = "baseline"; continue; }
          if (busy && t.role === "assistant") continue;
          if (now - s.changedAt < settleMs) continue;
          done[t.id] = "sent";
          out.push({ id: t.id, role: t.role, text: s.text, at: new Date(now).toISOString() });
        }
        for (var id in seen) if (!present[id] && !done[id]) delete seen[id];
        return out;
      },
      /* True while something is waiting to settle (the page keeps polling then). */
      pending: function () {
        for (var id in seen) if (!done[id]) return true;
        return false;
      }
    };
  }

  /* The page title without the site's own name; null when nothing else is left. */
  function cleanTitle(title) {
    var t = String(title || "").replace(/\s+/g, " ").trim().replace(/\s*[-|–—]\s*(ChatGPT|Claude|Gemini|Google Gemini)\s*$/i, "").trim();
    return t === "" || /^(ChatGPT|Claude|Gemini|Google Gemini)$/i.test(t) ? null : t.slice(0, 200);
  }

  var api = { SITES: SITES, siteOfHost: siteOfHost, conversationOf: conversationOf, hash53: hash53, withIds: withIds, createTracker: createTracker, cleanTitle: cleanTitle };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CortexCaptureCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
