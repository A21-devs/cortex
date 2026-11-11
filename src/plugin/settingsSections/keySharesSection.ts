/**
 * Settings > Lock > Split keys, Who holds which share, Test a share, Recover from shares. The steps are in
 * plugin/keyShares.ts (the maths in shared/crypto/shamir.ts); the designation of a holder is recorded as a sealed dated
 * entry (plugin/handoverFlow.ts). This file draws and asks. The words of a share are shown only for the shares made by the
 * latest split and only while they are held in memory (plugin/shareSession.ts); no share is ever written to the settings.
 */
import { encryptionConfigured, recordKeyState } from "../../shared/crypto/keyring";
import { shareChecksum, shareToWords } from "../../shared/crypto/shamir";
import { createLocalShareStore } from "../../node/shareStore";
import type { CortexSettings } from "../../shared/settings";
import { SETTINGS_COPY } from "../../ui/copy";
import { holderEntry } from "../handoverRecord";
import { recordSealed, saveSheet, today } from "../handoverFlow";
import { shareQrSvg } from "../handoverSheet";
import { recoverFromShares, splitRecordKey, testShares, type ShareTest } from "../keyShares";
import { endShareSession, onShareSession, shareSession, startShareSession } from "../shareSession";
import type { CortexServices } from "../services";
import type { SectionHost, SectionRow } from "./index";

const c = SETTINGS_COPY.lock.shares;
const fill = (s: string, v: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? `{${k}}`));

interface Disk {
  local: Uint8Array | null;
  keyId: string | null;
  sandbox: boolean;
}

let cache: Disk | null = null;
let busy = false;
let choice: { k: number; n: number } | null = null;
let splitPass = "";
let testText = "";
let testNote = "";
let recoverTexts = "";
let recoverPass = "";
let recoverNote = "";
const drafts = new Map<number, { name: string; contact: string; instr: string }>();
const shown = new Set<number>();
let wired: (() => void) | null = null;
let hostNow: SectionHost | null = null;

async function load(host: SectionHost): Promise<void> {
  try {
    const sv = await host.services();
    const env = sv.recordKeys ? await sv.recordKeys.readEnvelope() : ({ state: "none" } as const);
    const next: Disk = { local: await createLocalShareStore(sv.cacheDir).read(), keyId: env.state === "ok" ? env.envelope.keyId : null, sandbox: sv.sandbox.value };
    const same = cache !== null && cache.sandbox === next.sandbox && cache.keyId === next.keyId && (cache.local === null) === (next.local === null) && (!cache.local || !next.local || shareChecksum(cache.local) === shareChecksum(next.local));
    cache = next;
    if (!same) host.refresh();
  } catch {
    // the page works without the disk status
  }
}

function addPassword(row: ReturnType<SectionHost["row"]>, hint: string, onChange: (v: string) => void): void {
  row.addText((tx) => {
    tx.inputEl?.setAttribute?.("type", "password");
    tx.inputEl?.setAttribute?.("autocomplete", "off");
    tx.setPlaceholder(hint).onChange(onChange);
  });
}

function addArea(row: ReturnType<SectionHost["row"]>, hint: string, value: string, onChange: (v: string) => void): void {
  row.addTextArea((ta) => {
    ta.setPlaceholder(hint).setValue(value).onChange(onChange);
    if (ta.inputEl) ta.inputEl.rows = 3;
  });
}

function whyText(why: string, at: number | undefined): string {
  if (why === "length") return c.whyLength;
  if (why === "word") return fill(c.whyWord, { n: at ?? 0 });
  if (why === "check") return c.whyCheck;
  if (why === "text") return c.whyText;
  return c.whyVersion;
}

function describeTest(r: ShareTest): string {
  if (!r.ok) {
    if (r.reason === "unreadable") return fill(c.testUnreadable, { n: r.index + 1, why: whyText(r.why, r.at) });
    if (r.reason === "other-record") return c.testOther;
    if (r.reason === "mixed") return c.testMixed;
    if (r.reason === "wrong") return c.testWrong;
    return c.testNone;
  }
  return r.proven ? fill(c.testProven, { have: r.have, points: r.points.join(", ") }) : fill(c.testPartial, { need: r.need, have: r.have });
}

