/**
 * Guide › "How your record is kept": the ten steps of the diagram and what each says right now (pure; no Preact).
 *
 * The path is Sources, Screen, Seal, Date, Anchor; beside it Vault, Keys, Checks, Outcomes, Export. Every node has
 * a status (on this computer / optional / needs consent / not offered), a built flag (a filled or hollow dot) and a
 * live line read from the settings and a few facts the page loads (seal blocks, open checks, entries kept). Nothing
 * here is invented: a step that this build does not have says so, in `gaps` and in a hollow dot.
 *
 * BUILT lists the later security features. It is the one place that says which exist; flip a flag only when the
 * code, its settings and its tests have landed. Their live lines read `settings.record` when it exists.
 */
import type { CortexSettings } from "../../../shared/settings";
import type { CopyKey } from "../../copy";

export const NODE_IDS = ["sources", "screen", "seal", "date", "anchor", "vault", "keys", "checks", "outcomes", "export"] as const;
export type NodeId = (typeof NODE_IDS)[number];
/** The five steps a record passes through, then the five that sit beside the path. */
export const PATH_NODES: readonly NodeId[] = ["sources", "screen", "seal", "date", "anchor"];
export const SIDE_NODES: readonly NodeId[] = ["vault", "keys", "checks", "outcomes", "export"];

export type NodeStatus = "local" | "optional" | "consent" | "notOffered";
export const STATUS_ORDER: readonly NodeStatus[] = ["local", "optional", "consent", "notOffered"];
export const STATUS_COPY: Readonly<Record<NodeStatus, CopyKey>> = {
  local: "guide.record.legendLocal",
  optional: "guide.record.legendOptional",
  consent: "guide.record.legendConsent",
  notOffered: "guide.record.legendNotOffered",
};

/** What this build ships of the later security features (see file header). */
export interface BuiltFeatures {
  encryption: boolean;
  keyShares: boolean;
  signing: boolean;
  proofExport: boolean;
  outcomes: boolean;
}
export const BUILT: BuiltFeatures = { encryption: false, keyShares: false, signing: true, proofExport: true, outcomes: true };

/** Facts the page loads; null = not known (sample record, runner not ready). */
export interface RecordFacts {
  seals: { blocks: number; entries: number; intact: boolean; anchoredAt?: string } | null;
  /** Entries in the index. */
  entries: number | null;
  /** Checks waiting for a yes or no. */
  checksOpen: number | null;
  /** Entries per area, for the mini constellation (the figure's picture of the record); empty or absent = none yet. */
  areas?: readonly { key: string; n: number }[];
  /** The split-key settings (`settings.record.shares`) the key glyphs read. */
  shares?: { threshold: number; total: number; holders: readonly { share: number; name: string }[]; splitAt: string };
  /** The person's date format applied to an ISO date. */
  date: (iso: string) => string;
}

export interface NodeAction {
  label: CopyKey;
  kind: "settings" | "checks";
  /** For "settings": the section to open. */
  section?: "privacy" | "advanced" | "lock" | "sources";
}

export interface NodeView {
  id: NodeId;
  name: CopyKey;
  what: CopyKey;
  status: NodeStatus;
  built: boolean;
  /** The live line, already filled in. */
  state: string;
  /** Parts of this step this build does not have, already worded. */
  gaps: string[];
  action?: NodeAction;
}

export type RecordTab = "recorded" | "leaves" | "who" | "dated";
export const RECORD_TABS: readonly RecordTab[] = ["recorded", "leaves", "who", "dated"];
export const TAB_COPY: Readonly<Record<RecordTab, { title: CopyKey; body: CopyKey }>> = {
  recorded: { title: "guide.record.tabs.recorded", body: "guide.record.tabBody.recorded" },
  leaves: { title: "guide.record.tabs.leaves", body: "guide.record.tabBody.leaves" },
  who: { title: "guide.record.tabs.who", body: "guide.record.tabBody.who" },
  dated: { title: "guide.record.tabs.dated", body: "guide.record.tabBody.dated" },
};
/** The steps each question is about; the rest of the diagram dims. */
export const TAB_NODES: Readonly<Record<RecordTab, readonly NodeId[]>> = {
  recorded: ["sources", "screen", "vault"],
  leaves: ["screen", "checks", "anchor", "export"],
  who: ["keys", "vault", "export"],
  dated: ["seal", "date", "anchor"],
};

