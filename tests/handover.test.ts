/**
 * Key-holder and heir hand-over: the dated entries leave out every secret, the printable sheet carries the words and the QR
 * code, the offline reader opens a real encrypted export with real shares (and refuses everything else), and the hand-over
 * bundle is built end to end on temp folders with a fake runner. No network and no model.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { holdVaultKey, resetKeyring, setEncryptionConfigured } from "../src/shared/crypto/keyring";
import { decodeShare, parseShareText, shareChecksum, shareToQrText, shareToWords, splitVaultKey } from "../src/shared/crypto/shamir";
import { generateVaultKey, keyId } from "../src/shared/crypto/vaultKey";
import { buildHandoverBundle, recordSealed } from "../src/plugin/handoverFlow";
import { buildReaderHtml, readerScript, readerStrings, READER_KEYS } from "../src/plugin/handoverReader";
import { designationFingerprint, heirEntry, holderEntry } from "../src/plugin/handoverRecord";
import { buildReadme, buildSheetHtml } from "../src/plugin/handoverSheet";
import { encryptExportBytes } from "../src/store/exportCrypto";
import { writePack } from "../src/store/sealPack";
import { COPY } from "../src/ui/copy";
import type { CortexServices } from "../src/plugin/services";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `cx-handover-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => resetKeyring());

interface Reader {
  parseShare(text: string): Promise<{ ok: true; share: { k: number; x: number; tag: string; y: Uint8Array } } | { ok: false; why: string; at?: number }>;
  openExport(file: Uint8Array, shares: unknown[]): Promise<{ ok: true; zip: Uint8Array; keyId: string } | { ok: false; why: string; need?: number; have?: number }>;
  listZip(z: Uint8Array): { name: string; method: number; size: number }[] | null;
  readEntry(z: Uint8Array, e: unknown): Promise<Uint8Array | null>;
  keyIdOf(key: Uint8Array): Promise<string>;
}
function loadReader(): Reader {
  // the page's script, run the way a browser runs it, with no DOM
  const fn = new Function(`${readerScript()}\nreturn globalThis.CortexHandover;`);
  return fn() as Reader;
}

async function sampleZip(): Promise<{ bytes: Uint8Array; files: Record<string, string> }> {
  const dir = tmp("zip");
  const files = { "README.txt": "hello", "entries/a.md": `# A\n${"line of text ".repeat(100)}\n`, "entries/b.jsonl": '{"id":"e_1"}\n' };
  const out = path.join(dir, "x.zip");
  await writePack(out, Object.entries(files).map(([name, data]) => ({ name, data })));
  return { bytes: readFileSync(out), files };
}

describe("the dated entries", () => {
  const base = { name: "Sam <b>Ray</b>", contact: "sam@example.test", instructions: "Open the envelope on my death.", share: 2, total: 3, threshold: 2, checksum: "a1b2-c3d4", keyId: "0123456789abcdef", date: "2026-11-03" };

  it("a holder entry names the person, the share and the day, and holds no contact, instruction, share or key", async () => {
    const key = generateVaultKey();
    const share = splitVaultKey(key, await keyId(key), 2, 3)[1] as Uint8Array;
    const e = holderEntry(base);
    expect(e.title).toBe("Key holder named: Sam <b>Ray</b>");
    expect(e.body).toContain("2026-11-03");
    expect(e.body).toContain("share 2 of 3");
    expect(e.body).toContain("a1b2-c3d4");
    for (const secret of ["sam@example.test", "Open the envelope", shareToWords(share)[0] as string + " " + shareToWords(share)[1], shareToQrText(share)]) expect(e.body).not.toContain(secret);
    expect(e.body).toMatch(/[0-9a-f]{64}/);
  });

  it("the fingerprint commits to the full designation: a changed contact changes it, the order of fields does not", () => {
    const a = designationFingerprint({ kind: "holder", name: "Sam", contact: "x" });
    expect(designationFingerprint({ contact: "x", name: "Sam", kind: "holder" })).toBe(a);
    expect(designationFingerprint({ kind: "holder", name: "Sam", contact: "y" })).not.toBe(a);
    expect(designationFingerprint({ kind: "holder", name: "Sa", contact: "mx" })).not.toBe(a);
    expect(holderEntry({ ...base, contact: "other" }).body).not.toBe(holderEntry(base).body);
  });

  it("an heir entry names the areas, says nothing is released automatically, and leaves out the letter and contact", () => {
    const e = heirEntry({ name: "Ari", contact: "ari@example.test", spaces: ["Software and Computer Science"], letter: "Dear Ari, the secret is 12345.", threshold: 2, date: "2026-11-03", bundle: true });
    expect(e.title).toBe("Heir named: Ari");
    expect(e.body).toContain("Software and Computer Science");
    expect(e.body).toContain("Nothing is released automatically");
    expect(e.body).toContain("hand-over bundle was built on 2026-11-03");
    expect(e.body).not.toContain("12345");
    expect(e.body).not.toContain("ari@example.test");
    expect(heirEntry({ name: "Ari", contact: "", spaces: [], letter: "", threshold: 2, date: "2026-11-03" }).body).toContain("every area");
  });

  it("recordSealed writes the entry, seals it, and reports the sample record and failures", async () => {
    const saved: { title: string; body: string }[] = [];
    const calls: string[] = [];
    const sv = {
      sandbox: { value: false },
      newEntry: { save: async (d: { title: string; body: string }) => (saved.push(d), { path: "p", entryId: "e" }) },
      runner: { request: async (r: { cmd: string }) => (calls.push(r.cmd), { blocks: 1, entries: 1, total: 1, gitChecked: 0, gitFound: 0 }) },
    };
    expect(await recordSealed(sv as never, holderEntry(base))).toEqual({ ok: true });
    expect(saved.length).toBe(1);
    expect(calls).toEqual(["seals.run"]);
    expect(await recordSealed({ ...sv, sandbox: { value: true } } as never, holderEntry(base))).toMatchObject({ ok: false, reason: "sample" });
    expect(await recordSealed({ ...sv, runner: { request: async () => ({ entries: 0 }) } } as never, holderEntry(base))).toMatchObject({ ok: false, reason: "failed" });
    expect(await recordSealed({ ...sv, newEntry: { save: async () => Promise.reject(new Error("disk full.")) } } as never, holderEntry(base))).toEqual({ ok: false, reason: "failed", detail: "disk full" });
  });
});

describe("the printable sheet and the read-me", () => {
  it("carries the 32 words, the QR code, the check code and the instructions, with the holder's text escaped", async () => {
    const key = generateVaultKey();
    const share = splitVaultKey(key, await keyId(key), 2, 3)[1] as Uint8Array;
    const html = buildSheetHtml({ holder: "Sam <script>x</script>", contact: "sam@example.test", instructions: "Keep it dry & dark", x: 2, n: 3, k: 2, checksum: shareChecksum(share), share, date: "2026-11-03" });
    for (const w of shareToWords(share)) expect(html).toContain(`<li>${w}</li>`);
    expect(html).toContain("<svg ");
    expect(html).toContain(shareChecksum(share));
    expect(html).toContain("Keep it dry &amp; dark");
    expect(html).not.toContain("<script");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("never releases a share");
  });

  it("a sheet without the share says the words are no longer held and shows none", () => {
    const html = buildSheetHtml({ holder: "", contact: "", instructions: "", x: 3, n: 3, k: 2, checksum: "a1b2-c3d4", share: null, date: "2026-11-03" });
    expect(html).toContain(COPY.handover.sheetNoWords);
    expect(html).not.toContain("<ol");
    expect(html).not.toContain("<svg");
  });

  it("the read-me says what is inside and what is not", () => {
    const withShare = buildReadme({ name: "Ari", date: "2026-11-03", entries: 12, n: 3, k: 2, shareFile: "share-2.html", hasLetter: true });
    expect(withShare).toContain("share-2.html");
    expect(withShare).toContain("12 files");
    expect(withShare).toContain("letter.txt");
    expect(withShare).toContain("Nothing here releases them");
    const none = buildReadme({ name: "Ari", date: "2026-11-03", entries: 12, n: 3, k: 2, shareFile: null, hasLetter: false });
    expect(none).toContain(COPY.handover.readmeNoShare);
    expect(none).not.toContain("letter.txt");
  });
});

describe("the offline reader", () => {
  it("opens a real encrypted export with 2 of 3 real shares, in either order, and lists and reads the zip inside", async () => {
    const r = loadReader();
    const key = generateVaultKey();
    const id = await keyId(key);
    const shares = splitVaultKey(key, id, 2, 3);
    const zip = await sampleZip();
    const enc = encryptExportBytes(zip.bytes, key);
    const parsed = [];
    for (const i of [2, 0]) {
      const p = await r.parseShare(shareToWords(shares[i] as Uint8Array).join(" "));
      if (!p.ok) throw new Error("share did not parse");
      parsed.push(p.share);
    }
    const out = await r.openExport(enc, parsed);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Buffer.from(out.zip).equals(Buffer.from(zip.bytes))).toBe(true);
    expect(out.keyId).toBe(id);
    const list = r.listZip(out.zip);
    expect(list?.map((e) => e.name).sort()).toEqual(Object.keys(zip.files).sort());
    expect(list?.some((e) => e.method === 8)).toBe(true);
    for (const e of list ?? []) expect(Buffer.from((await r.readEntry(out.zip, e)) as Uint8Array).toString("utf8")).toBe(zip.files[e.name]);
  });

  it("reads shares from words (any case, numbered) and from QR text, and agrees with the app's own reader", async () => {
    const r = loadReader();
    const key = generateVaultKey();
    const shares = splitVaultKey(key, await keyId(key), 2, 3);
    const words = shareToWords(shares[1] as Uint8Array);
    const a = await r.parseShare(words.map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join("\n"));
    const b = await r.parseShare(shareToQrText(shares[1] as Uint8Array));
    const own = decodeShare(shares[1] as Uint8Array);
    if (!a.ok || !b.ok || !own.ok) throw new Error("parse failed");
    expect(a.share.x).toBe(own.share.x);
    expect(a.share.tag).toBe(own.share.tag);
    expect(Buffer.from(a.share.y).equals(Buffer.from(own.share.y))).toBe(true);
    expect(Buffer.from(b.share.y).equals(Buffer.from(own.share.y))).toBe(true);
    expect(parseShareText(words.join(" ")).ok).toBe(true);
    expect(await r.parseShare(words.slice(0, 30).join(" "))).toMatchObject({ ok: false, why: "length" });
    expect(await r.parseShare([...words.slice(0, 9), "zzzzzz", ...words.slice(10)].join(" "))).toMatchObject({ ok: false, why: "word", at: 10 });
    const typo = [...words];
    typo[4] = typo[4] === "able" ? "acid" : "able";
    expect(await r.parseShare(typo.join(" "))).toMatchObject({ ok: false, why: "check" });
    expect(await r.parseShare("constructor __proto__ toString")).toMatchObject({ ok: false });
    expect(await r.keyIdOf(key)).toBe(await keyId(key));
  });

  it("refuses one share, shares of another record, a tampered file and a file that is not an export", async () => {
    const r = loadReader();
    const key = generateVaultKey();
    const shares = splitVaultKey(key, await keyId(key), 2, 3);
    const stranger = generateVaultKey();
    const strange = splitVaultKey(stranger, await keyId(stranger), 2, 3);
    const enc = encryptExportBytes((await sampleZip()).bytes, key);
    const read = async (s: Uint8Array) => {
      const p = await r.parseShare(shareToWords(s).join(" "));
      if (!p.ok) throw new Error("share did not parse");
      return p.share;
    };
    expect(await r.openExport(enc, [await read(shares[0] as Uint8Array)])).toEqual({ ok: false, why: "few", need: 2, have: 1 });
    expect(await r.openExport(enc, [await read(shares[0] as Uint8Array), await read(shares[0] as Uint8Array)])).toEqual({ ok: false, why: "few", need: 2, have: 1 });
    expect(await r.openExport(enc, [])).toMatchObject({ ok: false, why: "few" });
    expect(await r.openExport(enc, [await read(shares[0] as Uint8Array), await read(strange[1] as Uint8Array)])).toEqual({ ok: false, why: "mixed" });
    // a second split of the same key: the tag matches but the shares do not belong together
    const again = splitVaultKey(key, await keyId(key), 2, 3);
    expect(await r.openExport(enc, [await read(shares[0] as Uint8Array), await read(again[1] as Uint8Array)])).toEqual({ ok: false, why: "wrong" });
    const bad = Uint8Array.from(enc);
    bad[bad.length - 5] = (bad[bad.length - 5] as number) ^ 1;
    expect(await r.openExport(bad, [await read(shares[0] as Uint8Array), await read(shares[1] as Uint8Array)])).toEqual({ ok: false, why: "wrong" });
    expect(await r.openExport(new Uint8Array(100), [await read(shares[0] as Uint8Array), await read(shares[1] as Uint8Array)])).toEqual({ ok: false, why: "file" });
    expect(r.listZip(new Uint8Array(50))).toBeNull();
  });

  it("the page loads nothing and sends nothing, and every string comes from the catalogue", () => {
    const html = buildReaderHtml();
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script[^>]+src=|<link |https?:\/\/|fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
    expect(READER_KEYS.every((k) => k in COPY.handover)).toBe(true);
    expect(Object.values(readerStrings()).every((s) => s.length > 0)).toBe(true);
    expect(html).toContain(COPY.handover.readerTitle);
  });
});

describe("the hand-over bundle", () => {
  function fakeServices(root: string, entries = 3) {
    const requests: { cmd: string; args: Record<string, unknown> }[] = [];
    const sv = {
      sandbox: { value: false },
      runner: {
        request: async (r: { cmd: string; args: Record<string, unknown> }) => {
          requests.push(r);
          if (r.cmd !== "export.record") throw new Error("unexpected");
          if (entries === 0) return { entries: 0, skippedClosed: 0, excluded: 0, unreadable: 0, unsealed: 0, inclusionSkipped: 0, files: 0, bytes: 0 };
          await writePack(r.args.out as string, [
            { name: "README.txt", data: "export" },
            { name: "entries/a.md", data: "# Entry A\nthe text of A\n" },
          ]);
          return { entries, skippedClosed: 0, excluded: 0, unreadable: 0, unsealed: 0, inclusionSkipped: 0, files: 2, bytes: 10 };
        },
      },
    } as unknown as CortexServices;
    const out = path.join(root, "bundle.zip");
    const deps = { dialog: { showSave: async () => ({ canceled: false, filePath: out }) } };
    return { sv, requests, out, deps };
  }

  it("builds one zip with the encrypted export, the heir's share, a read-me, the reader and the letter; the reader opens it with two shares", async () => {
    const key = generateVaultKey();
    const id = await keyId(key);
    setEncryptionConfigured(true);
    holdVaultKey(key);
    const shares = splitVaultKey(key, id, 2, 3);
    const root = tmp("bundle");
    const f = fakeServices(root);
    const res = await buildHandoverBundle(f.sv, { name: "Ari", letter: "Dear Ari,\nit is yours.", areas: ["code", "not-an-area"], share: { bytes: shares[1] as Uint8Array, x: 2 }, n: 3, k: 2, now: new Date("2026-11-03T12:00:00") }, f.deps);
    expect(res).toMatchObject({ ok: true, path: f.out, entries: 3 });
    expect(f.requests[0]?.args).toMatchObject({ areas: ["code"], includeClosed: true, openSpaces: [] });
    // the temporary export is gone
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("cortex-handover-")).length).toBe(0);

    // read the bundle with the reader's own zip code
    const r = loadReader();
    const bundle = readFileSync(f.out);
    const members = r.listZip(bundle) ?? [];
    expect(members.map((m) => m.name).sort()).toEqual(["README.txt", "letter.txt", "reader.html", "record.cortexenc", "share-2.html"]);
    const read = async (name: string): Promise<Uint8Array> => (await r.readEntry(bundle, members.find((m) => m.name === name) as never)) as Uint8Array;
    const readme = Buffer.from(await read("README.txt")).toString("utf8");
    expect(readme).toContain("Ari");
    expect(readme).toContain("share-2.html");
    expect(Buffer.from(await read("letter.txt")).toString("utf8")).toContain("it is yours.");
    const sheet = Buffer.from(await read("share-2.html")).toString("utf8");
    expect(sheet).toContain(shareChecksum(shares[1] as Uint8Array));
    expect(sheet).toContain(`<li>${shareToWords(shares[1] as Uint8Array)[0]}</li>`);
    expect(Buffer.from(await read("reader.html")).toString("utf8")).toBe(buildReaderHtml());
    // the bundle never carries the key or the other shares
    const whole = bundle.toString("latin1");
    expect(whole).not.toContain(Buffer.from(key).toString("latin1"));
    // the heir's share and the local share together open the export
    const enc = await read("record.cortexenc");
    const own = await r.parseShare(shareToWords(shares[1] as Uint8Array).join(" "));
    const local = await r.parseShare(shareToWords(shares[0] as Uint8Array).join(" "));
    if (!own.ok || !local.ok) throw new Error("share did not parse");
    const opened = await r.openExport(enc, [own.share, local.share]);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const inner = r.listZip(opened.zip) ?? [];
    expect(inner.map((m) => m.name).sort()).toEqual(["README.txt", "entries/a.md"]);
    expect(Buffer.from((await r.readEntry(opened.zip, inner.find((m) => m.name === "entries/a.md") as never)) as Uint8Array).toString("utf8")).toContain("the text of A");
    // one share alone is not enough
    expect(await r.openExport(enc, [own.share])).toMatchObject({ ok: false, why: "few" });
  });

  it("without a share the read-me says it is handed over separately; nothing is built when the record is locked, the sample shows, or nothing matches", async () => {
    const key = generateVaultKey();
    setEncryptionConfigured(true);
    const root = tmp("bundle2");
    const f = fakeServices(root);
    const input = { name: "Ari", letter: "", areas: [], share: null, n: 3, k: 2 };
    expect(await buildHandoverBundle(f.sv, input, f.deps)).toEqual({ ok: false, reason: "closed" });
    holdVaultKey(key);
    expect(await buildHandoverBundle({ ...f.sv, sandbox: { value: true } } as never, input, f.deps)).toEqual({ ok: false, reason: "sample" });
    expect(await buildHandoverBundle(fakeServices(root, 0).sv, input, f.deps)).toEqual({ ok: false, reason: "empty" });
    expect(existsSync(f.out)).toBe(false);
    expect(await buildHandoverBundle(f.sv, input, { dialog: { showSave: async () => ({ canceled: true }) } })).toEqual({ ok: false, reason: "cancelled" });
    const ok = await buildHandoverBundle(f.sv, input, f.deps);
    expect(ok.ok).toBe(true);
    const r = loadReader();
    const bundle = readFileSync(f.out);
    const names = (r.listZip(bundle) ?? []).map((m) => m.name).sort();
    expect(names).toEqual(["README.txt", "reader.html", "record.cortexenc"]);
    const readme = Buffer.from((await r.readEntry(bundle, (r.listZip(bundle) ?? []).find((m) => m.name === "README.txt") as never)) as Uint8Array).toString("utf8");
    expect(readme).toContain(COPY.handover.readmeNoShare);
    writeFileSync(path.join(root, "unused"), "");
  });
});

describe("the reader page's own wiring", () => {
  /** A just-enough DOM: elements with text, children and listeners, and the lookups the page uses. */
  function page(strings = readerStrings()) {
    class El {
      textContent = "";
      className = "";
      value = "";
      hidden = false;
      files: { arrayBuffer(): Promise<ArrayBuffer> }[] | null = null;
      type = "";
      rows = 0;
      spellcheck = true;
      autocomplete = "";
      href = "";
      download = "";
      children: El[] = [];
      listeners: Record<string, (ev: unknown) => unknown> = {};
      constructor(readonly tag: string) {}
      addEventListener(n: string, fn: (ev: unknown) => unknown) {
        this.listeners[n] = fn;
      }
      appendChild(c: El) {
        this.children.push(c);
        return c;
      }
      remove() {}
      click() {
        return this.listeners.click?.({});
      }
    }
    const ids = {} as Record<"status" | "files" | "view" | "save" | "boxes" | "add" | "pick" | "open" | "cortex-strings", El>;
    for (const id of ["status", "files", "view", "save", "boxes", "add", "pick", "open"] as const) ids[id] = new El(id === "boxes" || id === "files" ? "div" : "button");
    ids.save.hidden = true;
    ids["cortex-strings"] = Object.assign(new El("script"), { textContent: JSON.stringify(strings) });
    const doc = {
      getElementById: (id: string) => (ids as Record<string, El | undefined>)[id],
      createElement: (tag: string) => new El(tag),
      querySelectorAll: () => ids.boxes.children,
      body: new El("body"),
    };
    return { doc, ids, El };
  }
  function run(doc: unknown): void {
    // the page's handlers keep using the global `document` after the script returns, so it stays until the test ends
    (globalThis as Record<string, unknown>).document = doc;
    new Function(`${readerScript()}
return 0;`)();
  }
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).document;
  });

  it("opens a real export from a chosen file and pasted shares, lists the files, shows one and offers the unlocked zip", async () => {
    const key = generateVaultKey();
    const shares = splitVaultKey(key, await keyId(key), 2, 3);
    const zip = await sampleZip();
    const enc = encryptExportBytes(zip.bytes, key);
    const { doc, ids } = page();
    run(doc);
    expect(ids.boxes.children.length).toBe(3);
    ids.add.click();
    expect(ids.boxes.children.length).toBe(4);
    // nothing chosen yet
    await ids.open.click();
    expect(ids.status.textContent).toBe(COPY.handover.readerNoFile);
    expect(ids.status.className).toBe("bad");
    await ids.pick.listeners.change?.({ target: { files: [{ arrayBuffer: async () => enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) }] } });
    // one share is not enough, a typo names the share
    (ids.boxes.children[0] as { value: string }).value = shareToWords(shares[0] as Uint8Array).join(" ");
    await ids.open.click();
    expect(ids.status.textContent).toBe(COPY.handover.readerFew.replace("{need}", "2").replace("{have}", "1"));
    (ids.boxes.children[1] as { value: string }).value = "able acid";
    await ids.open.click();
    expect(ids.status.textContent).toContain("Share 2 could not be read");
    (ids.boxes.children[1] as { value: string }).value = shareToQrText(shares[2] as Uint8Array);
    await ids.open.click();
    expect(ids.status.className).toBe("good");
    expect(ids.status.textContent).toBe(COPY.handover.readerOpened.replace("{n}", "3"));
    expect(ids.files.children.length).toBe(3);
    expect(ids.save.hidden).toBe(false);
    const names = ids.files.children.map((li) => (li.children[0] as { textContent: string }).textContent);
    expect(names.some((n) => n.startsWith("entries/a.md"))).toBe(true);
    const li = ids.files.children.find((x) => (x.children[0] as { textContent: string }).textContent.startsWith("README.txt"));
    await (li?.children[0] as { click(): unknown }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(ids.view.textContent).toBe("hello");
  });
});