/** Split the pasted block into one text per share: a CXS1 line each, or 32 words each. */
export function splitPasted(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.some((l) => /^cxs1:/i.test(l))) return lines;
  const words = text.toLowerCase().replace(/\b\d+[.):]/g, " ").split(/[^a-z]+/).filter((w) => w.length > 0);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 32) out.push(words.slice(i, i + 32).join(" "));
  return out;
}

function svgNode(svg: string): Node | null {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    return doc.documentElement && doc.documentElement.nodeName === "svg" ? document.importNode(doc.documentElement, true) : null;
  } catch {
    return null;
  }
}

function numbered(words: readonly string[]): string {
  return words.map((w, i) => `${i + 1}. ${w}`).join("  ");
}

function render(host: SectionHost, s: CortexSettings): void {
  const encrypted = s.record.encryption.enabled || encryptionConfigured();
  const state = recordKeyState();
  const sh = s.record.shares;
  host.heading(c.heading, fill(c.desc, { k: sh.splitAt ? sh.threshold : 2, n: sh.splitAt ? sh.total : 3 }));
  hostNow = host;
  wired ??= onShareSession(() => hostNow?.refresh());
  void load(host);
  if (!encrypted) {
    host.mount.createEl("p", { cls: "cx-note", text: c.needEncrypt });
    return;
  }
  if (cache?.sandbox) {
    host.mount.createEl("p", { cls: "cx-note", text: c.recoverSample });
    return;
  }
  const local = cache?.local ?? null;
  const split = sh.splitAt !== "";
  const session = shareSession();
  choice ??= { k: sh.threshold, n: sh.total };

  // Status
  host.row(c.statusName, !split ? c.statusNone : local ? fill(c.statusSplit, { k: sh.threshold, n: sh.total, date: sh.splitAt }) : c.statusLocalMissing);

  // Split
  if (state !== "open") host.mount.createEl("p", { cls: "cx-note", text: c.needOpen });
  else {
    const ch = choice;
    const needed: Record<string, string> = { "2": "2", "3": "3", "4": "4", "5": "5" };
    const total: Record<string, string> = { "3": "3", "4": "4", "5": "5", "6": "6" };
    host.row(c.needed, c.neededDesc).addDropdown((d) => d.addOptions(needed).setValue(String(ch.k)).onChange((v) => {
      ch.k = Number(v);
      if (ch.n < ch.k) ch.n = ch.k;
      host.refresh();
    }));
    host.row(c.total, c.totalDesc).addDropdown((d) => d.addOptions(total).setValue(String(Math.max(ch.n, 3))).onChange((v) => {
      ch.n = Number(v);
      if (ch.k > ch.n) ch.k = ch.n;
      host.refresh();
    }));
    const row = host.row(split ? c.splitAgain : c.split, c.splitDesc);
    addPassword(row, c.passphrase, (v) => (splitPass = v));
    row.addButton((b) =>
      b
        .setButtonText(split ? c.splitAgain : c.split)
        .setCta()
        .onClick(async () => {
          if (busy) return;
          const sv = await host.services();
          if (!sv.recordKeys) return host.notify(c.splitFailed);
          busy = true;
          try {
            const out = await splitRecordKey(sv.recordKeys, createLocalShareStore(sv.cacheDir), splitPass, Math.min(ch.k, ch.n), ch.n);
            splitPass = "";
            if (!out.ok) return host.notify(out.reason === "wrong-passphrase" ? c.wrongPassphrase : c.splitFailed);
            drafts.clear();
            shown.clear();
            startShareSession(out.set);
            await sv.settings.update((x) => {
              x.record.shares = { threshold: out.set.k, total: out.set.n, holders: [], splitAt: today() };
            });
            cache = null;
            host.notify(c.splitDone);
          } finally {
            busy = false;
            host.refresh();
          }
        }),
    );
  }

  // Shares to hand out (only the latest split, only in memory)
  if (session) {
    host.heading(c.handOut);
    for (let x = 2; x <= session.n; x++) {
      const bytes = session.shares[x - 1] as Uint8Array;
      const code = session.checksums[x - 1] as string;
      const held = sh.holders.find((h) => h.share === x);
      const d = drafts.get(x) ?? { name: held?.name ?? "", contact: held?.contact ?? "", instr: held?.instructions ?? "" };
      drafts.set(x, d);
      const row = host.row(fill(c.shareName, { x }), `${fill(c.holderRowDesc, { contact: "", code, date: "" }).trim()}`);
      row.addText((tx) => tx.setPlaceholder(c.holderNamePh).setValue(d.name).onChange((v) => (d.name = v)));
      row.addText((tx) => tx.setPlaceholder(c.holderContactPh).setValue(d.contact).onChange((v) => (d.contact = v)));
      addArea(host.row(c.holderInstr), c.holderInstrPh, d.instr, (v) => (d.instr = v));
      host.row(`${fill(c.shareName, { x })}`).addButton((b) =>
        b.setButtonText(c.nameHolder).setCta().onClick(async () => {
          if (d.name.trim() === "") return host.notify(c.needName);
          const sv = await host.services();
          const cur = sv.settings.value.record.shares;
          await sv.settings.update((st) => {
            const list = st.record.shares.holders.filter((h) => h.share !== x);
            list.push({ name: d.name.trim(), contact: d.contact.trim(), share: x, instructions: d.instr, checksum: code, namedAt: today() });
            st.record.shares.holders = list.sort((a, b2) => a.share - b2.share);
          });
          host.notify(fill(c.holderSaved, { name: d.name.trim(), x, code }));
          const env = sv.recordKeys ? await sv.recordKeys.readEnvelope() : null;
          const entry = holderEntry({ name: d.name.trim(), contact: d.contact.trim(), instructions: d.instr, share: x, total: cur.total, threshold: cur.threshold, checksum: code, keyId: env && env.state === "ok" ? env.envelope.keyId : "", date: today() });
          const rec = await recordSealed(sv, entry);
          host.notify(rec.ok ? c.sealedNote : rec.reason === "sample" ? c.sealedSample : fill(c.sealedFailed, { reason: rec.detail || "—" }));
          host.refresh();
        }),
      ).addButton((b) =>
        b.setButtonText(shown.has(x) ? c.hideWords : c.showWords).onClick(() => {
          if (shown.has(x)) shown.delete(x);
          else shown.add(x);
          host.refresh();
        }),
      ).addButton((b) =>
        b.setButtonText(c.copyWords).onClick(async () => {
          try {
            await navigator.clipboard.writeText(shareToWords(bytes).join(" "));
            host.notify(c.copied);
          } catch {
            host.notify(c.copyFailed);
          }
        }),
      ).addButton((b) =>
        b.setButtonText(c.saveSheet).onClick(async () => {
          const sv = await host.services();
          const cur = sv.settings.value.record.shares;
          try {
            const path = await saveSheet(sv, { holder: d.name.trim(), contact: d.contact.trim(), instructions: d.instr, x, n: cur.total, k: cur.threshold, checksum: code, share: bytes, date: today() });
            if (path) host.notify(fill(c.sheetSaved, { path }));
          } catch {
            host.notify(c.sheetFailed);
          }
        }),
      );
      if (shown.has(x)) {
        host.mount.createEl("div", { cls: "cx-share-words", text: numbered(shareToWords(bytes)) });
        const qr = shareQrSvg(bytes, fill(c.qrLabel, { x }));
        if (qr) {
          const box = host.mount.createEl("div", { cls: "cx-share-qr" });
          const node = svgNode(qr);
          if (node) box.appendChild(node);
        }
      }
    }
    host.row(c.handedOut).addButton((b) =>
      b.setButtonText(c.handedOut).onClick(() => {
        endShareSession();
        drafts.clear();
        shown.clear();
        host.notify(c.handedOutDone);
      }),
    );
  }

  // Who holds which share
  if (split) {
    host.heading(c.holdersHeading);
    if (local) host.row(c.localRow, fill(c.localRowDesc, { code: shareChecksum(local) }));
    if (sh.holders.length === 0) host.mount.createEl("p", { cls: "cx-note", text: c.holderNone });
    for (const h of sh.holders) {
      host.row(fill(c.holderRow, { x: h.share, name: h.name }), fill(c.holderRowDesc, { contact: h.contact, code: h.checksum || "—", date: h.namedAt ? fill(c.holderRowNamed, { date: h.namedAt }) : "" }).replace(/\s+/g, " ").trim()).addButton((b) =>
        b.setButtonText(c.removeHolder).onClick(async () => {
          const sv = await host.services();
          await sv.settings.update((st) => {
            st.record.shares.holders = st.record.shares.holders.filter((x) => x.share !== h.share);
          });
          host.refresh();
        }),
      );
    }
  }

  // Test a share
  host.heading(c.testHeading, c.testDesc);
  const trow = host.row(c.testHeading);
  addArea(trow, c.testPh, testText, (v) => (testText = v));
  trow.addButton((b) =>
    b.setButtonText(c.testButton).onClick(async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await testShares(splitPasted(testText), local, cache?.keyId ?? null);
        testNote = describeTest(r);
        host.notify(testNote);
      } finally {
        busy = false;
        host.refresh();
      }
    }),
  );
  if (testNote) host.mount.createEl("p", { cls: "cx-note", text: testNote });

  // Recover from shares
  host.heading(c.recoverHeading, c.recoverDesc);
  const rrow = host.row(c.recoverHeading);
  addArea(rrow, c.recoverPh, recoverTexts, (v) => (recoverTexts = v));
  const prow = host.row(c.newPassphrase);
  addPassword(prow, c.newPassphrase, (v) => (recoverPass = v));
  prow.addButton((b) =>
    b.setButtonText(c.recoverButton).setCta().onClick(async () => {
      if (busy) return;
      busy = true;
      try {
        const sv = await host.services();
        if (!sv.recordKeys) return host.notify(c.recoverWrite);
        const store = createLocalShareStore(sv.cacheDir);
        const r = await recoverFromShares(sv.recordKeys, splitPasted(recoverTexts), await store.read(), recoverPass, { encrypted });
        if (r.ok) {
          recoverNote = c.recoverDone;
          recoverTexts = "";
          recoverPass = "";
        } else if (r.reason === "weak") recoverNote = c.recoverWeak;
        else if (r.reason === "not-encrypted") recoverNote = c.recoverNot;
        else if (r.reason === "few" || r.reason === "none") recoverNote = fill(c.recoverFew, { need: r.need ?? 2 });
        else if (r.reason === "unreadable") recoverNote = fill(c.testUnreadable, { n: (r.index ?? 0) + 1, why: c.whyCheck });
        else if (r.reason === "mixed") recoverNote = c.testMixed;
        else if (r.reason === "other-record") recoverNote = c.testOther;
        else if (r.reason === "wrong") recoverNote = c.testWrong;
        else recoverNote = c.recoverWrite;
        host.notify(recoverNote);
      } finally {
        busy = false;
        host.refresh();
      }
    }),
  );
  if (recoverNote) host.mount.createEl("p", { cls: "cx-note", text: recoverNote });

  // Forget the split
  if (split) {
    host.row(c.forget, c.forgetDesc).addButton((b) =>
      b.setButtonText(c.forget).setWarning().onClick(async () => {
        const sv = await host.services();
        await createLocalShareStore(sv.cacheDir).remove();
        endShareSession();
        await sv.settings.update((st) => {
          st.record.shares = { threshold: st.record.shares.threshold, total: st.record.shares.total, holders: [], splitAt: "" };
        });
        cache = null;
        host.notify(c.forgotten);
        host.refresh();
      }),
    );
  }
}

/** Test hook: forget every module-level draft and cache. */
export function resetKeySharesSection(): void {
  cache = null;
  busy = false;
  choice = null;
  splitPass = "";
  testText = "";
  testNote = "";
  recoverTexts = "";
  recoverPass = "";
  recoverNote = "";
  drafts.clear();
  shown.clear();
  wired?.();
  wired = null;
  hostNow = null;
  endShareSession();
}

export const keySharesRows: readonly SectionRow[] = [{ id: "lock-key-shares", section: "lock", order: 60, render }];
