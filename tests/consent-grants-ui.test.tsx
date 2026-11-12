/**
 * consent-grants on the screen: the Access log section, the reader's "read 3 of 3" chip, the key's open/closed badge, the
 * Privacy rows being registered, and the runner's counts behind them.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { summariseReads } from "../src/agents/grants";
import { extraRows } from "../src/plugin/settingsSections";
import { setAreaOpen } from "../src/plugin/settingsSections/privacySection";
import { migrateSettingsChecked } from "../src/shared/settings";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { COPY } from "../src/ui/copy";
import { SHEET_PAGES } from "../src/ui/pages";
import { readsText, SAMPLE_GRANTS, SAMPLE_READS } from "../src/ui/pages/agents/ConsentLog";
import { ReadLimitChip } from "../src/ui/reader/ReadLimitChip";
import { OpenBadge, openState, ReadLimitFilter } from "../src/ui/stage/KeyConsent";
import { fakeServices } from "./helpers/fakeServices";

function wrap(h: ReturnType<typeof fakeServices>, node: preact.ComponentChild): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

describe("Settings > Privacy rows", () => {
  it("registers grants, open spaces and the read limit after the section's own rows", () => {
    expect(extraRows("privacy").map((r) => r.id)).toEqual(["privacy-grants", "privacy-open", "privacy-limit"]);
  });
});

describe("Agents > Access log", () => {
  it("has the Grants and reads section, with its note about the record", () => {
    const html = wrap(fakeServices(), <SHEET_PAGES.agents params={{ tab: "access" }} />);
    expect(html).toContain(COPY.consent.logHeading);
    expect(html).toContain(COPY.consent.logChangeNote);
  });

  it("writes reads in plain words and has a sample that shows an item at its limit", () => {
    expect(readsText(41, 200)).toBe("read 41 of 200");
    expect(readsText(41, 0)).toBe("read 41");
    expect(SAMPLE_READS.atLimit.length).toBeGreaterThan(0);
    expect(SAMPLE_GRANTS.map((g) => g.revoked)).toContain(true);
  });
});

describe("the reader's read chip", () => {
  const on = (max = 3) => fakeServices((s) => void (s.consent.itemReadLimit = { enabled: true, max }));
  const at = ["2026-05-01T10:00:00.000Z", "2026-05-02T10:00:00.000Z", "2026-05-03T10:00:00.000Z"];

  it("says read 3 of 3 at the limit", () => {
    const html = wrap(on(), <ReadLimitChip id="e_aaaaaaaaaaaaaaaa" reads={at} />);
    expect(html).toContain("read 3 of 3");
    expect(html).toContain('data-at-limit="true"');
  });

  it("is quiet below the limit's end of the scale, with the limit off, and when never read", () => {
    expect(wrap(on(5), <ReadLimitChip id="e_aaaaaaaaaaaaaaaa" reads={at} />)).toContain('data-at-limit="false"');
    expect(wrap(fakeServices(), <ReadLimitChip id="e_aaaaaaaaaaaaaaaa" reads={at} />)).toBe("");
    expect(wrap(on(), <ReadLimitChip id="e_aaaaaaaaaaaaaaaa" reads={[]} />)).toBe("");
  });

  it("counts only reads after that item's reset", () => {
    const h = fakeServices((s) => {
      s.consent.itemReadLimit = { enabled: true, max: 3 };
      s.consent.readResets = { e_aaaaaaaaaaaaaaaa: "2026-05-02T12:00:00.000Z" };
    });
    expect(wrap(h, <ReadLimitChip id="e_aaaaaaaaaaaaaaaa" reads={at} />)).toContain("read 1 of 3");
    expect(wrap(h, <ReadLimitChip id="e_aaaaaaaaaaaaaaaa" reads={at.slice(0, 2)} />)).toBe("");
  });
});

describe("the key", () => {
  it("shows open or closed on the Area and Folder path groupings only", () => {
    const s = migrateSettingsChecked(undefined).settings;
    setAreaOpen(s, "code", true);
    s.consent.openSpaces.push("kb/money");
    expect(openState("space", "code", s)).toBe("open");
    expect(openState("space", "money", s)).toBe("closed");
    expect(openState("folderPath", "kb/money/bank", s)).toBe("open");
    expect(openState("folderPath", "kb/other", s)).toBe("closed");
    expect(openState("source", "claude-code", s)).toBeNull();
  });

  it("draws the badge, and the read-limit filter only while the limit is on", () => {
    const closed = wrap(fakeServices(), <OpenBadge dim="space" rowKey="code" />);
    expect(closed).toContain("is-closed");
    expect(closed).toContain(COPY.consent.badgeClosed);
    expect(wrap(fakeServices((s) => setAreaOpen(s, "code", true)), <OpenBadge dim="space" rowKey="code" />)).toContain("is-open");
    expect(wrap(fakeServices(), <OpenBadge dim="source" rowKey="x" />)).toBe("");
    // The always-visible legend marks only the exception: an open row.
    expect(wrap(fakeServices(), <OpenBadge dim="space" rowKey="code" quiet />)).toBe("");
    expect(wrap(fakeServices((s) => setAreaOpen(s, "code", true)), <OpenBadge dim="space" rowKey="code" quiet />)).toContain("is-open");
    expect(wrap(fakeServices(), <ReadLimitFilter />)).toBe("");
    expect(wrap(fakeServices((s) => void (s.consent.itemReadLimit.enabled = true)), <ReadLimitFilter />)).toContain(COPY.consent.keyFilter);
  });
});

describe("the counts behind them", () => {
  it("counts per item and per grant, lists the most-read with a title, and the items at the limit", async () => {
    const reads = [
      { entryIds: ["e_a", "e_b"], noteIds: [], grants: ["g-1"], at: "2026-05-01T10:00:00.000Z" },
      { entryIds: ["e_a"], noteIds: [], grants: ["g-1"], at: "2026-05-02T10:00:00.000Z" },
      { entryIds: ["e_a"], noteIds: [], at: "2026-05-03T10:00:00.000Z" },
    ];
    async function* log(): AsyncIterable<unknown> {
      yield* reads;
    }
    const s = migrateSettingsChecked(undefined).settings;
    s.consent.itemReadLimit = { enabled: true, max: 3 };
    const out = await summariseReads(log(), s.consent, async (ids) => new Map([...ids].map((id) => [id, `title of ${id}`])));
    expect(out.limit).toBe(3);
    expect(out.grants).toEqual({ "g-1": 3 });
    expect(out.items[0]).toEqual({ id: "e_a", n: 3, label: "title of e_a" });
    expect(out.atLimit).toEqual(["e_a"]);
    s.consent.readResets = { e_a: "2026-05-02T12:00:00.000Z" };
    const after = await summariseReads(log(), s.consent, async () => new Map());
    expect(after.atLimit).toEqual([]);
    expect(after.items.find((i) => i.id === "e_a")?.n).toBe(1);
    s.consent.itemReadLimit.enabled = false;
    expect((await summariseReads(log(), s.consent, async () => new Map())).limit).toBeNull();
  });
});
