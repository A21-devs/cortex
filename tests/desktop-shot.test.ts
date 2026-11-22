/**
 * Cortex Desktop's screenshot harness: the steps parser (src/desktop/shotSteps.ts), its stand-in agents status, and
 * the launch options the Electron main process reads (src/desktop/config.ts). Pure: no Electron.
 */
import { describe, expect, it } from "vitest";
import { parseLaunchArgs, SHOT_DEFAULTS } from "../src/desktop/config";
import { capturePath, loadStatusFiles, parseAgentsStatus, parseAgentsStatusText, parseSize, parseStep, parseSteps, parseStepsText, readAgentsStatus, StepError, STEP_LIMITS } from "../src/desktop/shotSteps";
import type { AgentsStatusResult } from "../src/shared/protocol/runner";

/** A small, valid agents.status result: 12 label targets, 2 summaries and 1 map, in four groups. */
function status(patch: Record<string, unknown> = {}): AgentsStatusResult {
  return {
    day: "2026-11-21",
    tokensToday: 1200,
    tokensReserved: 0,
    usdToday: 0.02,
    plan: {
      fiveHour: { window: "fiveHour", pct: 12.5, capPct: 70, resetsAt: 1_795_255_200_000, stale: false, atCap: false },
      weekly: { window: "weekly", pct: null, capPct: null, resetsAt: null, stale: false, atCap: false },
    },
    capped: false,
    paused: false,
    engine: "ok",
    pending: { label: 12, gist: 2, hub: 1, filing: 0, "name-check": 0, answer: 0, directions: 0 },
    groups: [
      { what: "notes", where: "Projects", inside: ["Website"], insideTotal: 3, n: 10 },
      { what: "chats", n: 2 },
      { what: "summaries", n: 2 },
      { what: "maps", n: 1 },
    ],
    checks: 3,
    ...patch,
  } as AgentsStatusResult;
}

/** The same status before the planner described its work (no groups; the field is optional). */
function withoutGroups(patch: Record<string, unknown> = {}): AgentsStatusResult {
  const { groups: _groups, ...rest } = status(patch);
  return rest;
}

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
      agentsStatus: null,
      width: SHOT_DEFAULTS.width,
      height: SHOT_DEFAULTS.height,
      dpr: 1,
      timeoutMs: SHOT_DEFAULTS.timeoutMs,
      settleMs: SHOT_DEFAULTS.settleMs,
      device: "returning",
      mode: "offscreen",
      profile: "C:\\tmp\\p",
    });
    const p = parseLaunchArgs(["--shot", "--out=o", "--steps=s.json", "--agents-status=C:\\shots\\status.json", "--size=1280x800", "--dpr=2", "--timeout=5000", "--settle=0", "--device=fresh", "--mode=hidden"]).shot;
    expect(p).toMatchObject({ steps: "s.json", agentsStatus: "C:\\shots\\status.json", width: 1280, height: 800, dpr: 2, timeoutMs: 5000, settleMs: 0, device: "fresh", mode: "hidden" });
  });

  it("takes a stand-in agents status in screenshot runs only", () => {
    expect(parseLaunchArgs(["--vault=D:\\Vault", "--agents-status=status.json"])).toEqual({ vault: "D:\\Vault", viewOnly: false, devtools: false, shot: null });
    expect(() => parseLaunchArgs(["--shot", "--out=o", "--agents-status=status.txt"])).toThrow(/--agents-status: .*must end in \.json/);
    expect(() => parseLaunchArgs(["--shot", "--out=o", "--agents-status="])).toThrow(/--agents-status: agents status file must be a non-empty string/);
  });

  it("refuses bad screenshot options", () => {
    expect(() => parseLaunchArgs(["--shot"])).toThrow(/--out/);
    expect(() => parseLaunchArgs(["--shot", "--out=o", "--dpr=9"])).toThrow(/--dpr/);
    expect(() => parseLaunchArgs(["--shot", "--out=o", "--mode=visible"])).toThrow(/--mode/);
    expect(() => parseLaunchArgs(["--shot", "--out=o", "--device=old"])).toThrow(/--device/);
    expect(() => parseLaunchArgs(["--shot", "--out=o", "--size=10x10"])).toThrow(StepError);
  });
});