type Tr = (key: CopyKey, values?: Record<string, string | number>) => string;

/** Read a later feature's setting (`settings.record.…`) without assuming it exists. */
export function peek(settings: unknown, path: string): unknown {
  let node: unknown = settings;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** How many sources are switched on. */
export function sourcesOn(s: CortexSettings): number {
  const src = s.sources;
  const flags = [src.vault.enabled, src.raw.enabled, src.claudeCode.enabled, src.claudeAi.enabled, src.chatgpt.enabled, src.gemini.enabled, src.written.enabled];
  return flags.filter(Boolean).length + src.folders.filter((f) => f.enabled).length;
}

function screenKinds(s: CortexSettings, tr: Tr): string[] {
  const r = s.privacy.redact;
  const out: string[] = [];
  if (r.secrets) out.push(tr("guide.record.state.screenSecrets"));
  if (r.emails) out.push(tr("guide.record.state.screenEmails"));
  if (r.phones) out.push(tr("guide.record.state.screenPhones"));
  if (r.personal) out.push(tr("guide.record.state.screenPersonal"));
  if (r.custom.length > 0) out.push(tr("guide.record.state.screenCustom"));
  return out;
}

/** The ten nodes, in diagram order, for these settings and facts. */
export function recordNodes(s: CortexSettings, f: RecordFacts, tr: Tr, built: BuiltFeatures = BUILT): NodeView[] {
  const sealing = s.advanced.dateSeals.sealLocally;
  const lockSet = s.privacy.lock.hash !== "";
  const encryptionOn = peek(s, "record.encryption.enabled") === true;
  const kinds = screenKinds(s, tr);
  const sources = sourcesOn(s);

  const sealState = !sealing
    ? tr("guide.record.state.sealOff")
    : f.seals === null
      ? tr("guide.record.state.sealOnUnknown")
      : f.seals.blocks === 0
        ? tr("guide.record.state.sealOnNone")
        : f.seals.intact
          ? tr("guide.record.state.sealOn", { n: f.seals.blocks })
          : tr("guide.record.state.sealBroken", { n: f.seals.blocks });
  const sealGaps = built.signing ? [] : [tr("guide.record.gap.signing")];

  const keysState = lockSet
    ? s.privacy.lock.autoLockMinutes > 0
      ? tr("guide.record.state.keysSet", { m: s.privacy.lock.autoLockMinutes })
      : tr("guide.record.state.keysSetNever")
    : tr("guide.record.state.keysNone");
  const keysLines = [keysState];
  if (built.encryption) keysLines.push(tr(encryptionOn ? "guide.record.state.encOn" : "guide.record.state.encOff"));
  const keysGaps: string[] = [];
  if (!built.encryption) keysGaps.push(tr("guide.record.gap.encryption"));
  if (!built.keyShares) keysGaps.push(tr("guide.record.gap.shares"));

  const exportGaps = built.proofExport ? [] : [tr("guide.record.gap.proof")];

  const node = (n: Omit<NodeView, "name" | "what" | "gaps"> & { gaps?: string[] }): NodeView => ({
    ...n,
    name: `guide.record.names.${n.id}` as CopyKey,
    what: `guide.record.what.${n.id}` as CopyKey,
    gaps: n.gaps ?? [],
  });

  return [
    node({
      id: "sources",
      status: "local",
      built: true,
      state: sources > 0 ? tr("guide.record.state.sourcesOn", { n: sources }) : tr("guide.record.state.sourcesNone"),
      action: { label: "guide.record.openSettings", kind: "settings", section: "sources" },
    }),
    node({
      id: "screen",
      status: kinds.length > 0 ? "local" : "optional",
      built: true,
      state: kinds.length > 0 ? [tr("guide.record.state.screenOn", { kinds: kinds.join(", ") }), s.privacy.keepSecretsLocal ? tr("guide.record.state.screenKept") : ""].filter(Boolean).join(" ") : tr("guide.record.state.screenOff"),
      action: { label: "guide.record.openSettings", kind: "settings", section: "privacy" },
    }),
    node({ id: "seal", status: sealing ? "local" : "optional", built: true, state: sealState, gaps: sealGaps, action: { label: "guide.record.openSettings", kind: "settings", section: "advanced" } }),
    node({
      id: "date",
      status: "local",
      built: true,
      state: f.seals !== null && f.seals.entries > 0 ? tr("guide.record.state.dateSealed", { n: f.seals.entries }) : tr("guide.record.state.dateNone"),
    }),
    node({
      id: "anchor",
      status: "consent",
      built: true,
      state: [
        f.seals?.anchoredAt ? tr("guide.record.state.anchorDone", { date: f.date(f.seals.anchoredAt) }) : tr("guide.record.state.anchorNone"),
        s.advanced.dateSeals.weeklyStamp ? tr("guide.record.state.anchorWeekly") : "",
      ]
        .filter(Boolean)
        .join(" "),
    }),
    node({
      id: "vault",
      status: "local",
      built: true,
      state: f.entries !== null && f.entries > 0 ? tr("guide.record.state.vaultCount", { n: f.entries.toLocaleString("en-US") }) : tr("guide.record.state.vaultNone"),
    }),
    node({ id: "keys", status: "optional", built: true, state: keysLines.join(". "), gaps: keysGaps, action: { label: "guide.record.openSettings", kind: "settings", section: "lock" } }),
    node({
      id: "checks",
      status: "local",
      built: true,
      state: f.checksOpen !== null && f.checksOpen > 0 ? tr("guide.record.state.checksOpen", { n: f.checksOpen }) : tr("guide.record.state.checksNone"),
      action: { label: "guide.record.openChecks", kind: "checks" },
    }),
    node({
      id: "outcomes",
      status: built.outcomes ? "optional" : "notOffered",
      built: built.outcomes,
      state: tr(built.outcomes ? "guide.record.state.outcomesOn" : "guide.record.state.outcomesOff"),
      gaps: built.outcomes ? [] : [tr("guide.record.gap.outcomes")],
    }),
    node({
      id: "export",
      status: "optional",
      built: true,
      state: tr(built.proofExport ? "guide.record.state.exportRecordOn" : "guide.record.state.exportLedger"),
      gaps: exportGaps,
    }),
  ];
}

/** Which node a key press moves to from `from`: Left/Right step along the order, Up/Down hop between the two rows. */
export function moveNode(from: NodeId, key: string): NodeId | null {
  const i = NODE_IDS.indexOf(from);
  const row = PATH_NODES.length;
  let j: number;
  if (key === "ArrowRight") j = (i + 1) % NODE_IDS.length;
  else if (key === "ArrowLeft") j = (i - 1 + NODE_IDS.length) % NODE_IDS.length;
  else if (key === "ArrowDown") j = i < row ? i + row : i;
  else if (key === "ArrowUp") j = i >= row ? i - row : i;
  else if (key === "Home") j = 0;
  else if (key === "End") j = NODE_IDS.length - 1;
  else return null;
  return NODE_IDS[j] ?? null;
}

/** The sentence a screen reader gets for a node (name, status, built, live line). */
export function nodeAriaLabel(n: NodeView, tr: Tr): string {
  return tr("guide.record.nodeLabel", {
    name: tr(n.name),
    status: tr(STATUS_COPY[n.status]),
    built: tr(n.built ? "guide.record.built" : "guide.record.notBuilt"),
    state: n.state,
  });
}

// ───────────────────────────── the figures: live parts (pure) ─────────────────────────────

/** Item kinds as the person knows them; one band of the by-year figure each. */
export const LAYER_KINDS = ["conversations", "documents", "passages", "files", "notes", "summaries", "maps"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

/** The band an index item kind (`ItemKind`, u8) belongs to; null for a kind this build does not draw. */
export function layerOf(kind: number): LayerKind | null {
  switch (kind) {
    case 0:
      return "conversations";
    case 1:
      return "documents";
    case 2:
      return "passages";
    case 3:
      return "files";
    case 10:
    case 11:
      return "notes";
    case 12:
      return "summaries";
    case 13:
      return "maps";
    default:
      return null;
  }
}

/** FNV-1a: a stable 32-bit number from text, so a figure draws the same every time for the same record. */
export function hash32(text: string, salt = 0): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h >>> 0;
}

export interface ConstellationDot {
  key: string;
  x: number;
  y: number;
  r: number;
  /** 1..8: which of the eight category colours. */
  hue: number;
}
export interface Constellation {
  dots: ConstellationDot[];
  links: { a: number; b: number }[];
}

/** One dot per area of the record (the biggest `max`), placed by a hash of its name, each joined to its nearest neighbours. */
export function constellation(areas: readonly { key: string; n: number }[], w: number, h: number, max = 14, pad = 6): Constellation {
  const top = areas
    .filter((a) => a.n > 0)
    .slice()
    .sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1))
    .slice(0, max);
  const biggest = top[0]?.n ?? 1;
  const dots: ConstellationDot[] = [];
  top.forEach((a, i) => {
    const r = 2 + 3 * Math.sqrt(a.n / biggest);
    let best = { x: 0, y: 0, gap: -1 };
    for (let attempt = 0; attempt < 10; attempt++) {
      const x = pad + (hash32(a.key, attempt * 2 + 1) / 0xffffffff) * (w - 2 * pad);
      const y = pad + (hash32(a.key, attempt * 2 + 2) / 0xffffffff) * (h - 2 * pad);
      const gap = dots.length === 0 ? Infinity : Math.min(...dots.map((d) => Math.hypot(d.x - x, d.y - y) - d.r - r));
      if (gap > best.gap) best = { x, y, gap };
      if (gap >= 10) break;
    }
    dots.push({ key: a.key, x: Math.round(best.x * 10) / 10, y: Math.round(best.y * 10) / 10, r: Math.round(r * 10) / 10, hue: (i % 8) + 1 });
  });
  const links: { a: number; b: number }[] = [];
  const seen = new Set<string>();
  dots.forEach((d, i) => {
    const near = dots
      .slice(0, i)
      .map((o, j) => ({ j, dist: Math.hypot(o.x - d.x, o.y - d.y) }))
      .sort((p, q) => p.dist - q.dist)
      .slice(0, i >= 3 ? 2 : 1);
    for (const n of near) {
      const id = `${n.j}-${i}`;
      if (!seen.has(id)) {
        seen.add(id);
        links.push({ a: n.j, b: i });
      }
    }
  });
  return { dots, links };
}

