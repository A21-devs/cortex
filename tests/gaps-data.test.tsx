/**
 * GAPS-DATA: system states that were read but never raised (CORTEX-UX 5.31: index failed, background worker
 * unavailable) and the date evidence that was read but never produced (5.14 Date evidence, 5.27 Date seals).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { render } from "preact-render-to-string";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Setting } from "obsidian";
import { CortexSettingTab } from "../src/plugin/settingsTab";
import { nullLogger } from "../src/shared/log";
import { migrateSettingsChecked } from "../src/shared/settings";
import { createSourcesService } from "../src/plugin/sourcesService";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { SHEET_PAGES } from "../src/ui/pages";
import { attentionText } from "../src/ui/pages/Sources";
import { emptyDeviceState } from "../src/ui/deviceState";
import { bannerText, pickBanner, type BannerInputs } from "../src/ui/stage/Banner";
import { fakeServices } from "./helpers/fakeServices";

let confirmAnswer = false;
vi.mock("../src/ui/modals/ConfirmModal", () => ({ confirm: async () => confirmAnswer }));

const shared = fakeServices();

const tmp: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "cx-gaps-"));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

function sourcesWith(health: () => { indexFailure?: "last-good" | "none"; runner?: string }) {
  const settings = migrateSettingsChecked(undefined).settings;
  settings.sources.claudeCode.enabled = false;
  return createSourcesService({
    app: { vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null } } as never,
    vaultRoot: dir(),
    cacheDir: dir(),
    log: nullLogger,
    settings: { value: settings, signal: undefined as never, corrupt: false, issues: [], update: async (fn: (s: typeof settings) => void) => fn(settings), reload: async () => undefined, useDefaults: async () => undefined },
    runner: { request: (async () => ({})) as never },
    corrections: { exclude: (async () => undefined) as never },
    health,
  });
}

describe("system states: index failed and background worker unavailable", () => {
  it("Needs attention lists index-failed (with Rebuild index) and runner-unavailable (with Export diagnostics)", async () => {
    const healthy = sourcesWith(() => ({ runner: "child" }));
    expect(await healthy.needsAttention()).toEqual([]);
    const both = sourcesWith(() => ({ indexFailure: "last-good", runner: "unavailable" }));
    expect(await both.needsAttention()).toEqual([
      { code: "index-failed", count: 1, action: "rebuild-index" },
      { code: "runner-unavailable", count: 1, action: "export-diagnostics" },
    ]);
    const none = await sourcesWith(() => ({ indexFailure: "none" })).needsAttention();
    expect(none).toEqual([{ code: "index-failed", count: 1, detail: "none", action: "rebuild-index" }]);
  });

  it("uses the two index sentences from the spec and never raw error text", () => {
    expect(attentionText({ code: "index-failed", count: 1 })).toBe("Cortex couldn't build its index. The last good one is shown.");
    expect(attentionText({ code: "index-failed", count: 1, detail: "none" })).toBe("Cortex couldn't build its index. Nothing is lost; rebuild it from Settings › Advanced.");
    expect(attentionText({ code: "runner-unavailable", count: 1 })).toContain("background");
  });

  const base = (data: BannerInputs["data"]): BannerInputs => ({
    sandbox: false,
    sampleSeen: false,
    feed: { status: "ready" } as never,
    data,
    ui: { hiddenGroups: [], period: null, scope: "all" } as never,
    legend: null,
    strip: null,
    counts: null,
    device: emptyDeviceState(),
    firstRunDone: true,
  });

  it("the stage line says so, and the no-earlier-index variant is its own sentence", () => {
    expect(pickBanner(base({ phase: "ready", notes: 3, record: 3 }))).not.toBe("index-failed");
    const last = pickBanner(base({ phase: "ready", notes: 3, record: 3, failure: "last-good" }));
    expect(last).toBe("index-failed");
    expect(bannerText("index-failed")).toBe("Cortex couldn't build its index. The last good one is shown.");
    expect(pickBanner(base({ phase: "empty", notes: 0, record: 0, failure: "none" }))).toBe("index-failed-none");
    expect(bannerText("index-failed-none")).toContain("Nothing is lost");
  });

  it("Agents and Sources show the worker banner with Export diagnostics only once the runner is unavailable", () => {
    const h = shared;
    const wrap = (node: preact.ComponentChild) =>
      render(
        <ServicesContext.Provider value={h.services}>
          <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
        </ServicesContext.Provider>,
      );
    h.services.shared.update("activity", { runner: "child" });
    expect(wrap(<SHEET_PAGES.agents params={{}} />)).not.toContain("background worker stopped");
    h.services.shared.update("activity", { runner: "unavailable" });
    for (const Page of [SHEET_PAGES.agents, SHEET_PAGES.sources]) {
      const html = wrap(<Page params={{}} />);
      expect(html).toContain("Cortex's background worker stopped three times and is off until Obsidian restarts. Your record is safe.");
      expect(html).toContain("Export diagnostics");
    }
  });
});

describe("Settings > Advanced > Date seals", () => {
  type Row = { name: string; toggles: { onChangeCb: ((v: boolean) => Promise<void>) | null }[]; buttons: { text: string; onClickCb: (() => Promise<void>) | null }[] };
  const rows = (): Row[] => (Setting as unknown as { created: Row[] }).created;
  const tick = () => new Promise((r) => setTimeout(r, 20));

  function tabWith(request: (c: { cmd: string }) => unknown) {
    const hh = shared;
    const services = { ...hh.services, runner: { request: async (c: { cmd: string }) => request(c) } };
    const tab = new CortexSettingTab(hh.services.app as never, { plugin: { manifest: { version: "0.1.0" } } as never, settings: () => hh.services.settings, services: () => Promise.resolve(services as never) });
    tab.section = "advanced";
    return { tab, hh };
  }

  it("shows the sealed-blocks line from the runner and keeps the Timestamp publicly button", async () => {
    rows().length = 0;
    const seen: string[] = [];
    const { tab } = tabWith((c) => {
      seen.push(c.cmd);
      return { blocks: 418, entries: 90000, intact: true, lastAt: "2026-11-03T14:00:00.000Z" };
    });
    tab.display();
    await tick();
    const line = rows().find((r) => r.name.includes("blocks sealed"));
    expect(line?.name).toBe("418 blocks sealed · last 3 Nov 2026");
    expect(line?.buttons.map((b) => b.text)).toEqual(["Timestamp publicly…"]);
    expect(seen).toContain("seals.status");
    // nothing is sent just by looking
    expect(seen).not.toContain("seals.publish");
  });

  it("turning the toggle on stores the setting and seals what is there; the public timestamp asks first", async () => {
    rows().length = 0;
    const seen: string[] = [];
    const { tab, hh } = tabWith((c) => {
      seen.push(c.cmd);
      return { blocks: 0, entries: 0, intact: true, total: 0, gitChecked: 0, gitFound: 0, n: 1, at: "2026-11-03T14:00:00.000Z", calendar: "x", already: false };
    });
    tab.display();
    await tick();
    const toggleRow = rows().find((r) => r.name === "Seal new entries on this computer")!;
    expect(hh.services.settings.value.advanced.dateSeals.sealLocally).toBe(true); // sealing is on by default now
    await hh.services.settings.update((x) => void (x.advanced.dateSeals.sealLocally = false));
    await toggleRow.toggles[0]!.onChangeCb!(true);
    expect(hh.services.settings.value.advanced.dateSeals.sealLocally).toBe(true);
    expect(seen).toContain("seals.run");
    // the button asks first: declined, nothing leaves this computer
    const stamp = rows().find((r) => r.buttons.some((b) => b.text === "Timestamp publicly…"))!;
    confirmAnswer = false;
    await stamp.buttons[0]!.onClickCb!();
    expect(seen).not.toContain("seals.publish");
    confirmAnswer = true;
    await stamp.buttons[0]!.onClickCb!();
    expect(seen).toContain("seals.publish");
  });
});
