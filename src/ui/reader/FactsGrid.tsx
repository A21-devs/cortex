/**
 * Provenance as a compact facts grid at the top of the entry reader (CORTEX-UX §5.14; ORIG-12): Speaker · Source ·
 * Project · Area on two half-width rows, then Written · Imported · Date (a confidence pill and the link "How this
 * date is known", which expands one line per piece of evidence with its strength). Never "‹X›'s words". Owner: E12.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { EntryDetail } from "../../plugin/services";
import type { Speaker } from "../../shared/types";
import { t } from "../copy";
import type { Fmt } from "../pages/PageFrame";
import { AreaDot, SourceIcon, SpeakerMarker } from "./marks";
import { sourceLabel, speakerLabel } from "../valueLabels";

export interface Fact {
  key: "speaker" | "source" | "project" | "area" | "written" | "imported" | "dateConfidence";
  value: string;
}

export type Confidence = "strong" | "medium" | "bound" | "unknown";

const RANK: Readonly<Record<string, number>> = { strong: 3, medium: 2, provable: 1, bound: 1, weak: 0 };

/** The Date pill: the strongest evidence behind the written date; Unknown when the entry has no date of its own. */
export function dateConfidence(writtenAt: string | undefined, evidence: EntryDetail["dateEvidence"]): Confidence {
  if (!writtenAt) return "unknown";
  let best = -1;
  for (const e of evidence) best = Math.max(best, RANK[e.strength] ?? -1);
  return best >= 3 ? "strong" : best === 2 ? "medium" : best >= 0 ? "bound" : "unknown";
}

/** One line per piece of evidence (§5.14 Date evidence). */
export function evidenceLine(e: EntryDetail["dateEvidence"][number], source: string, fmt: Fmt): string {
  const date = fmt.date(Date.parse(e.at));
  switch (e.kind) {
    case "source":
      return t("reader.evSource", { source: sourceLabel(source) });
    case "imported":
      return t("reader.evImported", { date });
    case "git":
      return t("reader.evGit", { date });
    case "sealed":
      return e.block !== undefined ? t("reader.evSealed", { n: e.block }) : t("reader.evSealedOn", { date });
    case "timestamped":
      return e.height !== undefined ? t("reader.evConfirmed", { height: String(e.height), date }) : t("reader.evPublic", { date });
  }
}

const PILL: Readonly<Record<Confidence, "reader.strong" | "reader.medium" | "reader.bound" | "reader.unknown">> = {
  strong: "reader.strong",
  medium: "reader.medium",
  bound: "reader.bound",
  unknown: "reader.unknown",
};

export interface FactsGridProps {
  speaker: Speaker;
  model?: string;
  source: string;
  project?: string;
  space: string;
  written?: number;
  imported?: number;
  evidence: EntryDetail["dateEvidence"];
  confidence: Confidence;
  fmt: Fmt;
  /** Open the evidence lines from the start (tests, deep links). */
  open?: boolean;
  /** "Prove this entry": saves a proof folder for this entry. Left out in the sample record. */
  onProve?: () => void;
}

export function FactsGrid(p: FactsGridProps): JSX.Element {
  const [open, setOpen] = useState(p.open === true);
  const dash = t("agents.none");
  return (
    <div class="cx-facts-card">
      <dl class="cx-facts">
        <div class="cx-fact is-half">
          <dt>{t("reader.speaker")}</dt>
          <dd>
            <SpeakerMarker speaker={p.speaker} /> {speakerLabel(p.speaker, p.model)}
          </dd>
        </div>
        <div class="cx-fact is-half">
          <dt>{t("reader.source")}</dt>
          <dd>
            <SourceIcon source={p.source} label />
          </dd>
        </div>
        <div class="cx-fact is-half">
          <dt>{t("reader.project")}</dt>
          <dd>{p.project ?? dash}</dd>
        </div>
        <div class="cx-fact is-half">
          <dt>{t("reader.area")}</dt>
          <dd>
            <AreaDot space={p.space} />
          </dd>
        </div>
        <div class="cx-fact">
          <dt>{t("reader.written")}</dt>
          <dd class="cx-mono">{p.written !== undefined && Number.isFinite(p.written) ? p.fmt.dateTime(p.written) : t("reader.noDate")}</dd>
        </div>
        <div class="cx-fact">
          <dt>{t("reader.imported")}</dt>
          <dd class="cx-mono">{p.imported !== undefined && Number.isFinite(p.imported) ? p.fmt.dateTime(p.imported) : dash}</dd>
        </div>
        <div class="cx-fact">
          <dt>{t("reader.dateConfidence")}</dt>
          <dd>
            <span class={`cx-confidence is-${p.confidence}`}>{t(PILL[p.confidence])}</span>
            <button type="button" class="cx-text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? t("reader.hideEvidence") : t("reader.dateKnown")}
            </button>
          </dd>
        </div>
      </dl>
      {open ? (
        <>
          <ul class="cx-evidence-list" aria-label={t("reader.dateKnown")}>
            {p.evidence.length === 0 ? <li class="cx-note">{t("reader.noEvidence")}</li> : p.evidence.map((e) => <li>{evidenceLine(e, p.source, p.fmt)}</li>)}
          </ul>
          {p.onProve ? (
            <button type="button" class="cx-text-button cx-prove-entry" title={t("proof.proveEntryDesc")} onClick={p.onProve}>
              {t("proof.proveEntry")}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