/** The squares of the ledger bar: the newest `max` sealed blocks (numbered), then empty places up to `max`. */
export function ledgerSquares(blocks: number, max = 8): { n: number | null }[] {
  const have = Math.max(0, Math.min(Math.floor(Number.isFinite(blocks) ? blocks : 0), 1e9));
  const shown = Math.min(have, max);
  return Array.from({ length: max }, (_, i) => (i < shown ? { n: have - shown + i + 1 } : { n: null }));
}

export interface KeyGlyph {
  share: number;
  /** The holder named for this share; null while nobody is. */
  holder: string | null;
}

/** The key glyphs: one per share (at most five), named from the real holders in the settings. */
export function keyGlyphs(shares: { total: number; holders: readonly { share: number; name: string }[] } | undefined, max = 5): KeyGlyph[] {
  const total = Math.max(0, Math.min(Math.floor(shares?.total ?? 0), max));
  return Array.from({ length: total }, (_, i) => {
    const h = shares?.holders.find((x) => x.share === i + 1);
    return { share: i + 1, holder: h && h.name.trim() !== "" ? h.name.trim() : null };
  });
}

export interface LayerPlot {
  /** Epoch ms of the first and last dated entry; both 0 when there is none. */
  first: number;
  last: number;
  /** Years with an axis label, evenly spread across the span. */
  ticks: { year: number; x: number }[];
  dated: number;
  undated: number;
  /** The bands that have entries, in LAYER_KINDS order. */
  bands: { kind: LayerKind; n: number }[];
  /** At most `maxDots` dots: x across the span (0..1), y inside the band (0..1), band index into `bands`. */
  dots: { x: number; y: number; band: number }[];
}

