import { describe, expect, it } from "vitest";
import { motionHostDefault } from "../src/desktop/motionDefault";
import { CAMERA_NUMBERS } from "../src/shared/cameraNumbers";
import { defaultView } from "../src/state/types";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

describe("P05 turntable defaults", () => {
  it("Cortex Desktop turns Follow system into Full once, and keeps any other choice", () => {
    expect(motionHostDefault({ appearance: { motion: "system" } }, false)).toEqual({ settings: { appearance: { motion: "full" } }, changed: true });
    expect(motionHostDefault({}, false).settings).toEqual({ appearance: { motion: "full" } });
    expect(motionHostDefault({ appearance: { motion: "reduced" } }, false).changed).toBe(false);
    expect(motionHostDefault({ appearance: { motion: "system" } }, true).changed).toBe(false);
  });

  it("the plugin default stays Follow system; the figure turns once in 16 s and the pointer never pauses it", () => {
    expect(DEFAULT_SETTINGS.appearance.motion).toBe("system");
    expect(CAMERA_NUMBERS.spinPeriodSec).toBe(16);
    expect(CAMERA_NUMBERS.driftPeriodSec).toBe(12);
    expect(defaultView().motion.pauseWhilePointing).toBe(false);
  });
});
