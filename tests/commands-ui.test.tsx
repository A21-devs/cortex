/** Rendered pieces of P21: the lock screen over the shell and the theme attribute (logic lives in commands.test.ts). */
import { render } from "preact-render-to-string";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassphrase } from "../src/shared/lock";
import { lockApp, unlockApp } from "../src/state/lock";
import { App } from "../src/ui/App";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { COPY } from "../src/ui/copy";
import { fakeServices } from "./helpers/fakeServices";

afterEach(() => unlockApp());

describe("lock screen and themes in the shell", () => {
  it("covers the view: the root is marked and the overlay asks for the passphrase", async () => {
    const rec = await hashPassphrase("pw-1234", 1000);
    const h = fakeServices((s) => void (s.privacy.lock = { ...s.privacy.lock, ...rec }));
    const view = () =>
      render(
        <ServicesContext.Provider value={h.services}>
          <LeafContext.Provider value={h.leaf}>
            <App services={h.services} leaf={h.leaf} />
          </LeafContext.Provider>
        </ServicesContext.Provider>,
      );
    expect(view()).not.toContain("cx-lock");
    lockApp();
    const html = view();
    expect(html).toContain("is-locked");
    expect(html).toContain('role="dialog"');
    expect(html).toContain(COPY.lock.title);
    expect(html).toContain('type="password"');
    expect(html).not.toContain("is-blank");
    const blank = fakeServices();
    const blankHtml = render(
      <ServicesContext.Provider value={blank.services}>
        <LeafContext.Provider value={blank.leaf}>
          <App services={blank.services} leaf={blank.leaf} />
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
    expect(blankHtml).toContain("is-blank");
    expect(blankHtml).not.toContain('type="password"');
  });

  it("applies the theme attribute to the shell root and the stage", () => {
    const html = (stage: "vesper" | "paper" | "follow") => {
      const h = fakeServices((s) => void (s.appearance.stage = stage));
      return render(
        <ServicesContext.Provider value={h.services}>
          <LeafContext.Provider value={h.leaf}>
            <App services={h.services} leaf={h.leaf} />
          </LeafContext.Provider>
        </ServicesContext.Provider>,
      );
    };
    const v = html("vesper");
    expect(v).toContain('data-cx-theme="vesper"');
    expect(v).toContain('data-stage="ink"');
    expect(html("paper")).not.toContain("data-cx-theme");
    expect(html("follow")).not.toContain("data-cx-theme");
  });

});
