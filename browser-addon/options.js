/* Cortex live capture: the options page. Settings live in this browser only (chrome.storage.local). */
(function () {
  "use strict";
  var core = globalThis.CortexCaptureCore;
  var $ = function (id) { return document.getElementById(id); };
  var REASONS = {
    unreachable: "Cortex did not answer. Is it open, and is live capture turned on in Sources?",
    "no-token": "Paste the token first.",
    "bad-token": "Cortex does not accept this token. Copy it again from Sources, Live capture.",
    paused: "Cortex has capture paused.",
    "site-off": "That site is not approved in Cortex yet.",
    "bad-host": "The port does not look like Cortex's.",
    "bad-origin": "Cortex refused this add-on.",
    "rate-limited": "Too many wrong tokens just now; wait a minute."
  };

  function show(text) { $("status").textContent = text; }

  function load() {
    chrome.storage.local.get({ port: 47831, token: "", sites: {}, backfill: false, status: null }).then(function (s) {
      $("port").value = s.port;
      $("token").value = s.token;
      $("backfill").checked = s.backfill === true;
      document.querySelectorAll("[data-site]").forEach(function (box) {
        var id = box.getAttribute("data-site");
        chrome.permissions.contains({ origins: core.SITES[id].matches }).then(function (granted) { box.checked = s.sites[id] === true && granted; });
      });
      if (s.status) show((s.status.ok ? "Last post worked. " : "Last post was refused: " + (REASONS[s.status.reason] || s.status.reason) + " ") + "Turns sent so far: " + (s.status.sent || 0) + ".");
    });
  }

  function save() {
    var port = Number($("port").value);
    chrome.storage.local.set({ port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 47831, token: $("token").value.trim(), backfill: $("backfill").checked });
  }

  ["port", "token", "backfill"].forEach(function (id) { $(id).addEventListener("change", save); });

  $("test").addEventListener("click", function () {
    save();
    show("Asking Cortex…");
    chrome.runtime.sendMessage({ type: "cortex-ping" }, function (r) {
      show(r && r.ok ? "Connected. Cortex answered." : REASONS[(r && r.reason) || "unreachable"] || "Cortex refused: " + (r && r.reason));
    });
  });

  document.querySelectorAll("[data-site]").forEach(function (box) {
    box.addEventListener("change", function () {
      var id = box.getAttribute("data-site");
      var origins = core.SITES[id].matches;
      var apply = function (on) {
        chrome.storage.local.get({ sites: {} }).then(function (s) {
          s.sites[id] = on;
          return chrome.storage.local.set({ sites: s.sites });
        }).then(function () { chrome.runtime.sendMessage({ type: "cortex-sync" }); });
      };
      if (box.checked) {
        chrome.permissions.request({ origins: origins }).then(function (ok) { box.checked = ok; apply(ok); });
      } else {
        apply(false);
        chrome.permissions.remove({ origins: origins }).then(function () { chrome.runtime.sendMessage({ type: "cortex-sync" }); });
      }
    });
  });

  load();
})();
