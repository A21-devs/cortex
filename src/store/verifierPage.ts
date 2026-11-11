/**
 * The offline verifier that rides inside every proof folder, audit pack and record export (`verify.html`).
 * Plain JavaScript, no network (a content security policy forbids every request), no library: it uses only the
 * browser's own WebCrypto for SHA-256, HMAC-SHA-256 and Ed25519. Owner: proof-audit-export.
 *
 * What it recomputes, from the files alone and with nothing of this computer:
 *  - an entry proof: the text's fingerprint, the entry's leaf, the Merkle path to the block root, the block's hash and
 *    signature, the links to the block that was stamped, the stamp's fingerprint and, from the .ots file, the path to
 *    a Bitcoin block header (its work and its time);
 *  - a seal chain (audit pack, export): every block hash, link and signature, and every anchor;
 *  - a manifest: the SHA-256 of each file the person chooses, and, for an export, that each exported entry sits in
 *    a sealed block whose root recomputes.
 * The page never says a date was proven beyond what the evidence gives: a confirmed Bitcoin header gives "existed by
 * <block time>"; a calendar answer that is not yet confirmed gives only the day it was asked; a seal alone gives the
 * day it was made on that computer.
 *
 * `VERIFIER_JS` is also evaluated by the tests (no DOM needed): `new Function("root", VERIFIER_JS)(globalThis)`
 * leaves `CortexVerify` on the root object. The source must not contain a backtick or a dollar-brace pair.
 */

import { VERIFIER_KEYS, type VerifierKey, type VerifierStrings } from "./verifierKeys";
export { VERIFIER_KEYS, type VerifierKey, type VerifierStrings };

