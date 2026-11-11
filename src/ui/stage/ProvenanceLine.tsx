/**
 * The stage's one-line provenance status (SPEC F43, V1.3): hovering or selecting a record entry says how many notes are
 * built from it; hovering or selecting a note or a hub says how many record entries it is built from and that they all
 * sit in the spine beneath the brain. A hover wins over the selection; with neither, or with nothing to say, no line.
 * Owner: E11.
 */
import type { JSX } from "preact";
import { useMemo } from "preact/hooks";
import { provenanceOf, type Provenance } from "../../shared/hoverModel";
import { num, useLeaf, useServices } from "../context";
import { t } from "../copy";

/** The sentence for a provenance, or null when there is none. */
export function provenanceText(p: Provenance | null): string | null {
  if (!p) return null;
  if (p.kind === "entry") return p.notes === 1 ? t("hover.sourceOfOne") : t("hover.sourceOfMany", { n: num(p.notes) });
  return p.entries === 1 ? t("hover.builtOne") : t("hover.builtMany", { n: num(p.entries) });
}

/** The current provenance sentence (hover first, then the selection), or null; the rail's status stack shows it. */
export function useProvenanceText(): string | null {
  const s = useServices();
  const leaf = useLeaf();
  const hover = leaf.store.slices.hover.value;
  const sel = leaf.store.slices.selection.value;
  const idx = s.index.index.value;
  const ordinal = hover ? hover.ordinal : sel ? sel.ordinal : -1;
  return useMemo(() => (idx && ordinal >= 0 ? provenanceText(provenanceOf(idx, ordinal)) : null), [idx, ordinal]);
}

export function ProvenanceLine(): JSX.Element | null {
  const text = useProvenanceText();
  if (!text) return null;
  return <p class="cx-provenance">{text}</p>;
}
