/**
 * The offline reader inside a hand-over bundle (`reader.html`): one page that takes the encrypted export and enough key shares,
 * rebuilds the key in the browser, decrypts the export and lists the zip inside, with a way to read a file or save the unlocked
 * zip. Web Crypto only (SHA-256, HKDF, AES-256-GCM) and the browser's own inflate; nothing is loaded and nothing is sent (a
 * content-security policy forbids both). The script is also run under Node in tests, against real exports and real shares.
 *
 * The share format and the export format are the ones in shared/crypto/shamir.ts and store/exportCrypto.ts; the word list is
 * the one in shared/crypto/shareWords.ts, written into the page.
 */
import { SHARE_WORDS } from "../shared/crypto/shareWords";
import { t } from "../ui/copy";

export const READER_KEYS = [
  "readerTitle",
  "readerIntro",
  "readerOffline",
  "readerFile",
  "readerShares",
  "readerSharesNote",
  "readerAdd",
  "readerOpen",
  "readerNoFile",
  "readerNoCrypto",
  "readerBadFile",
  "readerBadShare",
  "readerWhyLength",
  "readerWhyWord",
  "readerWhyCheck",
  "readerWhyForm",
  "readerFew",
  "readerMixed",
  "readerWrong",
  "readerOpened",
  "readerSave",
  "readerPick",
  "readerTooBig",
  "readerBinary",
] as const;
export type ReaderKey = (typeof READER_KEYS)[number];
export type ReaderStrings = Readonly<Record<ReaderKey, string>>;

export function readerStrings(): ReaderStrings {
  const out = {} as Record<ReaderKey, string>;
  for (const k of READER_KEYS) out[k] = t(`handover.${k}`);
  return out;
}

