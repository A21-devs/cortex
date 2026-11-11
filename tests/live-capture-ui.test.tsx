/**
 * Live capture in Sources: the panel is absent where the host has no receiver, shows its heading where it has one, and
 * says why a receiver that is on is not listening. Every string comes from the copy catalogue.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import type { CortexServices } from "../src/plugin/services";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { COPY, t } from "../src/ui/copy";
import { ServicesContext } from "../src/ui/context";
import { CapturePanel, problemText } from "../src/ui/pages/sources/CapturePanel";

const withServices = (s: Partial<CortexServices>) => render(<ServicesContext.Provider value={s as CortexServices}><CapturePanel /></ServicesContext.Provider>);

describe("the Live capture panel", () => {
  it("is not drawn where there is no receiver", () => {
    expect(withServices({})).toBe("");
  });

  it("is drawn with its heading where there is one", () => {
    const cap = { status: () => new Promise(() => undefined) } as unknown as CortexServices["capture"];
    const html = withServices({ capture: cap, settings: { value: DEFAULT_SETTINGS } as unknown as CortexServices["settings"] });
    expect(html).toContain(t("liveCapture.title"));
    expect(html).toContain('class="cx-capture"');
  });

  it("explains a receiver that is on but not listening", () => {
    expect(problemText({ problem: "port-in-use", port: 47831 })).toBe(t("liveCapture.problemPort", { port: 47831 }));
    expect(problemText({ problem: "other-computer", port: 47831 })).toBe(COPY.liveCapture.problemOther);
    expect(problemText({ problem: "failed", port: 47831 })).toBe(COPY.liveCapture.problemFailed);
    expect(problemText({ port: 47831 })).toBeNull();
  });

  it("names exactly what is stored in the consent text, and says nothing leaves the computer", () => {
    const body = t("liveCapture.consentBody", { address: "127.0.0.1:47831" });
    for (const needle of ["127.0.0.1:47831", "token", "full text", "title", "Secrets are screened", "Nothing leaves this computer", "turning it off"]) expect(body).toContain(needle);
  });
});
