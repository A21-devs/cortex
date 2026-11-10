/**
 * Cortex Desktop's shell layout (the shell track): the host flag switches the app to a header-less, rail-first
 * layout (icon cluster, legend list, folded histogram dock, status lines in the rail) and the plugin keeps its own.
 */
import { render } from "preact-render-to-string";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/ui/App";
import { forceHost, isDesktopHost } from "../src/ui/host";
import { NavRail } from "../src/ui/nav/Nav";
import { LeafContext, ServicesContext, ShellContext, shellFor } from "../src/ui/context";
import { listRows } from "../src/ui/stage/KeyList";
import { miniStripLayout, stripLayout } from "../src/ui/strip/TimeStrip";
import { fakeServices } from "./helpers/fakeServices";

afterEach(() => forceHost(null));

describe("host flag", () => {
  it("is the plugin unless forced or the body carries cxd-app", () => {
    expect(isDesktopHost()).toBe(false);
    forceHost("desktop");
    expect(isDesktopHost()).toBe(true);
    forceHost("plugin");
    expect(isDesktopHost()).toBe(false);
  });
});

describe("legend list size", () => {
  it("shows up to eight rows alone, six when two sections share it, and never fewer than three", () => {
    expect(listRows(1, 982)).toBe(8);
    expect(listRows(2, 982)).toBe(6);
    expect(listRows(1, 400)).toBe(3);
    expect(listRows(2, 100)).toBe(3);
  });
});

describe("folded strip layout", () => {
  it("is all plot: no lead, no notes lane, 44 px high", () => {
    const l = miniStripLayout(132);
    expect(l.mini).toBe(true);
    expect(l.lead).toBe(false);
    expect(l.lane).toBe(0);
    expect(l.height).toBe(44);
    expect(l.plot).toMatchObject({ x: 0, w: 132 });
    expect(l.plot.y + l.plot.h).toBeLessThanOrEqual(l.height);
  });
  it("leaves the full layout alone", () => {
    expect(stripLayout(1000, 982, "XL").mini).toBeUndefined();
  });
});

function renderApp(): string {
  const h = fakeServices();
  const shell = shellFor(h.leaf);
  return render(<App services={h.services} leaf={h.leaf} shell={shell} />);
}

describe("desktop layout", () => {
  it("drops the header bar, key bar, shape bar and tool column for the cluster, legend list and strip dock", () => {
    forceHost("desktop");
    const html = renderApp();
    expect(html).toContain("is-desktop");
    expect(html).not.toContain('class="cx-header');
    expect(html).not.toContain("cx-keybar");
    expect(html).not.toContain("cx-shapebar");
    expect(html).not.toContain('class="cx-tools');
    expect(html).not.toContain('class="cx-compass');
    expect(html).toContain("cx-cluster");
    expect(html).toContain("cx-strip-dock");
  });

  it("keeps the plugin layout when the host is the plugin", () => {
    const html = renderApp();
    expect(html).not.toContain("is-desktop");
    expect(html).toContain('class="cx-header');
    expect(html).toContain("cx-keybar");
    expect(html).toContain("cx-shapebar");
    expect(html).not.toContain("cx-cluster");
    expect(html).not.toContain("cx-strip-dock");
  });

  it("gives the rail a progress underline and a status block", () => {
    const h = fakeServices();
    const rail = (): string =>
      render(
        <ServicesContext.Provider value={h.services}>
          <LeafContext.Provider value={h.leaf}>
            <ShellContext.Provider value={shellFor(h.leaf)}>
              <NavRail />
            </ShellContext.Provider>
          </LeafContext.Provider>
        </ServicesContext.Provider>,
      );
    expect(rail()).not.toContain("cx-rail-search-fill");
    forceHost("desktop");
    expect(rail()).toContain("cx-rail-search-fill");
    // The chips are the header's own components: with nothing to say they render nothing and the empty block hides itself.
    expect(rail()).toContain('class="cx-rail-status"');
  });
});
