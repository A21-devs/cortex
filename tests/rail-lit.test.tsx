/**
 * The rail's lit block (count, what lit it, highlighted labels, Clear), the wordmark's click target, and the rail CSS.
 */
import { readFileSync } from "node:fs";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { addToken } from "../src/state/actions";
import { DRAFT_TEXT_TOKEN_ID, litSummary } from "../src/state/selectors";
import { LeafContext, ServicesContext, ShellContext, Shell } from "../src/ui/context";
import { DRAFT_TOKEN_ID } from "../src/ui/command/Tokens";
import { t } from "../src/ui/copy";
import { clickTarget, type Scope } from "../src/ui/header/spaceCycle";
import { clearAllLit, litBlockText, StatusLines } from "../src/ui/nav/RailStatus";
import { fakeServices } from "./helpers/fakeServices";

const tok = (id: string, label: string, kind: "group" | "time" | "text" = "group") => ({ id, kind, label });

describe("litSummary", () => {
  it("is gone with nothing lit", () => {
    expect(litSummary({ tokens: [] }, 9)).toBeNull();
  });
  it("names a period and counts the lit entries", () => {
    expect(litSummary({ tokens: [tok("when:time", "October 2026", "time")] }, 71)).toEqual({ count: 71, where: "October 2026", more: 0, labels: 0, found: false });
  });
  it("names the newest of several and says how many more", () => {
    const s = litSummary({ tokens: [tok("when:time", "October 2026", "time"), tok("when:label", "avna")] }, 12);
    expect(s).toMatchObject({ where: "avna", more: 1, labels: 0 });
  });
  it("counts chart highlight labels apart and names the newest when nothing else is lit", () => {
    const s = litSummary({ tokens: [tok("chart:a", "Claude"), tok("chart:b", "Vault")] }, 40);
    expect(s).toEqual({ count: 40, where: "Vault", more: 0, labels: 2, found: false });
    const mixed = litSummary({ tokens: [tok("when:time", "May 2026", "time"), tok("chart:a", "Claude")] }, 3);
    expect(mixed).toMatchObject({ where: "May 2026", more: 0, labels: 1 });
  });
  it("reads a typed search as 'found' and names nothing", () => {
    expect(litSummary({ tokens: [tok(DRAFT_TEXT_TOKEN_ID, "q", "text")] }, 5)).toEqual({ count: 5, where: null, more: 0, labels: 0, found: true });
    expect(litSummary({ tokens: [tok("text:q", "q (3)", "text")] }, 3)?.found).toBe(true);
  });
  it("keeps the draft id in step with the command line's", () => {
    expect(DRAFT_TEXT_TOKEN_ID).toBe(DRAFT_TOKEN_ID);
  });
});

describe("litBlockText", () => {
  it("writes the count, the place and the labels", () => {
    const x = litBlockText({ count: 1234, where: "October 2026", more: 2, labels: 3, found: false });
    expect(x).toEqual({ count: "1,234", where: "in October 2026 plus 2 more", labels: "3 highlighted labels" });
    expect(litBlockText({ count: 1, where: "x", more: 0, labels: 1, found: false }).labels).toBe(t("rail.litLabelsOne"));
  });
  it("writes '<n> found' for a typed search and a dots count before the answer", () => {
    expect(litBlockText({ count: 25, where: null, more: 0, labels: 0, found: true }).count).toBe("25 found");
    expect(litBlockText({ count: null, where: "x", more: 0, labels: 0, found: false }).count).toBe("…");
  });
});

describe("clearAllLit", () => {
  it("drops every token and the typed search, keeps an Ask draft", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    addToken(store, tok("when:time", "May 2026", "time"));
    addToken(store, tok("chart:a", "Claude"));
    store.update("ui", (u) => ({ ...u, command: { ...u.command, text: "abc" } }));
    clearAllLit(store);
    expect(store.get("ui").tokens).toEqual([]);
    expect(store.get("ui").command.text).toBe("");
    store.update("ui", (u) => ({ ...u, command: { ...u.command, mode: "ask", text: "why" } }));
    clearAllLit(store);
    expect(store.get("ui").command.text).toBe("why");
  });
});

describe("the block in the status stack", () => {
  it("renders the count, place, labels and Clear whether or not the Time sheet is open", () => {
    const h = fakeServices();
    const shell = new Shell("v1");
    addToken(h.leaf.store, tok("when:time", "October 2026", "time"));
    addToken(h.leaf.store, tok("chart:a", "Claude"));
    h.leaf.store.update("lit", () => 71);
    const html = render(
      <ServicesContext.Provider value={h.services}>
        <LeafContext.Provider value={h.leaf}>
          <ShellContext.Provider value={shell}>
            <StatusLines />
          </ShellContext.Provider>
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
    expect(html).toContain('class="cx-lit-count">71<');
    expect(html).toContain("in October 2026");
    expect(html).toContain("1 highlighted label");
    expect(html).toContain(">Clear<");
    expect(html).not.toContain("is lit. Right-click it");
  });
});

describe("the wordmark's click", () => {
  const order: Scope[] = ["all", "code", "web", "none"];
  it("steps to the next area and wraps to All areas", () => {
    expect(clickTarget(order, "all", null)).toBe("code");
    expect(clickTarget(order, "web", null)).toBe("none");
    expect(clickTarget(order, "none", null)).toBe("all");
  });
  it("keeps the area a preview is showing", () => {
    expect(clickTarget(order, "all", "web")).toBe("web");
  });
});

describe("rail CSS", () => {
  const css = readFileSync("src/styles/desktop-rail.css", "utf8");
  it("underlines hovered and focused links, the chosen one only while hovered", () => {
    expect(css).toContain(".cx-root.is-desktop .cx-nav-item:hover, .cx-root.is-desktop .cx-nav-item:focus-visible { text-decoration: underline;");
    expect(css).toContain("text-underline-offset: 3px");
  });
  it("draws a short bar under the wordmark and keeps the search edge plain", () => {
    expect(css).toMatch(/\.cx-rail-bar \{ width: 2[4-8]px;/);
    expect(css).toContain(".cx-rail-search-line:not(.is-loading) .cx-rail-search-fill { display: none; }");
  });
  it("is imported from the stylesheet entry after the shell", () => {
    const entry = readFileSync("styles.css", "utf8");
    expect(entry.indexOf("desktop-rail.css")).toBeGreaterThan(entry.indexOf("desktop-shell.css"));
  });
});