export const VERIFIER_JS = String.raw`(function (root) {
"use strict";
var MIN_DIFFICULTY = 1e10;
var OTS_MAGIC = "004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294";
var TAG_PENDING = "83dfe30d2ef90c8e";
var TAG_BITCOIN = "0588960d73d71901";
var te = new TextEncoder();

function toHex(u8) { var s = ""; for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16); return s; }
function fromHex(h) {
  if (typeof h !== "string" || h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error("hex");
  var o = new Uint8Array(h.length / 2);
  for (var i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
  return o;
}
function fromB64(b) { var bin = atob(b), o = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; }
function utf8(s) { return te.encode(s); }
function subtle() { var c = root.crypto; if (!c || !c.subtle) throw new Error("crypto"); return c.subtle; }
async function sha256(d) { return new Uint8Array(await subtle().digest("SHA-256", d)); }
async function sha256Hex(d) { return toHex(await sha256(typeof d === "string" ? utf8(d) : d)); }
async function hmacHex(saltHex, d) {
  var k = await subtle().importKey("raw", fromHex(saltHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await subtle().sign("HMAC", k, d)));
}
/** true / false, or null when this browser has no Ed25519. */
async function edVerify(pubHex, msg, sigHex) {
  try {
    var k = await subtle().importKey("raw", fromHex(pubHex), { name: "Ed25519" }, false, ["verify"]);
    return await subtle().verify({ name: "Ed25519" }, k, fromHex(sigHex), utf8(msg));
  } catch (e) {
    return e && e.name === "NotSupportedError" ? null : false;
  }
}
async function keyFingerprint(pubHex) {
  var h = (await sha256Hex(fromHex(pubHex))).slice(0, 20);
  return h.match(/.{4}/g).join(" ");
}

async function foldPath(leaf, path) {
  var h = leaf;
  for (var i = 0; i < path.length; i++) h = await sha256Hex(path[i].left ? path[i].h + h : h + path[i].h);
  return h;
}
async function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256Hex("");
  var level = leaves.slice();
  while (level.length > 1) {
    var next = [];
    for (var i = 0; i < level.length; i += 2) next.push(await sha256Hex(level[i] + (i + 1 < level.length ? level[i + 1] : level[i])));
    level = next;
  }
  return level[0];
}
async function leafOf(block, salt, id, sha) {
  if (block.v === 2) return salt ? hmacHex(salt, utf8(id + "\n" + sha)) : null;
  return sha256Hex(id + "\n" + sha);
}
async function blockHash(b) {
  var base = b.n + "|" + b.at + "|" + b.prev + "|" + b.count + "|" + b.root;
  return sha256Hex(b.v === 2 ? "2|" + base + "|" + b.key : base);
}
function statement(hash, by) { return "cortex-seal-signature 2\n" + hash + (by ? "\nsigned by: " + by : ""); }
async function checkHead(b) {
  var hashOk = (await blockHash(b)) === b.hash;
  var sig = b.v === 2 ? (hashOk ? await edVerify(b.key, statement(b.hash, b.by), b.sig) : false) : undefined;
  return { hash: hashOk, sig: sig };
}

// ---- OpenTimestamps (.ots) ----
function Reader(buf) { this.b = buf; this.p = 0; this.nodes = 0; }
Reader.prototype.byte = function () { if (this.p >= this.b.length) throw new Error("ots"); return this.b[this.p++]; };
Reader.prototype.bytes = function (n) { if (n < 0 || this.p + n > this.b.length) throw new Error("ots"); var o = this.b.subarray(this.p, this.p + n); this.p += n; return o; };
Reader.prototype.varuint = function () {
  var v = 0, shift = 0;
  for (;;) { var b = this.byte(); v += (b & 127) * Math.pow(2, shift); if ((b & 128) === 0) return v; shift += 7; if (shift > 49) throw new Error("ots"); }
};
Reader.prototype.varbytes = function () { return this.bytes(this.varuint()); };
Reader.prototype.done = function () { return this.p >= this.b.length; };
var UNARY = { 8: 1, 3: 1, 2: 1, 103: 1, 242: 1, 243: 1 };
var BINARY = { 240: 1, 241: 1 };
function readAtt(r) {
  var tag = toHex(r.bytes(8)), sub = new Reader(r.varbytes());
  if (tag === TAG_PENDING) return { kind: "pending" };
  if (tag === TAG_BITCOIN) return { kind: "bitcoin", height: sub.varuint() };
  return { kind: "unknown" };
}
function readNode(r, depth) {
  if (depth > 256 || ++r.nodes > 100000) throw new Error("ots");
  var node = { atts: [], ops: [] };
  function item(tag) {
    if (tag === 0) { node.atts.push(readAtt(r)); return; }
    if (!UNARY[tag] && !BINARY[tag]) throw new Error("ots");
    var arg = BINARY[tag] ? r.varbytes().slice() : null;
    if (arg && arg.length === 0) throw new Error("ots");
    node.ops.push({ tag: tag, arg: arg, child: readNode(r, depth + 1) });
  }
  var tag = r.byte();
  while (tag === 255) { item(r.byte()); tag = r.byte(); }
  item(tag);
  return node;
}
function parseOts(file) {
  var r = new Reader(file);
  if (toHex(r.bytes(31)) !== OTS_MAGIC) throw new Error("ots");
  if (r.varuint() !== 1) throw new Error("ots");
  if (r.byte() !== 8) throw new Error("ots");
  var digest = r.bytes(32).slice();
  var node = readNode(r, 0);
  if (!r.done()) throw new Error("ots");
  return { digest: digest, root: node };
}
function cat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
async function applyOp(tag, arg, msg) {
  if (tag === 8) return sha256(msg);
  if (tag === 2) return new Uint8Array(await subtle().digest("SHA-1", msg));
  if (tag === 240) return cat(msg, arg);
  if (tag === 241) return cat(arg, msg);
  if (tag === 242) return msg.slice().reverse();
  if (tag === 243) return utf8(toHex(msg));
  return null;
}
async function bitcoinSteps(node, msg, out) {
  for (var i = 0; i < node.atts.length; i++) if (node.atts[i].kind === "bitcoin") out.push({ msg: msg, height: node.atts[i].height });
  for (var j = 0; j < node.ops.length; j++) {
    var next = await applyOp(node.ops[j].tag, node.ops[j].arg, msg);
    if (next) await bitcoinSteps(node.ops[j].child, next, out);
  }
  return out;
}
function targetOf(bits) {
  var exp = bits >>> 24, mant = bits & 0x7fffff;
  if ((bits & 0x800000) !== 0 || mant === 0) return null;
  var t = exp <= 3 ? BigInt(mant >> (8 * (3 - exp))) : BigInt(mant) << BigInt(8 * (exp - 3));
  return t === BigInt(0) || t > (BigInt(1) << BigInt(256)) - BigInt(1) ? null : t;
}
async function verifyHeader(msg, headerHex, minDifficulty) {
  var h = fromHex(headerHex);
  if (h.length !== 80) return { ok: false };
  if (toHex(h.subarray(36, 68)) !== toHex(msg)) return { ok: false };
  var dv = new DataView(h.buffer, h.byteOffset, 80);
  var target = targetOf(dv.getUint32(72, true));
  if (target === null) return { ok: false };
  var hash = BigInt("0x" + toHex((await sha256(await sha256(h))).slice().reverse()));
  if (hash > target) return { ok: false };
  var maxTarget = BigInt(65535) << BigInt(208);
  var floor = (maxTarget * BigInt(1000000000000000)) / BigInt(Math.max(1, Math.ceil(minDifficulty * 1e15)));
  if (target > floor) return { ok: false };
  return { ok: true, time: new Date(dv.getUint32(68, true) * 1000).toISOString() };
}

// ---- one anchor (a stamped block and its .ots file) ----
async function checkStamp(stamp, head, opts, add, vars) {
  var state = "bad";
  var want = head.v === 2 ? head.fp : head.hash;
  if (head.v === 2) {
    var saltOk = typeof stamp.salt === "string" && /^[0-9a-f]{64}$/.test(stamp.salt) && (await hmacHex(stamp.salt, fromHex(head.hash))) === head.fp;
    add("salt", saltOk, vars);
    if (!saltOk) return { state: "bad" };
  }
  var parsed;
  try { parsed = parseOts(fromB64(stamp.ots)); } catch (e) { add("ots", false, vars); return { state: "bad" }; }
  var digestOk = toHex(parsed.digest) === want && stamp.digest === want;
  add("digest", digestOk, vars);
  if (!digestOk) return { state: "bad" };
  var steps = await bitcoinSteps(parsed.root, parsed.digest, []);
  var claim = stamp.bitcoin;
  var step = claim ? steps.filter(function (x) { return x.height === claim.height; })[0] : null;
  if (!claim || !step) {
    add("bitcoin", null, { n: vars.n, at: stamp.at });
    return { state: "pending", at: stamp.at };
  }
  var v = await verifyHeader(step.msg, claim.header, opts.minDifficulty || MIN_DIFFICULTY);
  if (v.ok && v.time === claim.at) {
    add("bitcoin", true, { n: vars.n, height: String(claim.height), at: claim.at });
    return { state: "confirmed", at: claim.at, height: claim.height };
  }
  add("bitcoin", false, { n: vars.n });
  return { state: "bad" };
}

function newReport() {
  var rep = { ok: true, lines: [], date: null };
  rep.add = function (key, v, vars) { rep.lines.push({ key: key, ok: v, vars: vars || {} }); if (v === false) rep.ok = false; };
  return rep;
}

async function checkLinks(block, links, add) {
  var prev = block, good = true;
  for (var i = 0; i < links.length; i++) {
    var l = links[i], c = await checkHead(l);
    if (l.prev !== prev.hash || l.n !== prev.n + 1 || !c.hash || c.sig === false) good = false;
    prev = l;
  }
  add("links", good, { count: String(links.length) });
  return prev;
}

// ---- an entry proof ----
async function checkEntry(p, opts) {
  var rep = newReport(), add = rep.add, e = p.entry, b = p.block, n = String(b.n);
  add("textHash", (await sha256Hex(e.text)) === e.sha256);
  var leaf = await leafOf(b, p.leafSalt, e.id, e.sha256);
  if (leaf === null) { add("leaf", null); add("path", false, { steps: "0" }); }
  else add("path", (await foldPath(leaf, p.path)) === b.root, { steps: String(p.path.length) });
  var c = await checkHead(b);
  add("blockHash", c.hash, { n: n });
  if (b.v === 2) {
    var fp = await keyFingerprint(b.key);
    add("signature", c.sig, { n: n, key: fp });
  } else add("unsigned", null, { n: n });
  var stamped = await checkLinks(b, p.links || [], add);
  var sealedAt = b.at;
  if (p.timestamp) {
    if (stamped.n !== p.timestamp.n) add("links", false, { count: "0" });
    var r = await checkStamp(p.timestamp, stamped, opts, add, { n: String(stamped.n) });
    rep.date = r.state === "confirmed" ? { state: "confirmed", at: r.at, height: r.height } : r.state === "pending" ? { state: "pending", at: p.timestamp.at, sealedAt: sealedAt } : null;
  } else add("noStamp", null, { at: sealedAt });
  if (!rep.date) rep.date = { state: "sealed", at: sealedAt };
  if (!rep.ok) rep.date = { state: "none" };
  return rep;
}

// ---- a seal chain (audit pack, export) ----
async function checkChain(chain, opts, rep) {
  rep = rep || newReport();
  var add = rep.add, confirmed = [], pending = 0, total = 0;
  var computers = chain.computers || [];
  if (computers.length === 0) add("noChain", null);
  for (var ci = 0; ci < computers.length; ci++) {
    var cp = computers[ci], blocks = cp.blocks || [], prev = "", linksOk = true, hashesOk = true, signed = 0, unsigned = 0, sigBad = 0, sigNa = 0;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i], c = await checkHead(b);
      if (b.prev !== prev || b.n !== i + 1) linksOk = false;
      if (!c.hash) hashesOk = false;
      if (b.v === 2) { if (c.sig === true) signed++; else if (c.sig === null) sigNa++; else sigBad++; } else unsigned++;
      prev = b.hash;
    }
    total += blocks.length;
    add("chainLinks", linksOk, { computer: cp.computer, blocks: String(blocks.length) });
    add("chainHashes", hashesOk, { computer: cp.computer, blocks: String(blocks.length) });
    if (sigBad > 0) add("chainSigs", false, { signed: String(signed), unsigned: String(unsigned) });
    else if (sigNa > 0) add("chainSigs", null, { signed: String(signed), unsigned: String(unsigned) });
    else add("chainSigs", true, { signed: String(signed), unsigned: String(unsigned) });
    var stamps = cp.stamps || [];
    for (var si = 0; si < stamps.length; si++) {
      var head = blocks.filter(function (x) { return x.n === stamps[si].n; })[0];
      if (!head) { add("digest", false, { n: String(stamps[si].n) }); continue; }
      var r = await checkStamp(stamps[si], head, opts, add, { n: String(head.n) });
      if (r.state === "confirmed") confirmed.push(r); else if (r.state === "pending") pending++;
    }
  }
  var best = null;
  for (var k = 0; k < confirmed.length; k++) if (!best || confirmed[k].at > best.at) best = confirmed[k];
  rep.chain = { blocks: total, confirmed: confirmed.length, pending: pending, through: best ? best.at : null };
  return rep;
}

// ---- files named in a manifest ----
function norm(p) { return String(p).replace(/\\/g, "/").replace(/^\.\//, ""); }
async function checkFiles(manifest, files, rep) {
  var add = rep.add, list = manifest.files || [], ok = 0, bad = 0, missing = 0;
  var byPath = {};
  files.forEach(function (f) { byPath[norm(f.path)] = f; });
  for (var i = 0; i < list.length; i++) {
    var m = list[i], hit = byPath[norm(m.path)];
    if (!hit) {
      var keys = Object.keys(byPath);
      for (var j = 0; j < keys.length && !hit; j++) if (keys[j].endsWith("/" + norm(m.path))) hit = byPath[keys[j]];
    }
    if (!hit) { missing++; continue; }
    if ((await sha256Hex(hit.bytes)) === m.sha256) ok++; else bad++;
  }
  if (bad > 0) add("files", false, { bad: String(bad), ok: String(ok), total: String(list.length) });
  else if (ok === 0) add("files", null, { missing: String(missing), total: String(list.length) });
  else add("files", true, { ok: String(ok), total: String(list.length) });
  if (bad === 0 && ok > 0 && missing > 0) add("files", null, { missing: String(missing), total: String(list.length) });
  return rep;
}

// ---- exported entries inside sealed blocks ----
async function checkInclusion(inc, chain, rows, rep) {
  var add = rep.add, heads = {};
  (chain.computers || []).forEach(function (cp) { (cp.blocks || []).forEach(function (b) { heads[cp.computer + "/" + b.n] = b; }); });
  var where = {}, rootsOk = 0, rootsBad = 0;
  var blocks = inc.blocks || [];
  for (var i = 0; i < blocks.length; i++) {
    var ib = blocks[i], head = heads[ib.computer + "/" + ib.n];
    if (head && (await merkleRoot(ib.leaves)) === head.root && ib.ids.length === ib.leaves.length) rootsOk++; else rootsBad++;
    for (var j = 0; j < ib.ids.length; j++) where[ib.ids[j]] = { block: ib, head: head, idx: j };
  }
  add("roots", rootsBad === 0, { ok: String(rootsOk), bad: String(rootsBad) });
  if (!rows) { add("inclusion", null, {}); return rep; }
  var good = 0, bad = 0, textBad = 0, unsealed = 0;
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r], w = where[row.id];
    if (typeof row.text === "string" && (await sha256Hex(row.text)) !== row.sha256) { textBad++; continue; }
    if (!row.seal) { unsealed++; continue; }
    if (!w || !w.head) { bad++; continue; }
    var leaf = await leafOf(w.head, w.block.salt, row.id, row.sha256);
    if (leaf !== null && leaf === w.block.leaves[w.idx]) good++; else bad++;
  }
  if (textBad > 0) add("rowText", false, { bad: String(textBad) });
  add("inclusion", bad === 0 && textBad === 0 && good > 0 ? true : bad > 0 ? false : null, { ok: String(good), bad: String(bad), roots: String(rootsOk), unsealed: String(unsealed) });
  return rep;
}

// ---- entry point for a set of files ----
function parseJson(bytes) { try { return JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { return null; } }
async function verifyFiles(files, opts) {
  opts = opts || {};
  var docs = {};
  files.forEach(function (f) { if (/\.json$/i.test(f.path)) { var j = parseJson(f.bytes); if (j && typeof j.format === "string") docs[j.format] = j; } });
  var rep = newReport();
  if (docs["cortex-entry-proof"]) { rep = await checkEntry(docs["cortex-entry-proof"], opts); rep.kind = "entry"; return rep; }
  if (docs["cortex-audit-pack"]) {
    var a = docs["cortex-audit-pack"];
    rep.kind = "audit";
    await checkChain(a, opts, rep);
    await checkFiles(a, files, rep);
    rep.audit = a;
    return rep;
  }
  if (docs["cortex-record-export"]) {
    var m = docs["cortex-record-export"], chain = docs["cortex-seal-chain"] || null, inc = docs["cortex-seal-inclusion"] || null;
    rep.kind = "export";
    if (chain) await checkChain(chain, opts, rep); else rep.add("noChain", null);
    await checkFiles(m, files, rep);
    if (chain && inc) {
      var rows = [];
      files.forEach(function (f) {
        if (/\.jsonl$/i.test(f.path)) new TextDecoder().decode(f.bytes).split("\n").forEach(function (ln) {
          if (ln) { try { var o = JSON.parse(ln); if (o && o.id && o.sha256) rows.push(o); } catch (e) { /* a line that is not json is ignored */ } }
        });
      });
      await checkInclusion(inc, chain, rows.length ? rows : null, rep);
    }
    rep.manifest = m;
    return rep;
  }
  rep.kind = "unknown";
  rep.ok = false;
  return rep;
}

function when(v) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 10) + " " + v.slice(11, 16) + " UTC" : v; }
function fmt(s, vars) { return String(s || "").replace(/\{(\w+)\}/g, function (_, k) { return vars && vars[k] !== undefined ? (k === "at" || k === "asked" ? when(vars[k]) : vars[k]) : "{" + k + "}"; }); }
function lineText(S, l) {
  var suffix = l.ok === true ? "_ok" : l.ok === false ? "_bad" : "_na";
  return fmt(S["l_" + l.key + suffix], l.vars);
}
function headline(S, rep) {
  if (rep.kind === "unknown") return S.unknownKind;
  if (!rep.ok) return S.headlineBad;
  var d = rep.date;
  if (rep.kind === "entry" && d) {
    if (d.state === "confirmed") return fmt(S.dateConfirmed, { at: d.at, height: String(d.height) });
    if (d.state === "pending") return fmt(S.datePending, { at: d.sealedAt, asked: d.at });
    if (d.state === "sealed") return fmt(S.dateSealed, { at: d.at });
  }
  return S.headlineOk;
}

root.CortexVerify = { verifyFiles: verifyFiles, checkEntry: checkEntry, checkChain: checkChain, headline: headline, lineText: lineText, sha256Hex: sha256Hex, merkleRoot: merkleRoot, MIN_DIFFICULTY: MIN_DIFFICULTY };

// ---- the page ----
if (typeof document !== "undefined" && document.getElementById("cortex-strings")) {
  var S = JSON.parse(document.getElementById("cortex-strings").textContent);
  var out = document.getElementById("out"), head = document.getElementById("headline");
  var show = function (rep) {
    head.textContent = headline(S, rep);
    head.className = rep.ok ? "good" : "bad";
    out.textContent = "";
    rep.lines.forEach(function (l) {
      var li = document.createElement("li");
      li.className = l.ok === true ? "good" : l.ok === false ? "bad" : "note";
      li.textContent = lineText(S, l);
      out.appendChild(li);
    });
  };
  var readAll = async function (list) {
    var files = [];
    for (var i = 0; i < list.length; i++) files.push({ path: list[i].webkitRelativePath || list[i].name, bytes: new Uint8Array(await list[i].arrayBuffer()) });
    return files;
  };
  var run = async function (files) {
    try {
      if (!root.crypto || !root.crypto.subtle) { head.textContent = S.noCrypto; head.className = "bad"; return; }
      if (files.length === 0) { head.textContent = S.nothing; head.className = "note"; return; }
      show(await verifyFiles(files, {}));
    } catch (e) { head.textContent = S.unreadable; head.className = "bad"; out.textContent = ""; }
  };
  var embedded = document.getElementById("cortex-data");
  var embeddedFiles = embedded ? [{ path: embedded.getAttribute("data-name") || "data.json", bytes: utf8(embedded.textContent) }] : [];
  var chosen = [];
  document.getElementById("pick").addEventListener("change", async function (ev) { chosen = await readAll(ev.target.files); run(chosen.length ? chosen : embeddedFiles); });
  document.getElementById("pickdir").addEventListener("change", async function (ev) { chosen = await readAll(ev.target.files); run(chosen.length ? chosen : embeddedFiles); });
  run(embeddedFiles);
}
})(typeof window !== "undefined" ? window : globalThis);`;