/** The reader's script: `__WORDS__` is replaced with the word list. It exposes `CortexHandover` on `window` (or `globalThis`). */
export const READER_JS = String.raw`(function (root) {
  "use strict";
  var WORDS = __WORDS__;
  var INDEX = Object.create(null);
  for (var wi = 0; wi < WORDS.length; wi++) INDEX[WORDS[wi]] = wi;
  var subtle = root.crypto && root.crypto.subtle;
  var enc = new TextEncoder();

  function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
  function hex(b) { var s = ""; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16); return s; }
  async function sha(bytes) { return new Uint8Array(await subtle.digest("SHA-256", bytes)); }
  function wordsOf(text) { return text.toLowerCase().replace(/\b\d+[.):]/g, " ").split(/[^a-z]+/).filter(function (w) { return w.length > 0; }); }
  function b64u(text) {
    var s = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    try { var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; } catch (e) { return null; }
  }

  // GF(256), the AES field
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () { var x = 1; for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; var d = x << 1; if (d & 256) d ^= 283; x = d ^ x; } for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255]; })();
  function mul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }
  function div(a, b) { return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]]; }

  /** A share from its 32 words or its CXS1 text: {ok:true, share:{k,x,tag,y}} or {ok:false, why, at}. */
  async function parseShare(text) {
    var t = text.trim(), bytes;
    if (/^cxs1:/i.test(t)) {
      bytes = b64u(t.slice(5));
      if (!bytes) return { ok: false, why: "form" };
    } else {
      var w = wordsOf(t);
      if (w.length !== 32) return { ok: false, why: "length" };
      bytes = new Uint8Array(40);
      var acc = 0, bits = 0, n = 0;
      for (var i = 0; i < 32; i++) {
        var v = INDEX[w[i]];
        if (v === undefined) return { ok: false, why: "word", at: i + 1 };
        acc = (acc << 10) | v; bits += 10;
        while (bits >= 8) { bits -= 8; bytes[n++] = (acc >> bits) & 255; }
        acc &= (1 << bits) - 1;
      }
    }
    if (bytes.length !== 40) return { ok: false, why: "form" };
    var h = await sha(concat(enc.encode("cortex-key-share 1"), bytes.subarray(0, 38)));
    if (h[0] !== bytes[38] || h[1] !== bytes[39]) return { ok: false, why: "check" };
    if ((bytes[0] >> 4) !== 1) return { ok: false, why: "form" };
    var k = bytes[0] & 15, x = bytes[1];
    if (k < 2 || x < 1) return { ok: false, why: "form" };
    return { ok: true, share: { k: k, x: x, tag: hex(bytes.subarray(2, 6)), y: bytes.slice(6, 38) } };
  }

  function combine(shares) {
    var out = new Uint8Array(32);
    for (var i = 0; i < shares.length; i++) {
      var num = 1, den = 1;
      for (var j = 0; j < shares.length; j++) { if (i === j) continue; num = mul(num, shares[j].x); den = mul(den, shares[i].x ^ shares[j].x); }
      var lag = div(num, den);
      for (var b = 0; b < 32; b++) out[b] ^= mul(shares[i].y[b], lag);
    }
    return out;
  }

  async function keyIdOf(key) { return hex((await sha(concat(enc.encode("cortex-key-id"), key))).subarray(0, 8)); }

  /** The unlocked zip: {ok:true, zip, keyId} or {ok:false, why:"file"|"few"|"mixed"|"wrong", need, have}. */
  async function openExport(file, shares) {
    if (file.length < 54 || file[0] !== 0x43 || file[1] !== 0x58 || file[2] !== 0x58 || file[3] !== 0x31) return { ok: false, why: "file" };
    var frame = file.subarray(20);
    if (frame[0] !== 0x43 || frame[1] !== 0x58 || frame[2] !== 0x45 || frame[3] !== 0x31 || frame[4] !== 1 || frame[5] !== 1) return { ok: false, why: "file" };
    if (shares.length === 0) return { ok: false, why: "few", need: 2, have: 0 };
    var k = shares[0].k, tag = shares[0].tag, seen = Object.create(null), pts = [];
    for (var i = 0; i < shares.length; i++) {
      if (shares[i].k !== k || shares[i].tag !== tag) return { ok: false, why: "mixed" };
      if (!seen[shares[i].x]) { seen[shares[i].x] = 1; pts.push(shares[i]); }
    }
    if (pts.length < k) return { ok: false, why: "few", need: k, have: pts.length };
    var key = combine(pts.slice(0, k));
    var base = await subtle.importKey("raw", key, "HKDF", false, ["deriveKey"]);
    var aes = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: file.subarray(4, 20), info: enc.encode("cortex record export v1") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    var plain;
    try {
      plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: frame.subarray(6, 18), additionalData: frame.subarray(0, 6), tagLength: 128 }, aes, frame.subarray(18)));
    } catch (e) { return { ok: false, why: "wrong" }; }
    return { ok: true, zip: plain, keyId: await keyIdOf(key) };
  }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /** The members of a zip: [{name, method, csize, size, lho}], or null when it is not one. */
  function listZip(z) {
    var eocd = -1;
    for (var i = z.length - 22; i >= Math.max(0, z.length - 65557); i--) if (u32(z, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    var n = u16(z, eocd + 10), p = u32(z, eocd + 16), out = [];
    for (var j = 0; j < n; j++) {
      if (u32(z, p) !== 0x02014b50) return null;
      var nl = u16(z, p + 28), el = u16(z, p + 30), cl = u16(z, p + 32);
      out.push({ name: new TextDecoder().decode(z.subarray(p + 46, p + 46 + nl)), method: u16(z, p + 10), csize: u32(z, p + 20), size: u32(z, p + 24), lho: u32(z, p + 42) });
      p += 46 + nl + el + cl;
    }
    return out;
  }

  async function readEntry(z, e) {
    var p = e.lho;
    if (u32(z, p) !== 0x04034b50) return null;
    var start = p + 30 + u16(z, p + 26) + u16(z, p + 28), data = z.subarray(start, start + e.csize);
    if (e.method === 0) return data.slice();
    if (e.method !== 8) return null;
    var ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter();
    w.write(data); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }

  root.CortexHandover = { parseShare: parseShare, combine: combine, openExport: openExport, listZip: listZip, readEntry: readEntry, keyIdOf: keyIdOf };

  if (typeof document === "undefined") return;
  var S = JSON.parse(document.getElementById("cortex-strings").textContent);
  function $(id) { return document.getElementById(id); }
  function fill(s, v) { return s.replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] !== undefined ? String(v[k]) : m; }); }
  var status = $("status"), list = $("files"), view = $("view"), save = $("save"), fileBytes = null, unlocked = null;
  function say(text, bad) { status.textContent = text; status.className = bad ? "bad" : "good"; }
  if (!subtle) { say(S.readerNoCrypto, true); return; }
  function addBox() { var ta = document.createElement("textarea"); ta.rows = 3; ta.spellcheck = false; ta.autocomplete = "off"; $("boxes").appendChild(ta); }
  addBox(); addBox(); addBox();
  $("add").addEventListener("click", addBox);
  $("pick").addEventListener("change", async function (ev) {
    var f = ev.target.files && ev.target.files[0];
    fileBytes = f ? new Uint8Array(await f.arrayBuffer()) : null;
  });
  var WHY = { length: S.readerWhyLength, word: S.readerWhyWord, check: S.readerWhyCheck, form: S.readerWhyForm };
  $("open").addEventListener("click", async function () {
    list.textContent = ""; view.textContent = ""; save.hidden = true; unlocked = null;
    if (!fileBytes) return say(S.readerNoFile, true);
    var shares = [], boxes = document.querySelectorAll("#boxes textarea");
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].value.trim() === "") continue;
      var r = await parseShare(boxes[i].value);
      if (!r.ok) return say(fill(S.readerBadShare, { n: i + 1, why: fill(WHY[r.why] || S.readerWhyForm, { n: r.at }) }), true);
      shares.push(r.share);
    }
    var res = await openExport(fileBytes, shares);
    if (!res.ok) {
      if (res.why === "file") return say(S.readerBadFile, true);
      if (res.why === "few") return say(fill(S.readerFew, { need: res.need, have: res.have }), true);
      if (res.why === "mixed") return say(S.readerMixed, true);
      return say(S.readerWrong, true);
    }
    var entries = listZip(res.zip);
    if (!entries) return say(S.readerBadFile, true);
    unlocked = res.zip;
    say(fill(S.readerOpened, { n: entries.length }), false);
    view.textContent = S.readerPick;
    entries.forEach(function (e) {
      var li = document.createElement("li"), b = document.createElement("button");
      b.type = "button"; b.textContent = e.name + " (" + e.size + ")";
      b.addEventListener("click", async function () {
        if (e.size > 2000000) { view.textContent = S.readerTooBig; return; }
        var data = await readEntry(res.zip, e);
        if (!data) { view.textContent = S.readerBinary; return; }
        for (var q = 0; q < Math.min(4096, data.length); q++) if (data[q] === 0) { view.textContent = S.readerBinary; return; }
        view.textContent = new TextDecoder().decode(data);
      });
      li.appendChild(b); list.appendChild(li);
    });
    save.hidden = false;
  });
  save.addEventListener("click", function () {
    if (!unlocked) return;
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([unlocked], { type: "application/zip" }));
    a.download = "cortex-record.zip";
    document.body.appendChild(a); a.click(); a.remove();
  });
})(typeof window !== "undefined" ? window : globalThis);`;

