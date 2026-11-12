/**
 * Guide › Figure 1 of "How your record is kept": the pipeline drawn with live parts. Sources, Screen and Seal-and-date
 * stack on the left; the Vault holds a small constellation of the person's own record (one dot per area); the Keys box
 * draws one key glyph per share of the split key, named from the real holders; Checks, Export and Outcomes sit around
 * them, with Outcomes returning into the Vault; the Ledger bar shows the newest sealed blocks as squares, joined to the
 * seal step by a dashed "fingerprint only" link, with the anchor date at its end. A filled dot in a box's corner marks
 * a part this build has; a hollow one a part it does not. The figure is a picture for the eye (the step buttons below
 * it carry the keyboard and screen-reader path), so the svg is described once by its caption.
 */
import type { JSX } from "preact";
import { t } from "../../copy";
import type { CortexSettings } from "../../../shared/settings";
import { constellation, keyGlyphs, ledgerSquares, sourcesOn, type NodeId, type NodeView, type RecordFacts } from "./recordModel";

export interface RecordFigureProps {
  settings: CortexSettings;
  nodes: readonly NodeView[];
  facts: RecordFacts;
}

const W = 392;
const CAT = (n: number): string => `var(--cx-cat-${((n - 1) % 8) + 1})`;

/** The mini constellation of the record, drawn inside a w x h box at (x, y). Shared with Figure 2. */
export function ConstellationMark(p: { areas: RecordFacts["areas"]; x: number; y: number; w: number; h: number }): JSX.Element {
  const c = constellation(p.areas ?? [], p.w, p.h);
  if (c.dots.length === 0) {
    // No record yet: a faint, hollow sketch so the box does not look broken.
    const hollow = [
      [0.15, 0.6],
      [0.35, 0.25],
      [0.55, 0.7],
      [0.75, 0.3],
      [0.9, 0.65],
    ] as const;
    return (
      <g class="cx-fig-const is-empty" transform={`translate(${p.x} ${p.y})`}>
        {hollow.map(([fx, fy], i) => (
          <circle cx={fx * p.w} cy={fy * p.h} r={3} class="cx-fig-hollow" key={i} />
        ))}
      </g>
    );
  }
  return (
    <g class="cx-fig-const" transform={`translate(${p.x} ${p.y})`}>
      {c.links.map((l) => (
        <line x1={c.dots[l.a]?.x} y1={c.dots[l.a]?.y} x2={c.dots[l.b]?.x} y2={c.dots[l.b]?.y} class="cx-fig-link" key={`${l.a}-${l.b}`} />
      ))}
      {c.dots.map((d) => (
        <circle cx={d.x} cy={d.y} r={d.r} fill={CAT(d.hue)} key={d.key} />
      ))}
    </g>
  );
}

function Box(p: { x: number; y: number; w: number; h: number; title: string; line?: string; built: boolean; dashed?: boolean; node?: NodeId }): JSX.Element {
  return (
    <g class={`cx-fig-box${p.dashed ? " is-dashed" : ""}`} data-fig-box={p.node}>
      <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={6} />
      <text x={p.x + 10} y={p.y + 19} class="cx-fig-title">
        {p.title}
      </text>
      {p.line ? (
        <text x={p.x + 10} y={p.y + p.h - 10} class="cx-fig-line">
          {p.line}
        </text>
      ) : null}
      <circle cx={p.x + p.w - 12} cy={p.y + 12} r={4} class={p.built ? "cx-fig-built" : "cx-fig-hollow"} />
    </g>
  );
}

function Arrow(p: { d: string; accent?: boolean; dashed?: boolean }): JSX.Element {
  return <path d={p.d} class={`cx-fig-arrow${p.accent ? " is-accent" : ""}${p.dashed ? " is-dashed" : ""}`} marker-end={p.accent ? "url(#cx-fig-head-accent)" : "url(#cx-fig-head)"} />;
}

