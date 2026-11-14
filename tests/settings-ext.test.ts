import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, migrateSettingsChecked, type CortexSettings } from "../src/shared/settings";
import { CAPTURE_CONSENT_VERSION, EXT_KEYS, extDefaults, isAccelerator, isCaptureHost, isIsoDate, mergeExt } from "../src/shared/settingsExt";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const stored = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...(clone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>), ...patch });
const load = (raw: unknown) => migrateSettingsChecked(raw);

describe("settings extension blocks", () => {
  it("defaults are closed, local and off by design", () => {
    const d = extDefaults();
    expect(d.captureWeb.enabled).toBe(false);
    expect(d.captureWeb.consentVersion).toBe(0);
    expect(d.consent.requireGrant).toBe(false);
    expect(d.consent.openSpaces).toEqual([]);
    expect(d.consent.itemReadLimit.enabled).toBe(false);
    expect(d.record.encryption.enabled).toBe(false);
    expect(d.record.shares).toMatchObject({ threshold: 2, total: 3 });
    expect(d.captureWeb.sites).toEqual(["chatgpt.com", "claude.ai", "gemini.google.com"]);
  });

  it("gives fresh nested objects each call", () => {
    const a = extDefaults();
    a.consent.openSpaces.push("x");
    a.captureWeb.sites.length = 0;
    expect(extDefaults().consent.openSpaces).toEqual([]);
    expect(extDefaults().captureWeb.sites.length).toBe(3);
  });

  it("DEFAULT_SETTINGS carries the blocks and the version is unchanged", () => {
    for (const k of EXT_KEYS) expect(DEFAULT_SETTINGS[k]).toEqual(extDefaults()[k]);
    expect(DEFAULT_SETTINGS.version).toBe(SETTINGS_VERSION);
    expect(SETTINGS_VERSION).toBe(8);
  });

  it("v8: the agents work whenever Cortex is open; a stored 'only when idle' from before v8 follows the new default, a v8 choice is kept", () => {
    expect(DEFAULT_SETTINGS.agents.onlyWhenIdle).toBe(false);
    const agents = (on: boolean) => ({ ...(clone(DEFAULT_SETTINGS.agents) as unknown as Record<string, unknown>), onlyWhenIdle: on });
    expect(load(stored({ version: 7, agents: agents(true) })).settings.agents.onlyWhenIdle).toBe(false);
    expect(load(stored({ version: 8, agents: agents(true) })).settings.agents.onlyWhenIdle).toBe(true);
    expect(load(stored({ version: 8, agents: agents(false) })).settings.agents.onlyWhenIdle).toBe(false);
  });

  it("an old settings file without the blocks loads unchanged, with defaults filled in and no issues", () => {
    const old = clone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    for (const k of EXT_KEYS) delete old[k];
    (old.general as Record<string, unknown>).openOnStartup = true;
    (old.appearance as Record<string, unknown>).palette = "ember";
    (old.agents as Record<string, unknown>).paused = false;
    const m = load(old);
    expect(m.issues).toEqual([]);
    expect(m.corrupt).toBe(false);
    expect(m.settings.general.openOnStartup).toBe(true);
    expect(m.settings.appearance.palette).toBe("ember");
    expect(m.settings.agents.paused).toBe(false);
    for (const k of EXT_KEYS) expect(m.settings[k]).toEqual(extDefaults()[k]);
    // Everything outside the new blocks is exactly what was stored.
    const rest = { ...m.settings } as Record<string, unknown>;
    for (const k of EXT_KEYS) delete rest[k];
    expect(rest).toEqual(old);
  });

  it("empty and missing files give the defaults", () => {
    expect(load(undefined).settings).toEqual(DEFAULT_SETTINGS);
    expect(load(undefined).issues).toEqual([]);
    expect(load({}).settings).toEqual(DEFAULT_SETTINGS);
  });

  it("a stored value round-trips through migrate unchanged", () => {
    const s = clone(DEFAULT_SETTINGS) as CortexSettings;
    s.record.encryption = { enabled: true, kdfVersion: 2 };
    s.record.shares.holders = [{ name: "Sam", contact: "sam@example.test", share: 2, instructions: "Open the envelope.", checksum: "a1b2-c3d4", namedAt: "2026-11-03" }];
    s.record.heir = { name: "Ari", contact: "", spaces: ["work"], letter: "Hello.", share: 3, namedAt: "2026-11-03" };
    s.record.exportEveryBySource = { whatsapp: 14 };
    s.consent = {
      requireGrant: true,
      openSpaces: ["work", "folder:notes"],
      itemReadLimit: { enabled: true, max: 3 },
      readResets: {},
      grants: [{ id: "g1", purpose: "review", spaces: ["work"], reader: "Claude Code", start: "2026-01-02", end: "2026-02-01", reads: 3, readLimit: 10, revoked: false }],
    };
    s.launcher = { tray: false, keepRunning: true, quickWindow: true, quickShortcut: "Alt+Space", showTodayCost: false };
    s.captureWeb = { enabled: true, consentVersion: CAPTURE_CONSENT_VERSION, consentAt: "2026-03-04", sites: ["claude.ai"], port: 48123 };
    const once = load(clone(s));
    expect(once.issues).toEqual([]);
    expect(once.settings).toEqual(s);
    expect(load(clone(once.settings)).settings).toEqual(s);
  });

  describe("fail-safe", () => {
    it("wrong-typed blocks fall back to defaults and are reported", () => {
      const m = load(stored({ record: "x", consent: 5, launcher: [], captureWeb: null }));
      for (const k of EXT_KEYS) expect(m.settings[k]).toEqual(extDefaults()[k]);
      expect(m.issues.map((i) => i.path).sort()).toEqual(["captureWeb", "consent", "launcher", "record"]);
    });

    it("consent flags that are damaged take the closed value", () => {
      const m = load(stored({ consent: { requireGrant: "no", openSpaces: "all", itemReadLimit: { enabled: 0, max: "3" }, grants: {} } }));
      expect(m.settings.consent.requireGrant).toBe(true);
      expect(m.settings.consent.itemReadLimit.enabled).toBe(true);
      expect(m.settings.consent.itemReadLimit.max).toBe(3);
      expect(m.settings.consent.openSpaces).toEqual([]);
      expect(m.settings.consent.grants).toEqual([]);
    });

    it("drops grants that grant nothing sensible and keeps good ones", () => {
      const good = { id: "a", purpose: "p", spaces: ["w", "w", 4, ""], reader: "r", start: "2026-05-01", end: "2026-05-02", reads: 1.6, readLimit: -5, revoked: false };
      const m = load(
        stored({
          consent: {
            grants: [good, { ...good, id: "" }, { ...good, id: "b", start: "2026-13-01" }, { ...good, id: "c", end: "2026-04-30" }, { ...good, id: "a" }, "nope", { ...good, id: "d", revoked: "false" }],
          },
        }),
      );
      const g = m.settings.consent.grants;
      expect(g.map((x) => x.id)).toEqual(["a", "d"]);
      expect(g[0]).toMatchObject({ spaces: ["w"], reads: 2, readLimit: 0, revoked: false });
      expect(g[1]?.revoked).toBe(true);
      expect(m.issues.some((i) => i.path === "consent.grants" && i.problem === "malformed-list")).toBe(true);
      expect(m.corrupt).toBe(false);
    });

    it("never turns the capture receiver on without recorded consent", () => {
      const m = load(stored({ captureWeb: { enabled: true, consentVersion: 0 } }));
      expect(m.settings.captureWeb.enabled).toBe(false);
      expect(m.issues).toContainEqual({ path: "captureWeb.enabled", problem: "unknown-value", action: "used-safe-value" });
      expect(load(stored({ captureWeb: { enabled: true, consentVersion: 1 } })).settings.captureWeb.enabled).toBe(true);
      expect(load(stored({ captureWeb: { enabled: "yes", consentVersion: 1 } })).settings.captureWeb.enabled).toBe(false);
    });

    it("keeps only plain host names and a valid port for the capture receiver", () => {
      const m = load(stored({ captureWeb: { sites: ["ChatGPT.com", "https://evil.test/x", "localhost", "a..b.com", "claude.ai", "claude.ai", 4, " "], port: 80 } }));
      expect(m.settings.captureWeb.sites).toEqual(["chatgpt.com", "claude.ai"]);
      expect(m.settings.captureWeb.port).toBe(0);
      expect(load(stored({ captureWeb: { port: 50000 } })).settings.captureWeb.port).toBe(50000);
      expect(load(stored({ captureWeb: { port: 70000 } })).settings.captureWeb.port).toBe(0);
      expect(load(stored({ captureWeb: { sites: [] } })).settings.captureWeb.sites).toEqual([]);
    });

    it("a damaged encryption block marks the file corrupt instead of guessing", () => {
      const m = load(stored({ record: { encryption: { enabled: "true" } } }));
      expect(m.corrupt).toBe(true);
      expect(m.settings.agents.paused).toBe(true);
      expect(m.settings.agents.enabled).toBe(false);
      expect(load(stored({ record: { encryption: 7 } })).corrupt).toBe(true);
    });

    it("clamps numbers, keeps threshold within the shares and drops holders outside them", () => {
      const m = load(
        stored({
          record: {
            exportEveryDays: 1,
            exportEveryBySource: { a: 9999, b: "x", c: 20 },
            shares: { total: 4, threshold: 9, holders: [{ name: "A", share: 4 }, { name: "B", share: 5 }, { name: " ", share: 1 }, { name: "C", share: 1.5 }] },
          },
          consent: { itemReadLimit: { max: 500 } },
        }),
      );
      expect(m.settings.record.exportEveryDays).toBe(7);
      expect(m.settings.record.exportEveryBySource).toEqual({ a: 365, c: 20 });
      expect(m.settings.record.shares.total).toBe(4);
      expect(m.settings.record.shares.threshold).toBe(4);
      expect(m.settings.record.shares.holders.map((h) => h.name)).toEqual(["A"]);
      expect(m.settings.consent.itemReadLimit.max).toBe(99);
      expect(m.corrupt).toBe(false);
    });

    it("rejects a launcher shortcut that is not an accelerator", () => {
      expect(load(stored({ launcher: { quickShortcut: "rm -rf /" } })).settings.launcher.quickShortcut).toBe(extDefaults().launcher.quickShortcut);
      expect(load(stored({ launcher: { quickShortcut: "" } })).settings.launcher.quickShortcut).toBe("");
    });

    it("ignores unknown keys inside a block and never mutates its input", () => {
      const raw = stored({ launcher: { tray: false, extra: 1 } });
      const before = JSON.stringify(raw);
      const m = load(raw);
      expect(m.settings.launcher).toEqual({ ...extDefaults().launcher, tray: false });
      expect(JSON.stringify(raw)).toBe(before);
    });
  });

  it("mergeExt works on its own and reports into the list it is given", () => {
    const issues: Parameters<typeof mergeExt>[1] = [];
    expect(mergeExt({ launcher: { tray: "x" } }, issues).launcher.tray).toBe(true);
    expect(issues).toEqual([{ path: "launcher.tray", problem: "wrong-type", action: "used-default" }]);
  });

  it("validators", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-1-1")).toBe(false);
    expect(isCaptureHost("gemini.google.com")).toBe(true);
    expect(isCaptureHost("127.0.0.1")).toBe(true);
    expect(isCaptureHost("a/b.com")).toBe(false);
    expect(isAccelerator("CommandOrControl+Shift+K")).toBe(true);
    expect(isAccelerator("Ctrl+")).toBe(false);
  });
});
