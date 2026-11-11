/**
 * PASS4 fixes: sample hubs list their members, sample conversations list each note once, the sample Sources rows
 * come from the sample index, unnamed label chips are not drawn, selection source lines sit at the spec alpha, and
 * the sample summary reads as a sentence.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleTextResult, SAMPLE_SEED } from "../src/plugin/sampleRecord";
import { sampleSourceRows, createSourcesService } from "../src/plugin/sourcesService";
import { effectiveSourceAlpha, lineVertexAlpha8 } from "../src/render/lineAlpha";
import { RENDER_TUNING } from "../src/render/tuning";
import { ItemKind, NONE32, Population } from "../src/shared/index-format";
import { createLogger, consoleSink, nullLogger } from "../src/shared/log";
import { migrateSettingsChecked } from "../src/shared/settings";
import { createRecordReader, sampleGistText } from "../src/store/recordReader";
import { layoutLabels } from "../src/ui/stage/LabelLayer";
import { buildSampleIndex } from "../src/worker/sampleIndex";

let tmp = "";
const index = buildSampleIndex(SAMPLE_SEED, Date.UTC(2026, 5, 1));

function readerOf(sandbox: boolean) {
  return createRecordReader({ vaultRoot: path.join(tmp, "vault"), cacheDir: path.join(tmp, "cache"), index: () => index, log: createLogger("test", consoleSink, () => false), sandbox: () => sandbox, sampleText: sampleTextResult });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-p4-"));
  fs.mkdirSync(path.join(tmp, "vault"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "cache"), { recursive: true });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("sample hubs (fix 1)", () => {
  it("fill members, kinds, activity and hub fields from the index relation", async () => {
    const { offsets } = index.rel.hubMembers;
    let o = -1;
    for (let i = 0; i < index.count && o < 0; i++) if (index.cols.kind[i] === ItemKind.NoteHub && (offsets[i + 1] as number) - (offsets[i] as number) > 3) o = i;
    expect(o).toBeGreaterThanOrEqual(0);
    const want = (offsets[o + 1] as number) - (offsets[o] as number);
    const d = await readerOf(true).note(o);
    const total = (d.members ?? []).reduce((a, g) => a + g.count, 0);
    expect(total).toBe(want);
    expect(d.members?.every((g) => g.ids.length === g.count)).toBe(true);
    expect(d.activity?.length).toBe(12);
    expect(d.record.hub?.members.length).toBe(want);
    expect(["project", "area", "topic"]).toContain(d.record.hub?.hubType);
    expect(["active", "quiet", "paused"]).toContain(d.record.hub?.status);
    expect(d.record.hub?.brief).toEqual([]);
    expect(d.record.madeBy).toEqual({ legacy: true });
  });

  it("leaves non-map notes without hub fields", async () => {
    let o = -1;
    for (let i = 0; i < index.count && o < 0; i++) if (index.cols.kind[i] === ItemKind.NoteAtomic) o = i;
    const d = await readerOf(true).note(o);
    expect(d.record.hub).toBeUndefined();
    expect(d.members).toBeUndefined();
  });
});

describe("sample conversation notes (fix 2)", () => {
  it("gives every atomic note of a conversation its own title", () => {
    const seen = new Map<number, Set<string>>();
    for (let o = 0; o < index.count; o++) {
      if (index.cols.kind[o] !== ItemKind.NoteAtomic) continue;
      const conv = index.cols.conv[o] as number;
      const titles = seen.get(conv) ?? new Set<string>();
      seen.set(conv, titles);
      const title = index.titles.get(o);
      expect(titles.has(title)).toBe(false);
      titles.add(title);
    }
    expect(seen.size).toBeGreaterThan(100);
  });

  it("lists each note once in the reader", async () => {
    const reader = readerOf(true);
    let checked = 0;
    for (let r = 0; r < index.convs.size && checked < 40; r++) {
      const row = index.convs.get(r);
      if (row.gist === NONE32) continue;
      const d = await reader.conversation(row.id);
      const ids = d.parts.flatMap((p) => p.notes.map((n) => n.id as string));
      expect(new Set(ids).size).toBe(ids.length);
      const titles = d.parts.flatMap((p) => p.notes.map((n) => n.title));
      expect(new Set(titles).size).toBe(titles.length);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("sample Sources rows (fix 3)", () => {
  it("count the sample index per source", () => {
    const rows = sampleSourceRows(index);
    const by = new Map(rows.map((r) => [r.id, r]));
    const convs = new Map<string, number>();
    for (let r = 0; r < index.convs.size; r++) convs.set(index.convs.get(r).source, (convs.get(index.convs.get(r).source) ?? 0) + 1);
    expect(by.get("claude-code")?.items).toBe(convs.get("claude-code"));
    expect(by.get("chatgpt")?.items).toBe(convs.get("chatgpt"));
    expect(by.get("claude-code")?.items).toBeGreaterThan(0);
    expect(by.get("vault")?.items).toBeGreaterThan(0);
    expect(by.get("raw")?.items).toBeGreaterThan(0);
    expect(by.get("written")?.items).toBeGreaterThan(0);
    expect(rows.every((r) => !r.watching && r.status === "imported")).toBe(true);
    let files = 0;
    for (let o = 0; o < index.count; o++) if (index.cols.pop[o] === Population.Record && index.cols.source[o] === 5) files++;
    expect(by.get("raw")?.items).toBe(files);
  });

  it("is what the service returns while the sample shows, without touching the vault, settings or manifest", async () => {
    const settings = migrateSettingsChecked(undefined).settings;
    const svc = createSourcesService({
      app: {} as never,
      vaultRoot: path.join(tmp, "nowhere"),
      cacheDir: path.join(tmp, "nowhere-cache"),
      log: nullLogger,
      settings: { value: settings, signal: undefined as never, corrupt: false, issues: [], update: async () => undefined, reload: async () => undefined, useDefaults: async () => undefined },
      runner: { request: (async () => { throw new Error("the runner must not be asked in the sample"); }) as never },
      corrections: { exclude: (async () => undefined) as never },
      index: () => index,
      sandbox: () => true,
    });
    expect(await svc.estimate()).toEqual({ sources: [], conversations: 0, notes: 0, tokens: 0 });
    expect(await svc.list()).toEqual(sampleSourceRows(index));
    expect(await svc.files()).toEqual([]);
    expect(await svc.needsAttention()).toEqual([]);
    expect(fs.existsSync(path.join(tmp, "nowhere-cache"))).toBe(false);
  });
});

describe("unnamed label chips (fix 4)", () => {
  it("are not drawn", () => {
    const a = (key: string, title: string) => ({ key, ordinal: 1, x: 100, y: 100, depth: 0, priority: 1, kind: "", glyph: "", title, rgb: [1, 1, 1] as [number, number, number] });
    const out = layoutLabels([a("a", ""), a("b", "   "), a("c", "Named")], [], { width: 800, height: 600 }, 24, null);
    expect(out.map((p) => p.anchor.key)).toEqual(["c"]);
  });
});

describe("selection source lines (fix 5)", () => {
  it("draw the selection's own lines at the spec alpha, 34 to 50 percent", () => {
    const own = effectiveSourceAlpha(true, true);
    expect(own.near).toBeCloseTo(0.5, 2);
    expect(own.far).toBeCloseTo(0.34, 2);
    expect(RENDER_TUNING.lines.sourceAlpha).toBe(0.5);
    expect(RENDER_TUNING.lines.sourceAlphaFar).toBe(0.34);
  });
  it("keeps dimming the lines drawn for everything else while something is selected", () => {
    expect(effectiveSourceAlpha(false, true).near).toBeCloseTo(0.25, 2);
    expect(effectiveSourceAlpha(false, false).near).toBeCloseTo(0.5, 2);
    expect(lineVertexAlpha8(true, false)).toBe(255);
  });
});

describe("sample summary (fix 6)", () => {
  it("reads as one templated sentence", () => {
    expect(sampleGistText("Sorting the pea netting", 27, ["Book time for the pea netting", "Keep the netting simple"])).toBe("Sorting the pea netting: 27 messages, with two notes, “Book time for the pea netting” and “Keep the netting simple”.");
    expect(sampleGistText("Fixing the gate", 1, [])).toBe("Fixing the gate: 1 message, with no notes drawn from it yet.");
    expect(sampleGistText("", 8, ["A", "B", "C", "D"])).toContain("4 notes, among them");
  });
  it("is what the sample conversation's gist carries, and is deterministic", async () => {
    let row = -1;
    for (let r = 0; r < index.convs.size && row < 0; r++) if (index.convs.get(r).gist !== NONE32) row = r;
    const a = await readerOf(true).conversation(index.convs.get(row).id);
    const b = await readerOf(true).conversation(index.convs.get(row).id);
    expect(a.gist?.text).toBe(b.gist?.text);
    expect(a.gist?.text.startsWith(index.convs.get(row).title)).toBe(true);
    expect(a.gist?.text).toMatch(/messages?, with /);
  });
});
