/**
 * Originality checks in `npm test` (CORTEX-UX §0.1, §12.1; ORIG-10, ORIG-21). A port of
 * docs/mockups/src/originality_check.py that reads the SAME pattern list from that script, applied to the copy,
 * the markdown note templates, the user-facing strings of agents/privacy.ts and the two mockups; the shipped
 * palette must equal the values palette_check.py validates; and, when Python is installed, both scripts run
 * as-is and must pass.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AGE_RAMP, COUNT_RAMP, DIVERGING, MACHINE, NO_VALUE, OTHER, PALETTES, PRINT_GREYS, STATUS } from "../src/shared/palette";

const root = path.resolve(__dirname, "..");
const mock = path.join(root, "docs", "mockups");
const script = fs.readFileSync(path.join(mock, "src", "originality_check.py"), "utf8");
const paletteScript = fs.readFileSync(path.join(mock, "src", "palette_check.py"), "utf8");

/** The BANNED list of originality_check.py as JS regexes. */
function bannedPatterns(): { id: string; re: RegExp }[] {
  const out: { id: string; re: RegExp }[] = [];
  for (const m of script.matchAll(/\("([A-Za-z0-9-]+)",\s*([IC]),\s*r"((?:[^"\\]|\\.)*)"\)/g)) {
    out.push({ id: m[1] ?? "", re: new RegExp(m[3] ?? "", m[2] === "I" ? "i" : "") });
  }
  return out;
}

function visibleText(file: string, raw: string): string {
  if (!/\.html?$/.test(file)) return raw;
  let s = raw.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/g, " ");
  const attrs = [...s.matchAll(/(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]).join(" ");
  s = s.replace(/<[^>]+>/g, " ");
  return `${s}\n${attrs}`;
}

function hits(file: string): string[] {
  const raw = fs.readFileSync(file, "utf8");
  const pats = bannedPatterns();
  const out: string[] = [];
  visibleText(file, raw)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const p of pats) {
        const m = p.re.exec(line);
        if (m) out.push(`${path.basename(file)}:${i + 1} [${p.id}] '${m[0]}'`);
      }
    });
  return out;
}

const COPY_FILES = ["src/ui/copy.ts", "src/store/notesWriter.ts", "src/agents/privacy.ts"].map((f) => path.join(root, f));
const MOCKUPS = ["main.html", "panels.html"].map((f) => path.join(mock, f));

