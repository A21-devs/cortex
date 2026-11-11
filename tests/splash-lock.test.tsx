/** Cold open: the splash gate and line, and the lock card's methods, steps and keyboard flow. */
import { render } from "preact-render-to-string";
import { afterEach, describe, expect, it } from "vitest";
import { resetKeyring, setEncryptionConfigured } from "../src/shared/crypto/keyring";
import { hashPassphrase } from "../src/shared/lock";
import { lockApp, unlockApp } from "../src/state/lock";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { COPY, t } from "../src/ui/copy";
import { SPLASH_AUTO_MS, splashAutoIn, splashGate, splashLine } from "../src/ui/loading";
import { LockOverlay } from "../src/ui/stage/LockOverlay";
import { nextStep, primaryMethod, secretMethod, startStep, stepForKey, tabTarget, unlockMethods, type UnlockMethod } from "../src/ui/stage/lockCard";
import { fakeServices } from "./helpers/fakeServices";

afterEach(() => {
  unlockApp();
  resetKeyring();
});

describe("splash gate", () => {
  const base = { shownMs: 0, ready: true, held: false, opened: false };
  it("waits until the record is read, whatever else is true", () => {
    expect(splashGate({ ...base, ready: false, shownMs: 9999, opened: true })).toBe("wait");
  });
  it("continues by itself after 1.2 s when nothing is locked", () => {
    expect(SPLASH_AUTO_MS).toBe(1200);
    expect(splashGate({ ...base, shownMs: 1199 })).toBe("wait");
    expect(splashGate({ ...base, shownMs: 1200 })).toBe("go");
  });
  it("continues at once on the click", () => {
    expect(splashGate({ ...base, opened: true })).toBe("go");
  });
  it("waits for the click when a lock or privacy blank is on, however long it has been shown", () => {
    expect(splashGate({ ...base, held: true, shownMs: 60_000 })).toBe("wait");
    expect(splashGate({ ...base, held: true, shownMs: 10, opened: true })).toBe("go");
  });
  it("says when the auto-continue can fire", () => {
    expect(splashAutoIn({ shownMs: 200, held: false })).toBe(1000);
    expect(splashAutoIn({ shownMs: 5000, held: false })).toBe(0);
    expect(splashAutoIn({ shownMs: 0, held: true })).toBeNull();
  });
  it("words the progress line from copy.ts", () => {
    expect(splashLine("Brain")).toBe("Reading Brain…");
    expect(splashLine("Brain", { done: 1234, total: 20000 })).toBe("Reading Brain… 1,234 of 20,000 notes");
    expect(COPY.splash.open).toBe("Open");
  });
});

describe("unlock methods", () => {
  it("lists a passphrase when one is set, else a tap", async () => {
    const rec = await hashPassphrase("pw-1234", 1000);
    expect(unlockMethods(rec).map((m) => m.id)).toEqual(["passphrase"]);
    expect(unlockMethods({ salt: "", hash: "" }).map((m) => m.id)).toEqual(["blank"]);
  });
  it("opens a passphrase-only lock on the field and a tap lock on its Unlock button", async () => {
    const rec = await hashPassphrase("pw-1234", 1000);
    expect(startStep(unlockMethods(rec))).toBe("secret");
    expect(startStep(unlockMethods({ salt: "", hash: "" }))).toBe("choose");
  });
  it("lets a later method slot in: Unlock runs it and Use passphrase stays beside it", async () => {
    const rec = await hashPassphrase("pw-1234", 1000);
    const later: UnlockMethod = { id: "windows", kind: "tap", label: "lock.unlock" };
    const methods = [later, ...unlockMethods(rec)];
    expect(primaryMethod(methods)?.id).toBe("windows");
    expect(secretMethod(methods)?.id).toBe("passphrase");
    expect(startStep(methods)).toBe("choose");
    expect(nextStep("choose", "use-secret", methods)).toBe("secret");
    expect(nextStep("secret", "cancel", methods)).toBe("choose");
  });
});

describe("lock card keyboard flow", () => {
  const secretOnly = unlockMethods({ salt: "ab", hash: "cd" });
  const tapOnly = unlockMethods({ salt: "", hash: "" });
  it("Escape backs out of the field, then rests; a tap lock rests at once", () => {
    expect(stepForKey("secret", "Escape", secretOnly)).toBe("rest");
    expect(stepForKey("choose", "Escape", tapOnly)).toBe("rest");
    expect(stepForKey("secret", "Escape", [...tapOnly, ...secretOnly])).toBe("choose");
  });
  it("the resting card wakes on any key but Tab and the modifiers", () => {
    expect(stepForKey("rest", "a", secretOnly)).toBe("secret");
    expect(stepForKey("rest", "Enter", tapOnly)).toBe("choose");
    expect(stepForKey("rest", "Tab", tapOnly)).toBeNull();
    expect(stepForKey("rest", "Shift", tapOnly)).toBeNull();
  });
  it("other keys are left to the focused control", () => {
    expect(stepForKey("secret", "Enter", secretOnly)).toBeNull();
    expect(stepForKey("choose", "a", tapOnly)).toBeNull();
  });
  it("use-secret does nothing without a secret method, and wake only matters while resting", () => {
    expect(nextStep("choose", "use-secret", tapOnly)).toBe("choose");
    expect(nextStep("choose", "wake", tapOnly)).toBe("choose");
    expect(nextStep("rest", "wake", secretOnly)).toBe("secret");
  });
  it("Tab wraps in both directions", () => {
    expect(tabTarget(0, 3, false)).toBe(1);
    expect(tabTarget(2, 3, false)).toBe(0);
    expect(tabTarget(0, 3, true)).toBe(2);
    expect(tabTarget(-1, 3, false)).toBe(0);
    expect(tabTarget(-1, 3, true)).toBe(2);
    expect(tabTarget(0, 0, false)).toBe(-1);
  });
});

describe("the card as drawn", () => {
  const view = (h: ReturnType<typeof fakeServices>): string =>
    render(
      <ServicesContext.Provider value={h.services}>
        <LeafContext.Provider value={h.leaf}>
          <LockOverlay />
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
  it("draws nothing while unlocked", () => {
    expect(view(fakeServices())).toBe("");
  });
  it("a privacy blank shows the mark, the wordmark, Unlock and Cancel", () => {
    lockApp();
    const html = view(fakeServices());
    expect(html).toContain("cx-lock-mark");
    expect(html).toContain(t("rail.wordmark"));
    expect(html).toContain(COPY.lock.unlock);
    expect(html).toContain(COPY.lock.cancel);
    expect(html).toContain("is-blank");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain(COPY.lock.usePassphrase);
  });
  it("a passphrase lock opens on the field with Unlock and Cancel", async () => {
    const rec = await hashPassphrase("pw-1234", 1000);
    lockApp();
    const html = view(fakeServices((s) => void (s.privacy.lock = { ...s.privacy.lock, ...rec })));
    expect(html).toContain('type="password"');
    expect(html).toContain(COPY.lock.unlock);
    expect(html).toContain(COPY.lock.cancel);
    expect(html).not.toContain("is-blank");
    expect(html).toContain('role="dialog"');
    expect(html).toContain(COPY.lock.title);
  });

  it("an encrypted record has no blank lift: it asks for the passphrase even when no lock passphrase is stored", () => {
    setEncryptionConfigured(true);
    lockApp();
    const html = view(fakeServices());
    expect(html).toContain('type="password"');
    expect(html).not.toContain("is-blank");
    expect(html).not.toContain(COPY.lock.blank);
  });
});
