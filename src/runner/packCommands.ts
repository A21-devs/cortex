/**
 * Runner commands behind "Prove this entry", "Audit pack" and "Export my record". Each writes one zip at a path the
 * person chose and answers with counts only (SAFE-17: no record text in a frame). Owner: proof-audit-export.
 */
import * as path from "node:path";
import { effectiveOpenSpaces, expandSpaces, liveGrants } from "../shared/consent";
import { CortexError } from "../shared/errors";
import { localDayKey } from "../shared/time";
import { buildAuditPack } from "../store/auditPack";
import { exportRecord } from "../store/exportRecord";
import { buildEntryProof, proofPackFiles } from "../store/proof";
import { gatherChain, writePack } from "../store/sealPack";
import { VERIFIER_KEYS, type VerifierStrings } from "../store/verifierPage";
import type { StoreContext } from "../store/layout";
import type { LedgerStore } from "../store/ledger";
import type { CommandHandlers, RequestContext } from "./host";

type Open = (rc: RequestContext) => Promise<{ store: StoreContext; ledger: LedgerStore }>;

const bad = (why: string): CortexError => new CortexError("E_BAD_REQUEST", "bad request", { detail: { reason: why } });
const MAX_TEXT = 40_000;

/** The pages' text from the plugin: every key present, plain strings, bounded. */
export function checkStrings(raw: unknown): VerifierStrings {
  if (raw === null || typeof raw !== "object") throw bad("strings");
  const o = raw as Record<string, unknown>;
  for (const k of VERIFIER_KEYS) if (typeof o[k] !== "string" || (o[k] as string).length > MAX_TEXT) throw bad("strings");
  return o as unknown as VerifierStrings;
}

/** Where a pack may be written: an absolute .zip path outside .obsidian and the record's own folders. */
export function checkOut(out: unknown, rc: RequestContext): string {
  if (typeof out !== "string" || !path.isAbsolute(out) || out.length > 1000 || !/\.zip$/i.test(out) || out.includes("\0")) throw bad("out");
  const abs = path.resolve(out);
  const inside = (dir: string): boolean => {
    const rel = path.relative(path.resolve(dir), abs);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const vault = rc.ctx.vaultRoot;
  if (inside(path.join(vault, ".obsidian")) || inside(path.join(vault, ".vault-meta")) || inside(rc.ctx.cacheDir)) throw new CortexError("E_PATH_DENIED", "that location is not allowed", { detail: { reason: "pack-location" } });
  return abs;
}

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function packHandlers(open: Open): Pick<CommandHandlers, "proof.entry" | "audit.pack" | "export.record"> {
  return {
    "proof.entry": async (args, rc) => {
      const strings = checkStrings(args.strings);
      const out = checkOut(args.out, rc);
      if (typeof args.id !== "string" || !/^e_[a-z2-7]{16}$/.test(args.id)) throw bad("id");
      const { store, ledger } = await open(rc);
      const proof = await buildEntryProof(store, ledger, args.id, { sealFirst: rc.ctx.settings.advanced.dateSeals.sealLocally });
      const w = await writePack(out, proofPackFiles(proof, strings));
      return { ...w, block: proof.block.n, stamped: proof.timestamp !== undefined, confirmed: proof.timestamp?.bitcoin !== undefined };
    },

    "audit.pack": async (args, rc) => {
      const strings = checkStrings(args.strings);
      const out = checkOut(args.out, rc);
      const { store, ledger } = await open(rc);
      const { audit, files } = await buildAuditPack(store, ledger, strings, { cortexVersion: rc.ctx.pluginVersion });
      const w = await writePack(out, files);
      return { ...w, blocks: audit.seals.blocks, anchors: (await gatherChain(store)).anchors.length };
    },

    "export.record": async (args, rc) => {
      const strings = checkStrings(args.strings);
      const out = checkOut(args.out, rc);
      if (!Array.isArray(args.areas) || !args.areas.every((a) => typeof a === "string" && a.length <= 60) || args.areas.length > 64) throw bad("areas");
      if ((args.from !== undefined && !isDay(args.from)) || (args.to !== undefined && !isDay(args.to))) throw bad("period");
      if (!Array.isArray(args.openSpaces) || !args.openSpaces.every((a) => typeof a === "string") || args.openSpaces.length > 2000) throw bad("open");
      const settings = rc.ctx.settings;
      // Consent: an export is a read like a model's. With "Require a grant" on it needs a live grant naming exports, and
      // only what that grant covers (and is open) goes in; closed spaces cannot be added back.
      const consent = settings.consent;
      let includeClosed = args.includeClosed === true;
      let grant: string | undefined;
      let within: string[] | undefined;
      let maxEntries: number | undefined;
      if (consent.requireGrant) {
        const g = liveGrants(consent, "export", localDayKey(Date.now()))[0];
        if (!g) throw new CortexError("E_PAUSED", "no grant lets an export read the record", { detail: { reason: "no-grant" } });
        grant = g.id;
        within = expandSpaces(g.spaces, settings.userSpaces);
        includeClosed = false;
        if (g.readLimit > 0) maxEntries = Math.max(0, g.readLimit - g.reads);
      }
      const openSpaces = [...new Set([...args.openSpaces, ...effectiveOpenSpaces(consent, settings.userSpaces)])];
      const { store, ledger } = await open(rc);
      const r = await exportRecord(store, ledger, out, strings, {
        areas: args.areas,
        ...(args.from !== undefined ? { from: args.from } : {}),
        ...(args.to !== undefined ? { to: args.to } : {}),
        includeClosed,
        openSpaces,
        ...(within !== undefined ? { within } : {}),
        ...(maxEntries !== undefined ? { maxEntries } : {}),
        cortexVersion: rc.ctx.pluginVersion,
      });
      return { files: r.files, bytes: r.bytes, entries: r.entries, skippedClosed: r.skippedClosed, excluded: r.excluded, unreadable: r.unreadable, unsealed: r.unsealed, ...(grant !== undefined ? { grant } : {}) };
    },
  };
}
