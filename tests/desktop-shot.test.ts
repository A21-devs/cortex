/**
 * Cortex Desktop's screenshot harness: the steps parser (src/desktop/shotSteps.ts) and the launch options the
 * Electron main process reads (src/desktop/config.ts). Pure: no Electron.
 */
import { describe, expect, it } from "vitest";
import { parseLaunchArgs, SHOT_DEFAULTS } from "../src/desktop/config";
import { capturePath, parseSize, parseStep, parseSteps, parseStepsText, StepError, STEP_LIMITS } from "../src/desktop/shotSteps";

describe("desktop harness: steps", () => {
  it("reads the short form of every action", () => {
    expect(parseSteps([{ wait: 250 }, { click: ".cx-header button" }, { eval: "1 + 1" }, { size: "1280x800" }, { capture: "after" }])).toEqual([
      { kind: "wait", ms: 250 },
      { kind: "click", selector: ".cx-header button", timeoutMs: STEP_LIMITS.defaultClickTimeoutMs },
      { kind: "eval", js: "1 + 1" },
      { kind: "size", width: 1280, height: 800 },
      { kind: "capture", path: "after.png" },
    ]);
  });

  it("reads the canonical form and the other size spellings", () => {
    expect(parseStep({ type: "wait", ms: 10 })).toEqual({ kind: "wait", ms: 10 });
    expect(parseStep({ type: "click", selector: "#x", timeout: 500 })).toEqual({ kind: "click", selector: "#x", timeoutMs: 500 });
    expect(parseStep({ click: "#x", timeout: 1500 })).toEqual({ kind: "click", selector: "#x", timeoutMs: 1500 });
    expect(parseStep({ type: "eval", js: "x" })).toEqual({ kind: "eval", js: "x" });
    expect(parseStep({ size: [1024, 768] })).toEqual({ kind: "size", width: 1024, height: 768 });
    expect(parseStep({ size: { width: 800, height: 600 } })).toEqual({ kind: "size", width: 800, height: 600 });
    expect(parseStep({ type: "size", width: 1512, height: 982 })).toEqual({ kind: "size", width: 1512, height: 982 });
    expect(parseStep({ type: "capture", path: "shots/a.PNG" })).toEqual({ kind: "capture", path: "shots/a.PNG" });
  });

  it("accepts an object with a steps list and JSON text (with a byte-order mark)", () => {
    expect(parseSteps({ steps: [{ wait: 1 }] })).toEqual([{ kind: "wait", ms: 1 }]);
    expect(parseStepsText(`${String.fromCharCode(0xfeff)}[{"capture":"x.png"}]`)).toEqual([{ kind: "capture", path: "x.png" }]);
    expect(parseSteps([])).toEqual([]);
  });

  it("refuses malformed steps with the step number in the message", () => {
    const bad: [unknown, RegExp][] = [
      [[{ wait: 1 }, { jump: 1 }], /step 2: needs one of/],
      [[{ wait: 1, click: "#a" }], /step 1: has more than one action/],
      [[{ wait: -5 }], /step 1: wait must be/],
      [[{ wait: STEP_LIMITS.maxWaitMs + 1 }], /wait must be/],
      [[{ click: "" }], /click selector must be a non-empty string/],
      [[{ eval: 42 }], /eval script must be/],
      [[{ size: "big" }], /is not WIDTHxHEIGHT/],
      [[{ size: [100, 800] }], /size must be whole pixels/],
      [[{ size: [1280.5, 800] }], /size must be whole pixels/],
      [[{ capture: "shot.jpg" }], /must end in .png/],
      [[{ capture: "a?.png" }], /cannot hold/],
      [[{ type: "scroll" }], /unknown type "scroll"/],
      [["wait"], /must be an object/],
      [{ notSteps: [] }, /must be a JSON array/],
    ];
    for (const [input, re] of bad) expect(() => parseSteps(input), JSON.stringify(input)).toThrow(re);
    expect(() => parseStepsText("[{wait: 1}]")).toThrow(StepError);
    expect(() => parseSteps(Array.from({ length: STEP_LIMITS.maxSteps + 1 }, () => ({ wait: 0 })))).toThrow(/too many steps/);
  });

  it("parses sizes and capture paths", () => {
    expect(parseSize("1512x982")).toEqual({ width: 1512, height: 982 });
    expect(parseSize(" 1280 X 800 ")).toEqual({ width: 1280, height: 800 });
    expect(parseSize("1920,1080")).toEqual({ width: 1920, height: 1080 });
    expect(() => parseSize("1512")).toThrow(StepError);
    expect(capturePath("C:\\shots\\one")).toBe("C:\\shots\\one.png");
    expect(capturePath("nested/two.png")).toBe("nested/two.png");
  });
});

describe("desktop harness: launch options", () => {
  it("defaults to a normal window (background like the plugin) on the stored vault", () => {
    expect(parseLaunchArgs(["dist-desktop"])).toEqual({ vault: null, viewOnly: false, devtools: false, shot: null });
    expect(parseLaunchArgs(["dist-desktop", "--vault=D:\\Vault", "--no-background", "--devtools"])).toEqual({ vault: "D:\\Vault", viewOnly: true, devtools: true, shot: null });
  });

  it("reads screenshot runs with their defaults (view only, offscreen, returning device)", () => {
    const o = parseLaunchArgs(["dist-desktop", "--shot", "--out=C:\\shots", "--profile=C:\\tmp\\p"]);
    expect(o.viewOnly).toBe(true);
    expect(o.shot).toEqual({
      out: "C:\\shots",
      steps: null,
      width: SHOT_DEFAULTS.width,
      height: SHOT_DEFAULTS.height,
      dpr: 1,
      timeoutMs: SHOT_DEFAULTS.timeoutMs,
      settleMs: SHOT_DEFAULTS.settleMs,
      device: "returning",
      mode: "offscreen",
      profile: "C:\\tmp\\p",
    });
    const p = parseLaunchArgs(["--shot", "--out=o", "--steps=s.json", "--size=1280x800", "--dpr=2", "--timeout=5000", "--settle=0", "--device=fresh", "--mode=hidden"]).shot;
    expect(p).toMatchObject({ steps: "s.json", width: 1280, height: 800, dpr: 2, timeoutMs: 5000, settleMs: 0, device: "fresh", mode: "hidden" });
  });

  it("refuses bad screenshot options", () => {
    expect(() => parseLaunchArgs(["--shot"])).toThrow(/--out/);
    expect(() => parseLaunchArgs(["--shot", "--out=o", "--dpr=9"])).toThrow(/--dpr/);
    expect(() => parseLaunchArgs(["--shot", "--out=o", "--mode=visible"])).toThrow(/--mode/);
    expect(() => parseLaunchArgs(["--shot", "--out=o", "--device=old"])).toThrow(/--device/);
    expect(() => parseLaunchArgs(["--shot", "--out=o", "--size=10x10"])).toThrow(StepError);
  });
});
