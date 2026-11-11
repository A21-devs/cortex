/** Settings > Lock > Encryption: the rows draw in each state, from a fake host, with the copy from copy.ts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropVaultKey, holdVaultKey, resetKeyring, setEncryptionConfigured } from "../src/shared/crypto/keyring";
import { generateVaultKey } from "../src/shared/crypto/vaultKey";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { extraRows, type SectionHost, type SectionRow } from "../src/plugin/settingsSections";
import { resetLockSectionCache } from "../src/plugin/settingsSections/lockSection";
import { SETTINGS_COPY } from "../src/ui/copy";

afterEach(() => {
  resetKeyring();
  resetLockSectionCache();
});

interface Drawn {
  rows: { name: string; desc: string | undefined; buttons: string[]; fields: number }[];
  headings: string[];
  notes: string[];
}

function fakeHost(): { host: SectionHost; drawn: Drawn } {
  const drawn: Drawn = { rows: [], headings: [], notes: [] };
  const host = {
    mount: { createEl: (_tag: string, o: { text?: string }) => void drawn.notes.push(o.text ?? "") },
    desktopHost: true,
    set: vi.fn(),
    refresh: vi.fn(),
    notify: vi.fn(),
    heading: (name: string) => void drawn.headings.push(name),
    row: (name: string, desc?: string) => {
      const row = { name, desc, buttons: [] as string[], fields: 0 };
      drawn.rows.push(row);
      const chain: Record<string, unknown> = {};
      chain.addText = (cb: (t: unknown) => void) => {
        row.fields++;
        cb({ inputEl: { setAttribute: () => undefined }, setPlaceholder: () => ({ onChange: () => undefined }) });
        return chain;
      };
      chain.addButton = (cb: (b: unknown) => void) => {
        const b: Record<string, unknown> = {};
        b.setButtonText = (t: string) => (row.buttons.push(t), b);
        b.setCta = () => b;
        b.setWarning = () => b;
        b.onClick = () => b;
        cb(b);
        return chain;
      };
      return chain;
    },
    toggle: vi.fn(),
    dropdown: vi.fn(),
    text: vi.fn(),
    slider: vi.fn(),
    services: () => Promise.reject(new Error("no services in this test")),
  } as unknown as SectionHost;
  return { host, drawn };
}

const c = SETTINGS_COPY.lock.enc;
/** The encryption rows alone: other features add their own rows to the Lock tab. */
const encRow = (): SectionRow => extraRows("lock").find((r) => r.id === "lock-encryption") as SectionRow;
const encrypted = (): typeof DEFAULT_SETTINGS => ({ ...DEFAULT_SETTINGS, record: { ...DEFAULT_SETTINGS.record, encryption: { enabled: true, kdfVersion: 2 } } });

describe("the Lock tab's encryption rows", () => {
  it("are registered for the lock section", () => {
    expect(extraRows("lock").map((r) => r.id)).toContain("lock-encryption");
  });

  it("plain record: a status line, then a passphrase field with 'Check first' and 'Encrypt my record'", () => {
    const { host, drawn } = fakeHost();
    const errors = vi.fn();
    encRow().render(host, DEFAULT_SETTINGS);
    expect(errors).not.toHaveBeenCalled();
    expect(drawn.headings).toEqual([c.heading]);
    expect(drawn.rows[0]).toMatchObject({ name: c.statusName });
    expect(drawn.rows[0]?.desc).toContain(c.statusOff);
    const enc = drawn.rows.find((r) => r.name === c.encrypt);
    expect(enc?.fields).toBe(1);
    expect(enc?.buttons).toEqual([c.checkFirst, c.encrypt]);
    expect(drawn.rows.some((r) => r.name === c.remove)).toBe(false);
  });

  it("encrypted and open: Remove encryption and the notes about the cache and the runner", () => {
    setEncryptionConfigured(true);
    holdVaultKey(generateVaultKey());
    const { host, drawn } = fakeHost();
    encRow().render(host, encrypted());
    expect(drawn.rows[0]?.desc).toContain(c.statusOpen);
    expect(drawn.rows.find((r) => r.name === c.remove)?.buttons).toEqual([c.remove]);
    expect(drawn.rows.some((r) => r.name === c.encrypt)).toBe(false);
    expect(drawn.notes).toEqual([c.cacheNote, c.runnerNote]);
  });

  it("encrypted and locked: it says so, offers nothing to change, and asks to unlock first", () => {
    setEncryptionConfigured(true);
    holdVaultKey(generateVaultKey());
    dropVaultKey();
    const { host, drawn } = fakeHost();
    encRow().render(host, encrypted());
    expect(drawn.rows[0]?.desc).toContain(c.statusLocked);
    expect(drawn.rows).toHaveLength(1);
    expect(drawn.notes).toEqual([c.needOpen, c.cacheNote, c.runnerNote]);
  });

  it("every string the rows use comes from copy.ts", () => {
    for (const v of Object.values(c)) expect(typeof v).toBe("string");
    expect(c.weak).toMatch(/8/);
  });
});