describe("desktop harness: a stand-in agents status", () => {
  it("reads the step with a file name or the status itself, in the short and the canonical form", () => {
    expect(parseSteps([{ agentsStatus: "status.json" }, { type: "agentsStatus", file: "shots\\other.JSON" }])).toEqual([
      { kind: "agentsStatus", file: "status.json", status: null },
      { kind: "agentsStatus", file: "shots\\other.JSON", status: null },
    ]);
    expect(parseStep({ agentsStatus: status() })).toEqual({ kind: "agentsStatus", file: null, status: status() });
    expect(parseStep({ type: "agentsStatus", status: withoutGroups() })).toEqual({ kind: "agentsStatus", file: null, status: withoutGroups() });
  });

  it("refuses a malformed step with the step number and the reason", () => {
    const bad: [unknown, RegExp][] = [
      [[{ wait: 1 }, { agentsStatus: "status.txt" }], /step 2: agents status file "status.txt" must end in \.json/],
      [[{ agentsStatus: "a?.json" }], /cannot hold/],
      [[{ agentsStatus: 3 }], /step 1: agentsStatus needs a status file name \(\.json\) or the status itself/],
      [[{ agentsStatus: [status()] }], /agentsStatus needs/],
      [[{ type: "agentsStatus" }], /agentsStatus needs/],
      [[{ agentsStatus: "status.json", capture: "a.png" }], /more than one action/],
      [[{ wait: 1 }, { agentsStatus: status({ group: [] }) }], /step 2: agents status: \$\.group is not allowed/],
    ];
    for (const [input, re] of bad) expect(() => parseSteps(input), JSON.stringify(input)).toThrow(re);
  });

  it("checks the status against AgentsStatusResult and names every problem", () => {
    expect(parseAgentsStatus(status())).toEqual(status());
    expect(parseAgentsStatus(withoutGroups({ resumeAt: "2026-11-21T18:30:00.000Z", lastRun: { runId: "r_0abc", job: "label", status: "finished", finishedAt: "2026-11-21T09:00:00+01:00" } }))).toMatchObject({ lastRun: { job: "label" } });
    const bad: [unknown, RegExp][] = [
      [null, /agents status: \$ expected object, got null/],
      [[status()], /\$ expected object, got array/],
      [status({ pending: { label: 12, gist: 2, hub: 1 } }), /\$\.pending\.filing is required; \$\.pending\.name-check is required/],
      [status({ pending: { ...status().pending, review: 1 } }), /\$\.pending\.review is not allowed/],
      [status({ tokensToday: -1 }), /\$\.tokensToday below 0/],
      [status({ checks: 2.5 }), /\$\.checks expected integer, got number/],
      [status({ engine: "sleeping" }), /\$\.engine must be one of "ok"/],
      [status({ capped: "no" }), /\$\.capped expected boolean, got string/],
      [status({ day: "21/11/2026" }), /\$\.day does not match/],
      [status({ day: "2026-02-30" }), /\$\.day is not a real day/],
      [status({ resumeAt: "2026-11-21T25:00Z" }), /\$\.resumeAt is not a real time/],
      [status({ plan: { fiveHour: status().plan.fiveHour } }), /\$\.plan\.weekly is required/],
      [status({ plan: { ...status().plan, weekly: { ...status().plan.fiveHour } } }), /\$\.plan\.weekly\.window must equal "weekly"/],
      [status({ groups: [{ what: "notes", n: 15 }] }), /\$\.groups\[0\]\.where is required for notes/],
      [status({ groups: [{ what: "notes", where: "Projects", n: 0 }, { what: "chats", n: 15 }] }), /\$\.groups\[0\]\.n below 1/],
      [status({ groups: [{ what: "notes", where: "Projects", n: 15, inside: ["a", "b", "c"] }] }), /\$\.groups\[0\]\.inside more than 2 items/],
      [status({ groups: [{ what: "notes", where: "Projects", n: 15, inside: ["a", "b"], insideTotal: 1 }] }), /\$\.groups\[0\]\.insideTotal is below the 2 names/],
      [status({ groups: [{ what: "tasks", n: 15 }] }), /\$\.groups\[0\]\.what must be one of/],
      [status({ groups: [{ what: "notes", where: "Projects", n: 9 }] }), /\$\.groups add up to 9, but \$\.pending label \+ gist \+ hub is 15/],
      [status({ lastRun: { runId: "run-1", job: "label", status: "finished" } }), /\$\.lastRun\.runId does not match/],
    ];
    for (const [input, re] of bad) {
      expect(() => parseAgentsStatus(input), JSON.stringify(input)).toThrow(StepError);
      expect(() => parseAgentsStatus(input), JSON.stringify(input)).toThrow(re);
    }
  });

  it("reads status text (with a byte-order mark) and refuses text that is not JSON or too long", () => {
    expect(parseAgentsStatusText(`${String.fromCharCode(0xfeff)}${JSON.stringify(status())}`)).toEqual(status());
    expect(() => parseAgentsStatusText("{ day: 1 }")).toThrow(/agents status is not valid JSON/);
    expect(() => parseAgentsStatusText(" ".repeat(STEP_LIMITS.maxStatusText + 1))).toThrow(/too long/);
  });

  it("reads each step's status file before the run, naming the step and the file when one is missing or malformed", () => {
    const files: Record<string, string> = { "status.json": JSON.stringify(status()), "bad.json": "{", "wrong.json": JSON.stringify(status({ checks: -2 })) };
    const asked: string[] = [];
    const read = (name: string): string => {
      asked.push(name);
      const text = files[name];
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${name}'`);
      return text;
    };
    const steps = loadStatusFiles(parseSteps([{ wait: 1 }, { agentsStatus: "status.json" }, { agentsStatus: status({ checks: 9 }) }, { capture: "a.png" }]), read);
    expect(asked).toEqual(["status.json"]);
    expect(steps).toEqual([
      { kind: "wait", ms: 1 },
      { kind: "agentsStatus", file: "status.json", status: status() },
      { kind: "agentsStatus", file: null, status: status({ checks: 9 }) },
      { kind: "capture", path: "a.png" },
    ]);
    expect(() => loadStatusFiles(parseSteps([{ agentsStatus: "missing.json" }]), read)).toThrow(/step 1: could not read the agents status file missing\.json \(ENOENT/);
    expect(() => loadStatusFiles(parseSteps([{ wait: 1 }, { agentsStatus: "bad.json" }]), read)).toThrow(/step 2: bad\.json: agents status is not valid JSON/);
    expect(() => loadStatusFiles(parseSteps([{ agentsStatus: "wrong.json" }]), read)).toThrow(/step 1: wrong\.json: agents status: \$\.checks below 0/);
    expect(readAgentsStatus("status.json", read, "--agents-status")).toEqual(status());
    expect(() => readAgentsStatus("wrong.json", read, "--agents-status")).toThrow(/^--agents-status: wrong\.json: agents status: /);
  });
});
