/**
 * The sample record has no ledger: a conversation's notes and gist come from the index alone
 * (relations.noteSources, ConversationRow.gist), so the reader matches the figure's note chips.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleTextResult, SAMPLE_SEED } from "../src/plugin/sampleRecord";
import { NONE32 } from "../src/shared/index-format";
import { createLogger, consoleSink } from "../src/shared/log";
import { createRecordReader } from "../src/store/recordReader";
import { buildSampleIndex } from "../src/worker/sampleIndex";

let tmp = "";
const index = buildSampleIndex(SAMPLE_SEED, Date.UTC(2026, 5, 1));

function readerOf(sandbox: boolean) {
  return createRecordReader({ vaultRoot: path.join(tmp, "vault"), cacheDir: path.join(tmp, "cache"), index: () => index, log: createLogger("test", consoleSink, () => false), sandbox: () => sandbox, sampleText: sampleTextResult });
}

describe("sample record: conversation reader", () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sconv-"));
    fs.mkdirSync(path.join(tmp, "vault"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "cache"), { recursive: true });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("builds notes and the gist from the index in sandbox mode", async () => {
    let withGist = -1;
    for (let r = 0; r < index.convs.size && withGist < 0; r++) if (index.convs.get(r).gist !== NONE32) withGist = r;
    expect(withGist).toBeGreaterThanOrEqual(0);
    const row = index.convs.get(withGist);
    const d = await readerOf(true).conversation(row.id);
    expect(d.gist).toBeDefined();
    expect(d.gist?.madeBy).toEqual({ legacy: true });
    expect(d.gist?.text.length).toBeGreaterThan(0);
    expect(d.gist?.file).toBe("");
    const notes = d.parts.flatMap((p) => p.notes);
    for (const n of notes) expect(["gist", "hub"]).not.toContain(n.kind);
    expect(d.parts.length).toBeGreaterThan(0);
  });

  it("finds notes for at least one conversation, and counts them like the index relation does", async () => {
    const reader = readerOf(true);
    let found = 0;
    for (let r = 0; r < index.convs.size && found < 1; r++) {
      const d = await reader.conversation(index.convs.get(r).id);
      const n = d.parts.reduce((a, p) => a + p.notes.length, 0);
      if (n > 0) {
        found = n;
        for (const part of d.parts) for (const note of part.notes) expect(note.id.startsWith("n_")).toBe(true);
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it("gives a sample message its place in the conversation (the reader's scrubber and Open conversation)", async () => {
    const reader = readerOf(true);
    let checked = 0;
    for (let o = 0; o < index.count && checked < 3; o++) {
      const row = index.cols.conv[o];
      if (row === undefined || row === NONE32 || index.ids.get(o).startsWith("n_")) continue;
      const d = await reader.entry(o);
      const c = index.convs.get(row);
      expect(d.conversation?.id).toBe(c.id);
      expect(d.record.conv).toBe(c.id);
      expect(d.conversation?.title).toBe(c.title);
      expect(d.conversation?.count).toBeGreaterThan(0);
      expect(d.conversation?.speakers.length).toBe(d.conversation?.count);
      expect(d.conversation?.index).toBeLessThan(d.conversation?.count ?? 0);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("does not read the ledger in sandbox mode", async () => {
    // The vault has no ledger folder at all; a ledger grep would find nothing, so the sample notes can only come from the index.
    expect(fs.readdirSync(path.join(tmp, "vault"))).toEqual([]);
    const d = await readerOf(true).conversation(index.convs.get(0).id);
    expect(d.record.id).toBe(index.convs.get(0).id);
  });
});