const FLAG_UNDATED = 1 << 0;
const FLAG_EXCLUDED = 1 << 1;
const FLAG_REFERENCE = 1 << 2;
const FLAG_HIDDEN = 1 << 3;

/** The by-year figure of a record from the index columns; hidden-by-default entries (reference, tool traffic) are not drawn. */
export function layerPlot(cols: { kind: ArrayLike<number>; t: ArrayLike<number>; flags: ArrayLike<number> }, count: number, maxDots = 1800): LayerPlot {
  const counts = new Map<LayerKind, number>();
  let first = Infinity;
  let last = -Infinity;
  let undated = 0;
  const keep: number[] = [];
  for (let i = 0; i < count; i++) {
    const f = cols.flags[i] ?? 0;
    if (f & (FLAG_EXCLUDED | FLAG_REFERENCE | FLAG_HIDDEN)) continue;
    const layer = layerOf(cols.kind[i] ?? -1);
    if (!layer) continue;
    const t = cols.t[i] ?? Number.NaN;
    if (f & FLAG_UNDATED || !Number.isFinite(t) || t <= 0) {
      undated++;
      continue;
    }
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
    first = Math.min(first, t);
    last = Math.max(last, t);
    keep.push(i);
  }
  const bands = LAYER_KINDS.filter((k) => counts.has(k)).map((kind) => ({ kind, n: counts.get(kind) ?? 0 }));
  if (keep.length === 0) return { first: 0, last: 0, ticks: [], dated: 0, undated, bands: [], dots: [] };
  const span = Math.max(last - first, 1);
  const step = Math.max(1, Math.ceil(keep.length / maxDots));
  const dots: LayerPlot["dots"] = [];
  for (let k = 0; k < keep.length; k += step) {
    const i = keep[k] as number;
    const band = bands.findIndex((b) => b.kind === layerOf(cols.kind[i] ?? -1));
    dots.push({ x: last === first ? 0.5 : ((cols.t[i] as number) - first) / span, y: hash32(String(i), 7) / 0xffffffff, band });
  }
  const y0 = new Date(first).getUTCFullYear();
  const y1 = new Date(last).getUTCFullYear();
  const every = Math.max(1, Math.ceil((y1 - y0 + 1) / 6));
  const ticks: LayerPlot["ticks"] = [];
  for (let y = y0; y <= y1; y += every) ticks.push({ year: y, x: last === first ? 0.5 : Math.min(1, Math.max(0, (Date.UTC(y, 0, 1) - first) / span)) });
  return { first, last, ticks, dated: keep.length, undated, bands, dots };
}

/** "5 years", "8 months" or "under a month": how long the dated part of the record runs. */
export function spanWords(first: number, last: number): { unit: "years" | "months" | "short"; n: number } {
  const months = Math.round((last - first) / (30.4375 * 86_400_000));
  if (months >= 24) return { unit: "years", n: Math.round(months / 12) };
  if (months >= 1) return { unit: "months", n: months };
  return { unit: "short", n: 0 };
}

/** Entries per area from the index columns (`order` names the area codes), leaving out excluded and hidden-by-default ones. */
export function areaCounts(cols: { space: ArrayLike<number>; flags: ArrayLike<number> }, count: number, order: readonly string[]): { key: string; n: number }[] {
  const by = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    if ((cols.flags[i] ?? 0) & (FLAG_EXCLUDED | FLAG_REFERENCE | FLAG_HIDDEN)) continue;
    const key = order[cols.space[i] ?? -1] ?? "none";
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by].map(([key, n]) => ({ key, n }));
}