const esc = (s: string): string => s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const htmlEsc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page itself. `embedded` is the pack's main JSON file, so the page checks it the moment it opens. */
export function buildVerifierHtml(strings: VerifierStrings, embedded?: { name: string; json: string }): string {
  const S = strings;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEsc(S.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c20;--mut:#5b5b66;--good:#14763d;--bad:#b4231a;--line:#dcdce2}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#ececf1;--mut:#a0a0ad;--good:#58c98a;--bad:#ff8a80;--line:#34343c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:2rem 1rem 4rem}
h1{font-size:1.4rem;margin:0 0 .25rem}p{color:var(--mut);margin:.25rem 0 1rem}
#headline{font-size:1.15rem;font-weight:600;margin:1.25rem 0 .75rem}
#headline.good{color:var(--good)}#headline.bad{color:var(--bad)}
ul{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}
li{padding:.55rem 0 .55rem 1.6rem;border-bottom:1px solid var(--line);position:relative}
li::before{position:absolute;left:0;top:.55rem;font-weight:700}
li.good::before{content:"\\2713";color:var(--good)}li.bad::before{content:"\\2717";color:var(--bad)}li.note::before{content:"\\2022";color:var(--mut)}
.pick{display:flex;gap:.75rem;flex-wrap:wrap;margin:1rem 0}
label.btn{border:1px solid var(--line);border-radius:.5rem;padding:.45rem .8rem;cursor:pointer}
input[type=file]{position:absolute;left:-9999px}
</style>
</head>
<body>
<main>
<h1>${htmlEsc(S.title)}</h1>
<p>${htmlEsc(S.intro)}</p>
<p>${htmlEsc(S.offline)}</p>
<div class="pick">
<label class="btn">${htmlEsc(S.chooseFiles)}<input id="pick" type="file" multiple></label>
<label class="btn">${htmlEsc(S.chooseFolder)}<input id="pickdir" type="file" webkitdirectory multiple></label>
</div>
<div id="headline" role="status"></div>
<ul id="out"></ul>
</main>
<script type="application/json" id="cortex-strings">${esc(JSON.stringify(S))}</script>
${embedded ? `<script type="application/json" id="cortex-data" data-name="${htmlEsc(embedded.name)}">${esc(embedded.json)}</script>\n` : ""}<script>${VERIFIER_JS}</script>
</body>
</html>
`;
}