export function RecordFigure(p: RecordFigureProps): JSX.Element {
  const node = (id: NodeId): NodeView | undefined => p.nodes.find((n) => n.id === id);
  const built = (id: NodeId): boolean => node(id)?.built ?? false;
  const f = p.facts;
  const num = (n: number): string => n.toLocaleString("en-US");
  const blocks = f.seals?.blocks ?? 0;
  const squares = ledgerSquares(blocks);
  const keys = keyGlyphs(f.shares);
  const split = f.shares !== undefined && f.shares.splitAt !== "";
  const entries = f.entries ?? 0;
  const sources = sourcesOn(p.settings);
  const r = p.settings.privacy.redact;
  const hidden = [r.secrets, r.emails, r.phones, r.personal, r.custom.length > 0].filter(Boolean).length;
  const keyStep = keys.length > 1 ? Math.min(46, 118 / (keys.length - 1)) : 46;
  return (
    <figure class="cx-rec-figure">
      <div class="cx-fig-scroll">
        <svg class="cx-fig" viewBox={`0 0 ${W} 428`} role="img" aria-label={t("guide.record.figure.label")} data-figure="record">
          <defs>
            <marker id="cx-fig-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" class="cx-fig-head" />
            </marker>
            <marker id="cx-fig-head-accent" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" class="cx-fig-head is-accent" />
            </marker>
          </defs>

          {/* in: sources, screen, then seal and date */}
          <Box x={8} y={8} w={110} h={50} title={t("guide.record.names.sources")} line={t("guide.record.figure.sourcesLive", { n: sources })} built={built("sources")} node="sources" />
          <Box x={140} y={8} w={110} h={50} title={t("guide.record.names.screen")} line={hidden > 0 ? t("guide.record.figure.screenLive", { n: hidden }) : t("guide.record.figure.screenNone")} built={built("screen")} node="screen" />
          <Box x={262} y={8} w={90} h={50} title={t("guide.record.figure.sealDate")} line={blocks > 0 ? t("guide.record.figure.sealLive", { n: num(blocks) }) : t("guide.record.figure.sealNone")} built={built("seal")} node="seal" />
          <Arrow d="M118 33 H138" />
          <Arrow d="M250 33 H260" />

          {/* this computer */}
          <g class="cx-fig-host">
            <rect x={8} y={74} width={344} height={198} rx={10} />
            <text x={18} y={90} class="cx-fig-title">
              {t("guide.record.figure.computer")}
            </text>
            <text x={344} y={90} class="cx-fig-tiny is-end">
              {t("guide.record.figure.computerNote")}
            </text>
          </g>
          <Arrow d="M307 58 V104" />

          <Box x={192} y={100} w={152} h={112} title={t("guide.record.names.vault")} built={built("vault")} node="vault" />
          <ConstellationMark areas={f.areas} x={200} y={124} w={136} h={62} />
          <text x={202} y={204} class="cx-fig-line">
            {entries > 0 ? t("guide.record.figure.vaultLive", { n: num(entries) }) : t("guide.record.figure.vaultNone")}
          </text>

          <Box x={16} y={100} w={156} h={112} title={t("guide.record.names.keys")} built={built("keys")} node="keys" />
          <g class="cx-fig-keys">
            {keys.map((k, i) => {
              const cx = 36 + i * keyStep;
              const colour = CAT([2, 1, 7, 3, 5][i] ?? 1);
              return (
                <g key={k.share} data-share={k.share} class={k.holder ? "is-named" : "is-open"}>
                  <circle cx={cx} cy={148} r={6} fill={k.holder ? colour : "none"} stroke={colour} stroke-width={2} stroke-dasharray={k.holder ? undefined : "2 2"} />
                  <path d={`M${cx + 6} 148 H${cx + 15} M${cx + 11} 148 V153`} stroke={colour} stroke-width={2} fill="none" />
                  <text x={cx - 8} y={170} class="cx-fig-tiny">
                    {(k.holder ?? t("guide.record.figure.share", { n: k.share })).slice(0, 8)}
                  </text>
                </g>
              );
            })}
          </g>
          <text x={26} y={204} class="cx-fig-line">
            {split && f.shares ? t("guide.record.figure.keysSplit", { threshold: f.shares.threshold, total: f.shares.total }) : t("guide.record.figure.keysNotSplit")}
          </text>

          <Box x={192} y={222} w={152} h={40} title={t("guide.record.names.checks")} line={f.checksOpen && f.checksOpen > 0 ? t("guide.record.figure.checksLive", { n: num(f.checksOpen) }) : t("guide.record.figure.checksNone")} built={built("checks")} node="checks" />
          <Arrow d="M268 212 V220" />
          <Box x={16} y={222} w={156} h={40} title={t("guide.record.names.outcomes")} line={t("guide.record.figure.outcomesNote")} built={built("outcomes")} dashed node="outcomes" />
          {/* outcomes return into the vault as new dated entries */}
          <Arrow d="M172 242 H182 V156 H190" accent />

          {/* out: an export leaves only through the edge, by choice */}
          <Box x={192} y={284} w={152} h={40} title={t("guide.record.names.export")} line={t("guide.record.figure.exportNote")} built={built("export")} dashed node="export" />
          <Arrow d="M344 156 H358 V304 H346" />

          {/* the ledger bar */}
          <g class="cx-fig-box">
            <rect x={8} y={344} width={344} height={76} rx={6} />
            <text x={18} y={362} class="cx-fig-title">
              {t("guide.record.figure.ledger")}
            </text>
            <text x={344} y={362} class="cx-fig-line is-end">
              {blocks > 0 ? t("guide.record.figure.sealLive", { n: num(blocks) }) : t("guide.record.figure.ledgerNone")}
            </text>
          </g>
          <g class="cx-fig-blocks">
            {squares.map((q, i) => {
              const x = 18 + i * 41;
              return q.n === null ? (
                <rect x={x} y={370} width={32} height={22} rx={3} class="cx-fig-empty-block" key={i} />
              ) : (
                <rect x={x} y={370} width={32} height={22} rx={3} fill={CAT(q.n)} key={i} data-block={q.n}>
                  <title>{t("guide.record.figure.block", { n: q.n })}</title>
                </rect>
              );
            })}
          </g>
          <text x={18} y={410} class="cx-fig-line">
            {f.seals?.anchoredAt ? t("guide.record.figure.anchored", { date: f.date(f.seals.anchoredAt) }) : t("guide.record.figure.notAnchored")}
          </text>
          <circle cx={338} cy={406} r={4} class={built("anchor") ? "cx-fig-built" : "cx-fig-hollow"} />

          {/* only a fingerprint of a sealed block goes down to the ledger */}
          <path d="M352 33 H372 V382 H354" class="cx-fig-arrow is-dashed" marker-end="url(#cx-fig-head)" />
          <text transform="translate(383 200) rotate(-90)" class="cx-fig-tiny is-mid">
            {t("guide.record.figure.fingerprintOnly")}
          </text>
        </svg>
      </div>
      <figcaption class="cx-note">{t("guide.record.figure.caption")}</figcaption>
    </figure>
  );
}
