/**
 * "Audit pack": what a chosen person needs to check claims about the record WITHOUT opening any text. Owner:
 * proof-audit-export.
 *
 * Contents: the seal chain of every computer as block heads (no entry ids), the public timestamps with their .ots
 * files, the signing keys by fingerprint, the Access log as aggregates (which model, over which route, how many items
 * it read, first and last time), redaction counts per route and per run (how many spans were replaced before anything
 * was sent, how many lines were withheld), what this computer sent to timestamp services, a SHA-256 manifest of the
 * pack's own files, and the offline verifier page. No entry text, title, id, path or model prompt is in it.
 */
import type { IsoDate, ReadRecord } from "../shared/types";
import { readOutbound, type OutwardRow } from "./dateEvidence";
import type { StoreContext } from "./layout";
import type { LedgerStore } from "./ledger";
import { routeOf } from "./ledgerReader";
import { buildVerifierHtml, type VerifierStrings } from "./verifierPage";
import { fillText, gatherChain, jsonText, keysOf, sha256File, type PackComputer, type PackFile } from "./sealPack";

export interface AuditAccessRow {
  model: string;
  route: string;
  itemsRead: number;
  first: IsoDate;
  last: IsoDate;
}
export interface RedactionByRoute {
  route: string;
  model: string;
  reads: number;
  items: number;
  redactions: number;
  withheld: number;
}
export interface RedactionByRun {
  run: string;
  model: string;
  route: string;
  via: "job" | "ask";
  at: IsoDate;
  reads: number;
  items: number;
  redactions: number;
  withheld: number;
}

export interface AuditPack {
  format: "cortex-audit-pack";
  version: 1;
  createdAt: IsoDate;
  cortex?: string;
  computers: PackComputer[];
  keys: { publicKey: string; fingerprint: string; computer: string; firstBlock: number; blocks: number }[];
  seals: { computers: number; blocks: number; entries: number; firstAt?: IsoDate; lastAt?: IsoDate; damaged: string[]; stampsWithoutSalt: number };
  access: AuditAccessRow[];
  redactions: { reads: number; items: number; redactions: number; withheld: number; byRoute: RedactionByRoute[]; byRun: RedactionByRun[]; byRunShown: number };
  outward: (OutwardRow & { computer: string })[];
  /** SHA-256 of every other file of the pack except this one and verify.html, which embeds it. */
  files: { path: string; bytes: number; sha256: string }[];
}

/** Runs listed individually; the aggregate by route always covers every read. */
export const AUDIT_RUNS_MAX = 5000;

export async function buildAuditPack(ctx: StoreContext, ledger: LedgerStore, strings: VerifierStrings, opts: { now?: () => number; cortexVersion?: string } = {}): Promise<{ audit: AuditPack; files: PackFile[] }> {
  const now = opts.now ?? Date.now;
  const chain = await gatherChain(ctx);

  const access = new Map<string, AuditAccessRow>();
  const byRoute = new Map<string, RedactionByRoute>();
  const byRun = new Map<string, RedactionByRun>();
  const total = { reads: 0, items: 0, redactions: 0, withheld: 0 };
  for await (const r of ledger.readAll("reads") as AsyncIterable<ReadRecord>) {
    const route = routeOf(r.engine, r.where);
    const items = (r.entryIds?.length ?? 0) + (r.noteIds?.length ?? 0);
    const red = Number.isFinite(r.redactions) ? r.redactions : 0;
    const wh = Number.isFinite(r.withheld) ? r.withheld : 0;
    total.reads++;
    total.items += items;
    total.redactions += red;
    total.withheld += wh;
    const ak = `${r.model}\u0000${route}`;
    const a = access.get(ak);
    if (!a) access.set(ak, { model: r.model, route, itemsRead: items, first: r.at, last: r.at });
    else {
      a.itemsRead += items;
      if (r.at < a.first) a.first = r.at;
      if (r.at > a.last) a.last = r.at;
    }
    const rt = byRoute.get(ak);
    if (!rt) byRoute.set(ak, { route, model: r.model, reads: 1, items, redactions: red, withheld: wh });
    else {
      rt.reads++;
      rt.items += items;
      rt.redactions += red;
      rt.withheld += wh;
    }
    const rn = byRun.get(r.runId);
    if (!rn) byRun.set(r.runId, { run: r.runId, model: r.model, route, via: r.via, at: r.at, reads: 1, items, redactions: red, withheld: wh });
    else {
      rn.reads++;
      rn.items += items;
      rn.redactions += red;
      rn.withheld += wh;
      if (r.at < rn.at) rn.at = r.at;
    }
  }
  const runs = [...byRun.values()].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));

  const outward: (OutwardRow & { computer: string })[] = [];
  for (const c of chain.computers) for (const row of await readOutbound(ctx.vaultRoot, c.computer)) outward.push({ ...row, computer: c.computer });

  const all = chain.computers.flatMap((c) => c.blocks);
  const sorted = [...all].sort((a, b) => (a.at < b.at ? -1 : 1));
  const companions: PackFile[] = [{ name: "README.txt", data: fillText(strings.readmeAudit, { computers: chain.computers.length, blocks: all.length }) }, ...chain.anchors];
  const audit: AuditPack = {
    format: "cortex-audit-pack",
    version: 1,
    createdAt: new Date(now()).toISOString(),
    ...(opts.cortexVersion ? { cortex: opts.cortexVersion } : {}),
    computers: chain.computers,
    keys: keysOf(chain.computers),
    seals: {
      computers: chain.computers.length,
      blocks: all.length,
      entries: all.reduce((a, b) => a + b.count, 0),
      ...(sorted[0] ? { firstAt: sorted[0].at } : {}),
      ...(sorted.length ? { lastAt: sorted[sorted.length - 1]!.at } : {}),
      damaged: chain.damaged,
      stampsWithoutSalt: chain.stampsWithoutSalt,
    },
    access: [...access.values()].sort((a, b) => b.itemsRead - a.itemsRead || (a.model < b.model ? -1 : 1)),
    redactions: { ...total, byRoute: [...byRoute.values()].sort((a, b) => b.redactions - a.redactions || (a.route < b.route ? -1 : 1)), byRun: runs.slice(0, AUDIT_RUNS_MAX), byRunShown: Math.min(runs.length, AUDIT_RUNS_MAX) },
    outward,
    files: companions.map((f) => ({ path: f.name, bytes: typeof f.data === "string" ? Buffer.byteLength(f.data, "utf8") : f.data.length, sha256: sha256File(f.data) })),
  };
  const json = jsonText(audit);
  return { audit, files: [companions[0] as PackFile, { name: "verify.html", data: buildVerifierHtml(strings, { name: "audit.json", json }) }, { name: "audit.json", data: json }, ...companions.slice(1)] };
}
