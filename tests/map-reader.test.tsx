/**
 * pkg-08 map reader (H-01): statements wrap inside the panel (checked at 400 px), the plain-words caption and the
 * "Show what this came from" link sit under the kind line, the first quotes of each statement are open with You or
 * Assistant, and Flag / Pin / Focus in the brain are named text actions beside the narrow-width icon row.
 */
import { readFileSync } from "node:fs";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import type { NoteDetail } from "../src/plugin/services";
import type { NoteRecord } from "../src/shared/types";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { MapView, OPEN_QUOTES } from "../src/ui/reader/MapReader";
import { QuoteRow } from "../src/ui/reader/marks";
import { fakeServices } from "./helpers/fakeServices";

const css = readFileSync(new URL("../src/styles/reader-map.css", import.meta.url), "utf8");
/** The declarations of the first rule whose selector list mentions `sel`. */
function ruleBody(sel: string): string {
  const re = new RegExp(`(^|\\n)[^{}@]*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{}]*\\{([^}]*)\\}`);
  return re.exec(css)?.[2] ?? "";
}

const LONG = "The main thread is the garden plan, a long-running project with a very-long-unbroken-token-" + "x".repeat(80);
const cite = (n: number, speaker: "you" | "assistant") => ({ entryId: `e_${String(n).padStart(16, "0")}`, version: 1, quote: `quote number ${n}`, speaker, date: "2026-09-08" });

function detail(over?: Partial<NoteRecord["hub"]> & { hubType?: "project" | "area" | "topic" }): NoteDetail {
  const record = {
    v: 1,
    id: "n_000000000000hub1",
    seq: 1,
    kind: "hub",
    title: "Garden planner",
    text: "",
    file: "wiki/derived/hub.md",
    sources: [],
    madeBy: { runId: "r_1", model: "claude-sonnet-5-5", engine: "api", at: "2026-09-14T10:00:00Z" },
    space: "code",
    folder: [],
    state: "current",
    hub: {
      hubType: "project",
      status: "paused",
      range: ["2020-06-09T12:00:00Z", "2026-09-14T12:00:00Z"],
      members: [],
      brief: [{ text: LONG, cites: [cite(1, "you"), cite(2, "assistant"), cite(3, "assistant")] }],
      ...over,
    },
  } as unknown as NoteRecord;
  return { record, cites: [], comments: [], members: [], activity: [1, 2, 3] };
}

function draw(d: NoteDetail): string {
  const h = fakeServices();
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>
        <div style={{ width: "400px" }}>
          <MapView id="n_000000000000hub1" ordinal={-1} detail={d} reload={() => undefined} />
        </div>
      </LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

describe("H-01: statements wrap inside a 400 px panel", () => {
  it("the statement button and its text column wrap, break long tokens and may shrink", () => {
    const head = ruleBody(".cx-brief-head");
    expect(head).toContain("white-space: normal");
    expect(head).toContain("min-width: 0");
    const text = ruleBody(".cx-brief-text");
    expect(text).toContain("white-space: normal");
    expect(text).toContain("overflow-wrap: anywhere");
    expect(text).toContain("min-width: 0");
    expect(ruleBody(".cx-brief-body")).toContain("min-width: 0");
  });

  it("is imported after desktop-shell.css and keeps the meter at the left of the text", () => {
    const entry = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(entry.indexOf("reader-map.css")).toBeGreaterThan(entry.indexOf("desktop-shell.css"));
    const html = draw(detail());
    expect(html.indexOf("cx-evidence")).toBeLessThan(html.indexOf("cx-brief-body"));
    expect(html).toContain(LONG);
  });
});

describe("H-01: caption, kind line, source link and parent", () => {
  it("prints the plain-words caption and a link that runs the trace under the kind line", () => {
    const html = draw(detail());
    expect(html).toContain("A map is the agents' own work, written about your record rather than by you. Each statement lists the passages of your record behind it.");
    expect(t("reader.mapCaption")).toContain("agents' own work");
    expect(html).toContain(t("reader.showSource"));
    expect(html.indexOf("cx-kind-line")).toBeLessThan(html.indexOf("cx-map-caption"));
    expect(html.indexOf("cx-map-caption")).toBeLessThan(html.indexOf("cx-map-source-link"));
  });

  it("names the kind, the status and the first and last dates in the kind line", () => {
    const html = draw(detail());
    const line = html.slice(html.indexOf("cx-kind-line"), html.indexOf("cx-map-caption"));
    expect(line).toContain("Project map");
    expect(line).toContain(">paused<");
    expect(line).toMatch(/9 Jun 2020 to 14 Sep 2026|9 June 2020 to 14 September 2026|2020.*to.*2026/);
  });

  it("leaves the range out when a date is unreadable", () => {
    expect(draw(detail({ range: ["", ""] }))).not.toContain("cx-map-range");
  });

  it("shows the area as 'Within {area}'", () => {
    const html = draw(detail());
    expect(html).toContain("cx-map-within");
    expect(html).toMatch(/Within [^<]*Code/);
  });
});

describe("H-01: the first quotes are open", () => {
  it("opens the first quotes with You or Assistant and a date, and offers the rest", () => {
    const html = draw(detail());
    expect(OPEN_QUOTES).toBe(2);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("quote number 1");
    expect(html).toContain("quote number 2");
    expect(html).not.toContain("quote number 3");
    expect(html).toContain("+1 more");
    expect(html).toMatch(/cx-quote-who">You</);
    expect(html).toMatch(/cx-quote-who">Assistant</);
  });

  it("QuoteRow only names the speaker when asked", () => {
    expect(render(<QuoteRow speaker="you" quote="a" />)).not.toContain("cx-quote-who");
    expect(render(<QuoteRow named speaker="you" quote="a" />)).toContain("cx-quote-who");
  });
});

describe("H-01: named text actions beside the icon row", () => {
  it("has Flag at the title, Pin and Focus-in-the-brain text actions, and keeps the icon row", () => {
    const html = draw(detail());
    expect(html).toContain("cx-map-flag");
    expect(html).toContain("cx-map-text-actions");
    expect(html).toContain("cx-map-icons");
    expect(t("reader.focusInBrain")).toBe("Focus in the brain");
    expect(html.indexOf("cx-map-flag")).toBeLessThan(html.indexOf("cx-map-icons"));
  });

  it("swaps between them with a container width, so the icon row stays at narrow widths", () => {
    expect(ruleBody(".cx-map-icons")).toContain("display: contents");
    expect(css).toMatch(/@container \(min-width: \d+px\)[\s\S]*\.cx-map-icons \{ display: none; \}/);
    expect(ruleBody(".cx-map-reader")).toContain("container-type: inline-size");
  });
});