/** The script with the word list filled in (what the page and the tests run). */
export function readerScript(): string {
  return READER_JS.replace("__WORDS__", JSON.stringify(SHARE_WORDS));
}

const htmlEsc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonEsc = (s: string): string => s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function buildReaderHtml(strings: ReaderStrings = readerStrings()): string {
  const S = strings;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEsc(S.readerTitle)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c20;--mut:#5b5b66;--good:#14763d;--bad:#b4231a;--line:#dcdce2}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#ececf1;--mut:#a0a0ad;--good:#58c98a;--bad:#ff8a80;--line:#34343c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:2rem 1rem 4rem}
h1{font-size:1.4rem;margin:0 0 .25rem}h2{font-size:1.02rem;margin:1.4rem 0 .3rem}p{color:var(--mut);margin:.25rem 0 .8rem}
textarea{display:block;width:100%;box-sizing:border-box;margin:.4rem 0;padding:.5rem;border:1px solid var(--line);border-radius:.4rem;background:transparent;color:inherit;font:14px ui-monospace,Consolas,monospace}
button{font:inherit;border:1px solid var(--line);border-radius:.5rem;padding:.4rem .8rem;background:transparent;color:inherit;cursor:pointer}
#status{font-weight:600;margin:1rem 0}#status.good{color:var(--good)}#status.bad{color:var(--bad)}
ul{list-style:none;padding:0;margin:.5rem 0}li{margin:.2rem 0}li button{border:0;padding:.1rem 0;text-decoration:underline}
pre{white-space:pre-wrap;word-break:break-word;border:1px solid var(--line);border-radius:.4rem;padding:.7rem;max-height:30rem;overflow:auto}
</style>
</head>
<body>
<main>
<h1>${htmlEsc(S.readerTitle)}</h1>
<p>${htmlEsc(S.readerIntro)}</p>
<p>${htmlEsc(S.readerOffline)}</p>
<h2>${htmlEsc(S.readerFile)}</h2>
<input id="pick" type="file">
<h2>${htmlEsc(S.readerShares)}</h2>
<p>${htmlEsc(S.readerSharesNote)}</p>
<div id="boxes"></div>
<button id="add" type="button">${htmlEsc(S.readerAdd)}</button>
<p></p>
<button id="open" type="button">${htmlEsc(S.readerOpen)}</button>
<div id="status" role="status"></div>
<ul id="files"></ul>
<button id="save" type="button" hidden>${htmlEsc(S.readerSave)}</button>
<pre id="view"></pre>
</main>
<script type="application/json" id="cortex-strings">${jsonEsc(JSON.stringify(S))}</script>
<script>${readerScript()}</script>
</body>
</html>
`;
}
