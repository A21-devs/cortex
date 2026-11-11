/**
 * proof-audit-export, the plugin side: the three flows (choose a path, ask the runner, one notice), the failure texts, the
 * encrypted export, the commands and the reader's "Prove this entry" button. No runner process, no dialog, no network.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { render } from "preact-render-to-string";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CortexError } from "../src/shared/errors";
import { holdVaultKey, resetKeyring, setEncryptionConfigured } from "../src/shared/crypto/keyring";
import { COMMAND_IDS, ACTION_REGISTRY } from "../src/plugin/commands";
import { exportMyRecord, makeAuditPack, packFailure, proveEntry, stamp, withZip } from "../src/plugin/packs";
import { chooseSavePath } from "../src/plugin/saveFile";
import type { CortexServices } from "../src/plugin/services";
import { decryptExportBytes } from "../src/store/exportCrypto";
import { VERIFIER_KEYS } from "../src/store/verifierPage";
import { ZipWriter } from "../src/node/zip";
import { verifierStrings } from "../src/plugin/verifierStrings";
import { t } from "../src/ui/copy";
import { FactsGrid, type FactsGridProps } from "../src/ui/reader/FactsGrid";
import { makeFmt } from "../src/ui/pages/PageFrame";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "cx-paeui-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => resetKeyring());

type Req = { cmd: string; args: Record<string, unknown> };
function services(over: { sandbox?: boolean; request?: (r: Req) => Promise<unknown>; openSpaces?: string[] } = {}) {
  const calls: Req[] = [];
  const s = {
    sandbox: { value: over.sandbox === true },
    settings: { value: { consent: { openSpaces: over.openSpaces ?? [] } } },
    runner: {
      request: async (r: Req) => {
        calls.push(r);
        return over.request ? over.request(r) : {};
      },
    },
  } as unknown as CortexServices;
  return { s, calls };
}
const notices = (): { say: (x: string) => void; all: string[] } => {
  const all: string[] = [];
  return { say: (x) => void all.push(x), all };
};
const dialogTo = (p: string | null) => ({ showSave: async () => (p ? { canceled: false, filePath: p } : { canceled: true }) });

describe("choosing where a pack goes", () => {
  it("uses the Save dialog, or a unique name in Downloads, and never writes", async () => {
    const home = tmp();
    const fromDialog = await chooseSavePath({ suggestedName: "a.zip", mime: "application/zip" }, { dialog: dialogTo(path.join(home, "chosen.zip")) });
    expect(fromDialog).toBe(path.join(home, "chosen.zip"));
    expect(await chooseSavePath({ suggestedName: "a.zip", mime: "application/zip" }, { dialog: dialogTo(null) })).toBeNull();
    const a = await chooseSavePath({ suggestedName: "a.zip", mime: "application/zip" }, { dialog: null, home });
    expect(a).toBe(path.join(home, "Downloads", "a.zip"));
    expect(existsSync(a!)).toBe(false);
    expect(await chooseSavePath({ suggestedName: "a.zip", mime: "application/zip" }, { dialog: null, home, exists: (p) => p === a })).toBe(path.join(home, "Downloads", "a (2).zip"));
    await expect(chooseSavePath({ suggestedName: "a.zip", mime: "application/zip" }, { dialog: dialogTo("relative.zip") })).rejects.toMatchObject({ code: "E_PATH_DENIED" });
  });
});

describe("Prove this entry and Audit pack", () => {
  it("ask the runner for a zip at the chosen path, with the page text, and say where it went", async () => {
    const home = tmp();
    const { s, calls } = services();
    const n = notices();
    const out = path.join(home, "p.zip");
    expect(await proveEntry(s, "e_aaaaaaaaaaaaaaab", n.say, { dialog: dialogTo(out) })).toBe(out);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: "proof.entry", args: { id: "e_aaaaaaaaaaaaaaab", out } });
    const strings = (calls[0]!.args as { strings: Record<string, string> }).strings;
    expect(Object.keys(strings).sort()).toEqual([...VERIFIER_KEYS].sort());
    expect(strings).toEqual({ ...verifierStrings() });
    expect(n.all.at(-1)).toBe(t("proof.proofSaved", { path: out }));

    expect(await makeAuditPack(s, n.say, { dialog: dialogTo(path.join(home, "a.zip")) })).toBe(path.join(home, "a.zip"));
    expect(calls[1]).toMatchObject({ cmd: "audit.pack" });
    expect(n.all.at(-1)).toBe(t("proof.auditSaved", { path: path.join(home, "a.zip") }));
  });

  it("do nothing when the dialog is cancelled, and refuse in the sample record", async () => {
    const { s, calls } = services();
    const n = notices();
    expect(await proveEntry(s, "e_aaaaaaaaaaaaaaab", n.say, { dialog: dialogTo(null) })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(n.all).toEqual([]);
    const sample = services({ sandbox: true });
    expect(await makeAuditPack(sample.s, n.say, { dialog: dialogTo("C:/x.zip") })).toBeNull();
    expect(await proveEntry(sample.s, "e_aaaaaaaaaaaaaaab", n.say)).toBeNull();
    expect(sample.calls).toHaveLength(0);
    expect(n.all).toEqual([t("proof.sample"), t("proof.sample")]);
  });

  it("turn the runner's reasons into plain sentences", async () => {
    for (const [reason, key] of [["not-sealed", "proof.notSealed"], ["salt-elsewhere", "proof.saltElsewhere"], ["text-missing", "proof.textMissing"], ["text-changed", "proof.textMissing"], ["zip-limit", "proof.exportTooBig"]] as const) {
      expect(packFailure(new CortexError("E_IO", "x", { detail: { reason } }))).toBe(t(key));
    }
    expect(packFailure(new Error("boom"))).toBe(t("proof.failed"));
    const { s } = services({ request: async () => Promise.reject(new CortexError("E_IO", "x", { detail: { reason: "not-sealed" } })) });
    const n = notices();
    expect(await proveEntry(s, "e_aaaaaaaaaaaaaaab", n.say, { dialog: dialogTo(path.join(tmp(), "p.zip")) })).toBeNull();
    expect(n.all.at(-1)).toBe(t("proof.notSealed"));
  });

  it("names files by the minute", () => {
    expect(stamp(new Date(2026, 10, 3, 9, 5))).toBe("20261103-0905");
    expect(withZip("pack")).toBe("pack.zip");
    expect(withZip("Pack.ZIP")).toBe("Pack.ZIP");
  });
});

describe("Export my record", () => {
  const choice = { areas: ["code"], from: "2026-01-01", includeClosed: false, encrypt: false };
  const fakeRunner = (counts: Partial<Record<string, number>> = {}) => async (r: Req) => {
    const z = new ZipWriter(r.args.out as string);
    await z.add("a.txt", "plain zip content");
    await z.finish();
    return { files: 1, bytes: 10, entries: 3, skippedClosed: 2, excluded: 1, unreadable: 0, unsealed: 0, ...counts };
  };

  it("passes the choice and the open areas, and reports what was left out", async () => {
    const out = path.join(tmp(), "r.zip");
    const { s, calls } = services({ openSpaces: ["code", "life"], request: fakeRunner() });
    const n = notices();
    expect(await exportMyRecord(s, choice, n.say, { dialog: dialogTo(out) })).toBe(out);
    expect(calls[0]!.args).toMatchObject({ out, areas: ["code"], from: "2026-01-01", includeClosed: false, openSpaces: ["code", "life"] });
    expect(calls[0]!.args).not.toHaveProperty("to");
    expect(n.all.at(-1)).toBe(`${t("proof.exportDone", { n: 3, path: out })} ${t("proof.exportDoneLeft", { closed: 2, excluded: 1 })}`);
    expect(existsSync(out)).toBe(true);
  });

  it("says so when nothing matches, and mentions unreadable text", async () => {
    const n = notices();
    const a = services({ request: fakeRunner({ entries: 0 }) });
    expect(await exportMyRecord(a.s, choice, n.say, { dialog: dialogTo(path.join(tmp(), "e.zip")) })).toBeNull();
    expect(n.all.at(-1)).toBe(t("proof.exportEmpty"));
    const b = services({ request: fakeRunner({ unreadable: 2, skippedClosed: 0, excluded: 0 }) });
    const out = path.join(tmp(), "u.zip");
    await exportMyRecord(b.s, choice, n.say, { dialog: dialogTo(out) });
    expect(n.all.at(-1)).toBe(`${t("proof.exportDone", { n: 3, path: out })} ${t("proof.exportDoneUnreadable", { n: 2 })}`);
  });

  it("encrypts with the record key only when it is open, and replaces the plain file after a checked round trip", async () => {
    const key = new Uint8Array(32).map((_, i) => 200 - i);
    // not configured: the file stays plain
    const plainOut = path.join(tmp(), "plain.zip");
    const p = services({ request: fakeRunner() });
    expect(await exportMyRecord(p.s, { ...choice, encrypt: true }, notices().say, { dialog: dialogTo(plainOut) })).toBe(plainOut);
    expect(existsSync(plainOut)).toBe(true);
    // open key: encrypted
    setEncryptionConfigured(true);
    holdVaultKey(key);
    const out = path.join(tmp(), "enc.zip");
    const e = services({ request: fakeRunner() });
    const where = await exportMyRecord(e.s, { ...choice, encrypt: true }, notices().say, { dialog: dialogTo(out) });
    expect(where).toBe(`${out}.cortexenc`);
    expect(existsSync(out)).toBe(false);
    const bytes = readFileSync(where!);
    expect(bytes.includes(Buffer.from("plain zip content"))).toBe(false);
    const back = decryptExportBytes(bytes, key);
    expect(back).not.toBeNull();
    expect(Buffer.from(back!.subarray(0, 2)).toString()).toBe("PK");
  });
});

describe("commands and buttons", () => {
  it("registers the three commands and puts Audit pack and Export my record in the command bar", () => {
    for (const id of ["prove-entry", "audit-pack", "export-record"]) expect(COMMAND_IDS).toContain(id);
    expect(ACTION_REGISTRY.map((a) => a.id)).toEqual(expect.arrayContaining(["audit-pack", "export-record"]));
    expect(ACTION_REGISTRY.map((a) => a.id)).not.toContain("prove-entry");
  });

  it("shows Prove this entry in the date-evidence disclosure only when it can run", () => {
    const base: FactsGridProps = { speaker: "you", source: "claude-code", space: "code", evidence: [], confidence: "unknown", fmt: makeFmt("yyyy-MM-dd", 1), open: true };
    const html = render(<FactsGrid {...base} onProve={() => undefined} />);
    expect(html).toContain(t("proof.proveEntry"));
    expect(render(<FactsGrid {...base} />)).not.toContain(t("proof.proveEntry"));
    // closed disclosure shows nothing extra
    expect(render(<FactsGrid {...base} open={false} onProve={() => undefined} />)).not.toContain(t("proof.proveEntry"));
  });
});

