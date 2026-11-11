/**
 * Settings > Lock > Split keys and Heir or custodian, driven through a fake settings host: the rows in each state, then the
 * whole path (split, name a holder, test a share, recover) on temp folders, with the copy from copy.ts. The fake services
 * stand in for the vault: no network, no model, no real record.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { dropVaultKey, holdVaultKey, recordKeyState, resetKeyring, setEncryptionConfigured } from "../src/shared/crypto/keyring";
import { shareToWords } from "../src/shared/crypto/shamir";
import { createLocalShareStore } from "../src/node/shareStore";
import { createRecordKeyAccess } from "../src/node/vaultKeyStore";
import { nullLogger } from "../src/shared/log";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import { openStoreContext } from "../src/store/layout";
import { createRecordKey } from "../src/plugin/recordKeys";
import { renderExtraRows, type SectionHost } from "../src/plugin/settingsSections";
import { resetKeySharesSection, splitPasted } from "../src/plugin/settingsSections/keySharesSection";
import { shareSession } from "../src/plugin/shareSession";
import { SETTINGS_COPY } from "../src/ui/copy";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `cx-sharesui-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  resetKeySharesSection();
  resetKeyring();
});

const c = SETTINGS_COPY.lock.shares;
const h = SETTINGS_COPY.lock.heir;
const PASS = "correct horse battery";

interface Row {
  name: string;
  desc?: string;
  buttons: { text: string; click: () => Promise<void> | void }[];
  inputs: { kind: "text" | "area" | "drop"; hint: string; change: (v: string) => void }[];
}

function fakeHost(sv: unknown) {
  const rows: Row[] = [];
  const headings: string[] = [];
  const notes: string[] = [];
  const notices: string[] = [];
  const toggles: string[] = [];
  const settingsPatches: ((s: CortexSettings) => void)[] = [];
  let refreshes = 0;
  const host = {
    mount: { createEl: (_t: string, o: { text?: string }) => (notes.push(o.text ?? ""), { appendChild: () => undefined }) },
    desktopHost: true,
    set: (p: (s: CortexSettings) => void) => void settingsPatches.push(p),
    refresh: () => void refreshes++,
    notify: (t: string) => void notices.push(t),
    heading: (n: string) => void headings.push(n),
    toggle: (n: string) => void toggles.push(n),
    dropdown: (n: string) => void rows.push({ name: n, buttons: [], inputs: [{ kind: "drop", hint: n, change: () => undefined }] }),
    text: (n: string) => void rows.push({ name: n, buttons: [], inputs: [{ kind: "text", hint: n, change: () => undefined }] }),
    slider: vi.fn(),
    services: async () => sv,
    row: (name: string, desc?: string) => {
      const row: Row = { name, desc, buttons: [], inputs: [] };
      rows.push(row);
      const chain: Record<string, unknown> = {};
      const field = (kind: Row["inputs"][number]["kind"]) => (cb: (t: unknown) => void) => {
        const input = { kind, hint: "", change: (_v: string) => undefined as void };
        const t: Record<string, unknown> = { inputEl: { setAttribute: () => undefined } };
        t.setPlaceholder = (p: string) => ((input.hint = p), t);
        t.setValue = () => t;
        t.onChange = (fn: (v: string) => void) => ((input.change = fn), t);
        cb(t);
        row.inputs.push(input);
        return chain;
      };
      chain.addText = field("text");
      chain.addDropdown = (cb: (d: unknown) => void) => {
        const input = { kind: "drop" as const, hint: "", change: (_v: string) => undefined as void };
        const d: Record<string, unknown> = {};
        d.addOptions = () => d;
        d.setValue = () => d;
        d.onChange = (fn: (v: string) => void) => ((input.change = fn), d);
        cb(d);
        row.inputs.push(input);
        return chain;
      };
      chain.addTextArea = field("area");
      chain.addButton = (cb: (b: unknown) => void) => {
        const b: Record<string, unknown> = {};
        const btn = { text: "", click: (): Promise<void> | void => undefined };
        b.setButtonText = (t: string) => ((btn.text = t), b);
        b.setCta = () => b;
        b.setWarning = () => b;
        b.onClick = (fn: () => Promise<void> | void) => ((btn.click = fn), b);
        cb(b);
        row.buttons.push(btn);
        return chain;
      };
      return chain;
    },
  } as unknown as SectionHost;
  const find = (name: string): Row => {
    const r = rows.find((x) => x.name === name);
    if (!r) throw new Error(`no row "${name}" in ${JSON.stringify(rows.map((x) => x.name))}`);
    return r;
  };
  const clear = (): void => {
    rows.length = 0;
    headings.length = 0;
    notes.length = 0;
  };
  return { host, rows, headings, notes, notices, toggles, find, clear, patches: settingsPatches, refreshes: () => refreshes };
}

const encrypted = (over: Partial<CortexSettings["record"]> = {}): CortexSettings => ({ ...DEFAULT_SETTINGS, record: { ...DEFAULT_SETTINGS.record, encryption: { enabled: true, kdfVersion: 2 }, ...over } });

async function world() {
  const vault = tmp("vault");
  const cache = tmp("cache");
  await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  const access = createRecordKeyAccess({ vaultRoot: vault, cacheDir: cache });
  const made = await createRecordKey(access, PASS);
  if (!made.ok) throw new Error("no key");
  setEncryptionConfigured(true);
  holdVaultKey(made.key);
  const settings = { value: encrypted() as CortexSettings, update: async (p: (s: CortexSettings) => void) => { const next = structuredClone(settings.value); p(next); settings.value = next; } };
  const entries: { title: string; body: string }[] = [];
  const sv = {
    cacheDir: cache,
    vaultRoot: vault,
    recordKeys: access,
    sandbox: { value: false },
    settings,
    newEntry: { save: async (d: { title: string; body: string }) => (entries.push(d), { path: "p", entryId: "e_x" }) },
    runner: { request: async () => ({ blocks: 1, entries: 1, total: 1, gitChecked: 0, gitFound: 0 }) },
    save: async () => "C:/x/sheet.html",
  };
  return { sv, settings, entries, cache, access, key: made.key, id: made.envelope.keyId };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe("the Split keys rows", () => {
  it("a plain record only says to encrypt first", async () => {
    const f = fakeHost({});
    renderExtraRows(f.host, "lock", DEFAULT_SETTINGS, (id, e) => { throw e; });
    expect(f.headings).toContain(c.heading);
    expect(f.notes).toContain(c.needEncrypt);
    expect(f.rows.some((r) => r.name === c.split)).toBe(false);
  });

  it("an encrypted, locked record offers test and recover but no split, and asks to unlock", async () => {
    const w = await world();
    dropVaultKey();
    const f = fakeHost(w.sv);
    renderExtraRows(f.host, "lock", w.settings.value, (_id, e) => { throw e; });
    expect(f.notes).toContain(c.needOpen);
    expect(f.rows.some((r) => r.name === c.split)).toBe(false);
    expect(f.headings).toEqual(expect.arrayContaining([c.testHeading, c.recoverHeading]));
    expect(f.rows.find((r) => r.name === c.statusName)?.desc).toBe(c.statusNone);
    expect(f.rows.find((r) => r.name === c.recoverHeading)?.inputs[0]?.hint).toBe(c.recoverPh);
  });

  it("splits, names a holder with a sealed entry, tests a share, forgets the split, and never writes a share into the settings", async () => {
    const w = await world();
    const f = fakeHost(w.sv);
    const draw = (): void => {
      f.clear();
      renderExtraRows(f.host, "lock", w.settings.value, (_id, e) => { throw e; });
    };
    draw();
    await settle();
    draw();
    expect(f.rows.map((r) => r.name)).toEqual(expect.arrayContaining([c.needed, c.total, c.split]));
    const splitRow = f.find(c.split);
    splitRow.inputs[0]?.change("wrong passphrase");
    await splitRow.buttons[0]?.click();
    expect(f.notices.at(-1)).toBe(c.wrongPassphrase);
    expect(shareSession()).toBeNull();
    splitRow.inputs[0]?.change(PASS);
    await splitRow.buttons[0]?.click();
    expect(f.notices.at(-1)).toBe(c.splitDone);
    const session = shareSession();
    expect(session?.n).toBe(3);
    expect(w.settings.value.record.shares).toMatchObject({ threshold: 2, total: 3, holders: [] });
    expect(w.settings.value.record.shares.splitAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // the hand-out rows for shares 2 and 3 appear
    draw();
    await settle();
    draw();
    expect(f.headings).toContain(c.handOut);
    const share2 = f.find(SETTINGS_COPY.lock.shares.shareName.replace("{x}", "2"));
    share2.inputs[0]?.change("Sam");
    share2.inputs[1]?.change("sam@example.test");
    const nameRow = f.rows.filter((r) => r.buttons.some((b) => b.text === c.nameHolder))[0] as Row;
    await nameRow.buttons.find((b) => b.text === c.nameHolder)?.click();
    const holder = w.settings.value.record.shares.holders[0];
    expect(holder).toMatchObject({ name: "Sam", contact: "sam@example.test", share: 2, checksum: session?.checksums[1] });
    expect(w.entries.length).toBe(1);
    expect(w.entries[0]?.title).toBe("Key holder named: Sam");
    expect(w.entries[0]?.body).not.toContain("sam@example.test");
    expect(f.notices).toContain(c.sealedNote);
    // no share or key ever reaches the settings
    const saved = JSON.stringify(w.settings.value);
    for (const sh of session?.shares ?? []) expect(saved).not.toContain(shareToWords(sh)[0] + " " + shareToWords(sh)[1]);
    expect(saved).not.toContain(Buffer.from(w.key).toString("base64"));

    // test a share: share 3 with the local share proves the key
    const three = shareToWords(session?.shares[2] as Uint8Array).join(" ");
    draw();
    await settle();
    draw();
    const test = f.find(c.testHeading);
    test.inputs[0]?.change(three.split(" ").map((x, i) => `${i + 1}. ${x}`).join("\n"));
    await test.buttons[0]?.click();
    expect(f.notices.at(-1)).toContain("Proven: 2 shares");
    test.inputs[0]?.change("able acid acorn");
    await test.buttons[0]?.click();
    expect(f.notices.at(-1)).toContain("could not be read");

    // handed out: the words are gone from memory
    const handed = f.rows.find((r) => r.name === c.handedOut) as Row;
    handed.buttons[0]?.click();
    expect(shareSession()).toBeNull();

    // the holders list and the local share stay
    draw();
    await settle();
    draw();
    expect(f.rows.some((r) => r.name === "Share 2: Sam")).toBe(true);
    expect(f.rows.some((r) => r.name === c.localRow)).toBe(true);
    const forget = f.find(c.forget);
    await forget.buttons[0]?.click();
    expect(w.settings.value.record.shares).toMatchObject({ splitAt: "", holders: [] });
    expect(await createLocalShareStore(w.cache).read()).toBeNull();
  });

  it("recovers from the row: one pasted share plus the local one, a new passphrase, and the record opens", async () => {
    const w = await world();
    const f = fakeHost(w.sv);
    const draw = (): void => {
      f.clear();
      renderExtraRows(f.host, "lock", w.settings.value, (_id, e) => { throw e; });
    };
    draw();
    await settle();
    draw();
    const splitRow = f.find(c.split);
    splitRow.inputs[0]?.change(PASS);
    await splitRow.buttons[0]?.click();
    const handed = shareToWords(shareSession()?.shares[1] as Uint8Array).join(" ");
    dropVaultKey();
    expect(recordKeyState()).toBe("locked");
    draw();
    await settle();
    draw();
    f.find(c.recoverHeading).inputs[0]?.change(handed);
    const pass = f.find(c.newPassphrase);
    pass.inputs[0]?.change("short");
    await pass.buttons[0]?.click();
    expect(f.notices.at(-1)).toBe(c.recoverWeak);
    pass.inputs[0]?.change("a new passphrase!");
    await pass.buttons[0]?.click();
    expect(f.notices.at(-1)).toBe(c.recoverDone);
    expect(recordKeyState()).toBe("open");
  });

  it("splitPasted separates shares by line for CXS1 text and by 32 words otherwise", () => {
    expect(splitPasted("CXS1:abc\r\n\r\nCXS1:def")).toEqual(["CXS1:abc", "CXS1:def"]);
    const a = Array.from({ length: 32 }, (_, i) => `w${String.fromCharCode(97 + (i % 26))}`).join(" ").replace(/\d/g, "");
    expect(splitPasted(`${a} ${a}`).length).toBe(2);
    expect(splitPasted("")).toEqual([]);
  });

  it("every string the rows use comes from copy.ts", () => {
    for (const v of Object.values(c)) expect(typeof v).toBe("string");
    for (const v of Object.values(h)) expect(typeof v).toBe("string");
  });
});

describe("the Heir or custodian rows", () => {
  it("draw the fields, one toggle per area and the bundle button, and ask to encrypt first on a plain record", async () => {
    const f = fakeHost({});
    renderExtraRows(f.host, "lock", DEFAULT_SETTINGS, (_id, e) => { throw e; });
    expect(f.headings).toEqual(expect.arrayContaining([h.heading, h.spaces]));
    expect(f.rows.map((r) => r.name)).toEqual(expect.arrayContaining([h.name, h.contact, h.letter, h.share, h.save, h.bundle]));
    expect(f.toggles.length).toBeGreaterThan(3);
    expect(f.notes).toContain(h.bundleNeedEncrypt);
  });

  it("saving needs a name, then records a sealed entry without the contact or the letter", async () => {
    const w = await world();
    const f = fakeHost(w.sv);
    renderExtraRows(f.host, "lock", w.settings.value, (_id, e) => { throw e; });
    await f.find(h.save).buttons[0]?.click();
    expect(f.notices.at(-1)).toBe(h.needName);
    await w.settings.update((s) => void (s.record.heir = { ...s.record.heir, name: "Ari", contact: "ari@example.test", letter: "Dear Ari, 12345", spaces: ["code"] }));
    await f.find(h.save).buttons[0]?.click();
    expect(w.settings.value.record.heir.namedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(w.entries.length).toBe(1);
    expect(w.entries[0]?.title).toBe("Heir named: Ari");
    expect(w.entries[0]?.body).not.toContain("12345");
    expect(w.entries[0]?.body).not.toContain("ari@example.test");
    expect(f.notices).toContain(h.sealedNote);
  });

  it("the bundle button explains what is missing: a name, the open record, a split", async () => {
    const w = await world();
    const f = fakeHost(w.sv);
    renderExtraRows(f.host, "lock", w.settings.value, (_id, e) => { throw e; });
    const click = async (): Promise<string | undefined> => {
      await f.find(h.bundle).buttons[0]?.click();
      return f.notices.at(-1);
    };
    expect(await click()).toBe(h.bundleNeedName);
    await w.settings.update((s) => void (s.record.heir.name = "Ari"));
    expect(await click()).toBe(h.bundleSplit);
    dropVaultKey();
    expect(await click()).toBe(h.bundleNeedOpen);
    w.sv.sandbox.value = true;
    expect(await click()).toBe(h.bundleSample);
  });
});
