/*
 * Cortex live capture: the background script. It is the only part that talks to Cortex, and only to
 * http://127.0.0.1:<port> on this computer, with the token you pasted on the options page. It posts the finished
 * turns the page script hands it, keeps a short queue while Cortex is not running, and registers the page script
 * only for sites you approved (and granted the browser permission for).
 */
importScripts("core.js");

var core = self.CortexCaptureCore;
var PENDING_MAX = 200;

function getSettings() {
  return chrome.storage.local.get({ port: 47831, token: "", sites: {}, backfill: false, pending: [], status: null });
}

function setStatus(ok, reason, sentMore) {
  return chrome.storage.local.get({ status: null }).then(function (v) {
    var prev = v.status || { sent: 0 };
    return chrome.storage.local.set({ status: { at: new Date().toISOString(), ok: ok, reason: reason || "", sent: (prev.sent || 0) + (sentMore || 0) } });
  });
}

function endpoint(port, path) {
  return "http://127.0.0.1:" + Number(port) + path;
}

/* One request to Cortex. Resolves { ok, reason, retry }. */
function call(s, method, path, body) {
  return fetch(endpoint(s.port, path), {
    method: method,
    headers: { Authorization: "Bearer " + s.token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(
    function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (res.ok) return { ok: true, reason: "", retry: false, body: j };
        return { ok: false, reason: (j && j.reason) || "refused", retry: res.status >= 500 };
      });
    },
    function () { return { ok: false, reason: "unreachable", retry: true }; }
  );
}

var flushing = false;

/* Post what is waiting, oldest first; stops at the first post Cortex could not be reached for (it stays queued). */
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    var s = await getSettings();
    if (!s.token || s.pending.length === 0) return;
    var left = s.pending.slice();
    var sent = 0;
    while (left.length > 0) {
      var r = await call(s, "POST", "/v1/turns", left[0]);
      if (r.ok) {
        sent += left[0].turns.length;
        left.shift();
      } else if (r.retry) {
        await setStatus(false, r.reason, 0);
        break;
      } else {
        /* refused (paused, site not approved, wrong token): a refused post is not kept */
        await setStatus(false, r.reason, 0);
        left.shift();
      }
    }
    await chrome.storage.local.set({ pending: left });
    if (sent > 0) await setStatus(true, "", sent);
  } finally {
    flushing = false;
  }
}

function enqueue(post) {
  return getSettings().then(function (s) {
    var pending = s.pending.concat([post]).slice(-PENDING_MAX);
    return chrome.storage.local.set({ pending: pending });
  }).then(flush);
}

function syncScripts() {
  return getSettings().then(function (s) {
    return chrome.scripting.getRegisteredContentScripts().then(function (have) {
      var ids = {};
      have.forEach(function (h) { ids[h.id] = true; });
      var work = Object.keys(core.SITES).map(function (id) {
        var site = core.SITES[id];
        var rid = "cortex-" + id;
        return chrome.permissions.contains({ origins: site.matches }).then(function (granted) {
          var wanted = s.sites[id] === true && granted;
          if (wanted && !ids[rid]) return chrome.scripting.registerContentScripts([{ id: rid, matches: site.matches, js: ["core.js", "content.js"], runAt: "document_idle", persistAcrossSessions: true }]);
          if (!wanted && ids[rid]) return chrome.scripting.unregisterContentScripts({ ids: [rid] });
        });
      });
      return Promise.all(work);
    });
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  if (msg.type === "cortex-turns") {
    var host = "";
    try { host = new URL(sender.tab && sender.tab.url).hostname; } catch (e) { return false; }
    var site = core.siteOfHost(host);
    getSettings().then(function (s) {
      if (!site || site !== msg.site || s.sites[site] !== true) return;
      return enqueue({ v: 1, site: site, conversation: String(msg.conversation || ""), title: msg.title || undefined, turns: Array.isArray(msg.turns) ? msg.turns : [] });
    });
    return false;
  }
  if (msg.type === "cortex-ping") {
    getSettings().then(function (s) {
      if (!s.token) return { ok: false, reason: "no-token" };
      return call(s, "GET", "/v1/ping");
    }).then(reply);
    return true;
  }
  if (msg.type === "cortex-sync") {
    syncScripts().then(function () { reply({ ok: true }); }, function () { reply({ ok: false }); });
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(function () { syncScripts(); });
chrome.runtime.onStartup.addListener(function () { syncScripts(); flush(); });
chrome.alarms.create("cortex-flush", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(function (a) { if (a.name === "cortex-flush") flush(); });