describe("originality: banned expressions (originality_check.py patterns)", () => {
  it("reads the full pattern list", () => {
    expect(bannedPatterns().length).toBeGreaterThanOrEqual(140);
  });
  it("copy, note templates and privacy strings are clean", () => {
    expect(COPY_FILES.flatMap(hits)).toEqual([]);
  });
  it("the mockups are clean", () => {
    expect(MOCKUPS.filter((f) => fs.existsSync(f)).flatMap(hits)).toEqual([]);
  });
  it("retired structures are gone from the UI (ORIG-20, ORIG-09, ORIG-16)", () => {
    const ui = path.join(root, "src", "ui");
    expect(fs.existsSync(path.join(ui, "rail"))).toBe(false);
    expect(fs.existsSync(path.join(ui, "tour"))).toBe(false);
    const all = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const text = all(path.join(root, "src")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    for (const banned of ["SHORT_RAIL", "TOUR_STEPS", "SpaceChip", "CHART_ANSWERS", "PAGE_DOCK", "\"balance\""]) expect(text.includes(banned), banned).toBe(false);
  });
});

/** Parse a Python list/tuple of hex strings: NAME = "a b c".split() or ("a", "b"). */
function pyHexes(name: string): string[] {
  const m = new RegExp(`^${name} = (.+)$`, "m").exec(paletteScript);
  if (!m?.[1]) throw new Error(`no ${name} in palette_check.py`);
  return [...m[1].matchAll(/#[0-9a-f]{6}/gi)].map((x) => x[0].toLowerCase());
}

describe("originality: the shipped palette equals palette_check.py", () => {
  it("Prism, Signal, remainders, ramps, status and machine colours", () => {
    const prism = PALETTES.find((p) => p.id === "prism");
    const order = ["azure", "amber", "rose", "citron", "teal", "coral", "violet", "mint"];
    const block = paletteScript.slice(paletteScript.indexOf("PRISM = {"), paletteScript.indexOf("PRISM_ORDER"));
    const byName = new Map([...block.matchAll(/"(\w+)": \("(#\w+)", "(#\w+)", "(#\w+)"\)/g)].map((m) => [m[1], [m[2], m[3], m[4]]]));
    expect(prism?.glow).toEqual(order.map((n) => byName.get(n)?.[0]));
    expect(prism?.fill).toEqual(order.map((n) => byName.get(n)?.[1]));
    expect(prism?.light).toEqual(order.map((n) => byName.get(n)?.[2]));
    const signal = PALETTES.find((p) => p.id === "signal");
    expect(signal?.glow).toEqual(pyHexes("SIGNAL_GLOW"));
    expect(signal?.light).toEqual(pyHexes("SIGNAL_LIGHT"));
    for (const id of ["harbor", "orchard", "ember", "reef"] as const) {
      const p = PALETTES.find((x) => x.id === id);
      expect(p?.glow, id).toEqual(pyHexes(`${id.toUpperCase()}_GLOW`));
      expect(p?.fill, id).toEqual(pyHexes(`${id.toUpperCase()}_FILL`));
      expect(p?.light, id).toEqual(pyHexes(`${id.toUpperCase()}_LIGHT`));
    }
    expect([OTHER.glow, OTHER.fill, OTHER.light]).toEqual(pyHexes("OTHER"));
    expect([NO_VALUE.glow, NO_VALUE.fill, NO_VALUE.light]).toEqual(pyHexes("NO_VALUE"));
    expect([...AGE_RAMP.dark]).toEqual(pyHexes("AGE_DARK"));
    expect([...AGE_RAMP.light]).toEqual(pyHexes("AGE_LIGHT"));
    expect([...COUNT_RAMP.dark]).toEqual(pyHexes("COUNT_DARK"));
    expect([...COUNT_RAMP.light]).toEqual(pyHexes("COUNT_LIGHT"));
    expect([COUNT_RAMP.emptyDark, COUNT_RAMP.emptyLight]).toEqual(pyHexes("COUNT_EMPTY"));
    expect([...DIVERGING.dark]).toEqual(pyHexes("DIV_DARK"));
    expect([...DIVERGING.light]).toEqual(pyHexes("DIV_LIGHT"));
    expect(Object.values(STATUS.dark)).toEqual(pyHexes("STATUS_DARK"));
    expect(Object.values(STATUS.light)).toEqual(pyHexes("STATUS_LIGHT"));
    expect([MACHINE.dark, MACHINE.light]).toEqual(pyHexes("MACHINE"));
    expect(PRINT_GREYS).toEqual(["#372a2b", "#584949", "#7a6a6b", "#9e8d8e"]);
    for (const p of PALETTES) for (const v of ["glow", "fill", "light"] as const) expect(p[v]).not.toContain("#ffffff");
  });
});

function runPython(args: string[]): { ran: boolean; status: number | null; out: string } {
  for (const exe of ["python", "python3", "py"]) {
    const r = spawnSync(exe, args, { encoding: "utf8", cwd: path.join(mock, "src"), timeout: 120_000, windowsHide: true });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    return { ran: true, status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }
  return { ran: false, status: null, out: "" };
}

describe("originality: the Python checks themselves", () => {
  it("originality_check.py passes on the copy, the note templates and the mockups", () => {
    const r = runPython(["-I", "originality_check.py", ...COPY_FILES, ...MOCKUPS.filter((f) => fs.existsSync(f))]);
    if (!r.ran) return;
    expect(r.out).toContain("clean");
    expect(r.status).toBe(0);
  }, 130_000);
  it("palette_check.py passes", () => {
    const r = runPython(["-I", "palette_check.py"]);
    if (!r.ran) return;
    expect(r.out).toContain("RESULT: pass");
    expect(r.status).toBe(0);
  }, 130_000);
});
