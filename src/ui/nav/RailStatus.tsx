/**
 * Rail status (Cortex Desktop and plugin): the lines above the meters. Desktop shows what the header's chips said
 * (Checking for changes… / Indexing, "Live", held arrivals, the agent state; each is the header's own component,
 * restyled flat by the rail's CSS). Both hosts show the status stack (RAIL-47): one bottom-anchored column that
 * grows upward from the meters, holding the provenance line, the persistent "lit" line (RAIL-43), the transient
 * "no longer lit" line (RAIL-44) and the notices the shell posts (the auto-adjust notice, RAIL-46 / TB-10). When the
 * rail is hidden the stage mounts the same stack at its bottom-left. Removal is immediate: no ghost frame.
 * Owner: shell track.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { QueryToken } from "../../shared/protocol/worker";
import { clearTokens } from "../../state/actions";
import { highlightTokens, litSummary, type LitSummary } from "../../state/selectors";
import type { CortexStore } from "../../state/store";
import { indexCounts, num, useLeaf, useServices, useShell, type StatusLine } from "../context";
import { t } from "../copy";
import { AgentChip } from "../header/AgentChip";
import { ArrivalsPill } from "../header/ArrivalsPill";
import { LiveChip } from "../header/LiveChip";
import { isDesktopHost } from "../host";
import { LoadingChip } from "../stage/LoadingLines";
import { useProvenanceText } from "../stage/ProvenanceLine";

/** How long the "no longer lit" line stays. */
export const UNLIT_TTL_MS = 4000;
/** How long the shell waits for the lit count to settle before it reports a removal. */
export const UNLIT_SETTLE_MS = 250;

/** The persistent line for the current highlights, or null with none (the newest one is named). */
export function litLine(tokens: readonly Pick<QueryToken, "label">[]): string | null {
  const last = tokens[tokens.length - 1];
  if (!last) return null;
  return tokens.length === 1 ? t("rail.litOne", { label: last.label }) : t("rail.litMany", { label: last.label, n: num(tokens.length - 1) });
}

/** The highlight tokens that were in `prev` and are gone from `next` (by id). */
export function removedHighlights<T extends { id: string }>(prev: readonly T[], next: readonly { id: string }[]): T[] {
  const keep = new Set(next.map((k) => k.id));
  return prev.filter((k) => !keep.has(k.id));
}

/** The line reporting dropped highlights with the entry count now shown, or null when nothing was dropped. */
export function unlitLine(removed: readonly Pick<QueryToken, "label">[], count: number): string | null {
  const first = removed[0];
  if (!first) return null;
  return removed.length === 1 ? t("rail.unlit", { label: first.label, count: num(count) }) : t("rail.unlitMany", { n: num(removed.length), count: num(count) });
}

export interface StackItem {
  id: string;
  kind: "provenance" | "lit" | StatusLine["kind"];
  text: string;
}

/**
 * The stack's items from its bottom: the newest notice nearest the meters, older ones above it, then the lit line,
 * then the provenance line on top (hovering must not move the lines below it).
 */
export function stackItems(notices: readonly StatusLine[], lit: string | null, provenance: string | null): StackItem[] {
  const out: StackItem[] = [...notices].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).map((l) => ({ id: l.id, kind: l.kind, text: l.text }));
  if (lit) out.push({ id: "lit", kind: "lit", text: lit });
  if (provenance) out.push({ id: "provenance", kind: "provenance", text: provenance });
  return out;
}

/** Watch the highlights: when some disappear, report it once the lit count has settled. */
function useUnlitNotices(): void {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const tokens = highlightTokens({ tokens: leaf.store.slices.ui.value.tokens });
  const lit = leaf.store.slices.lit.value;
  const prev = useRef<QueryToken[]>(tokens);
  const pending = useRef<QueryToken[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const removed = pending.current;
    pending.current = [];
    const count = leaf.store.get("lit") ?? indexCounts(s)?.record ?? 0;
    const text = unlitLine(removed, count);
    if (text) shell.notify(text, { kind: "info", ttl: UNLIT_TTL_MS });
  };
  useEffect(() => {
    const gone = removedHighlights(prev.current, tokens);
    prev.current = tokens;
    if (gone.length === 0) return;
    pending.current = [...pending.current, ...gone];
    if (timer.current === null) timer.current = setTimeout(flush, UNLIT_SETTLE_MS);
  }, [leaf.store.slices.ui.value.tokens]);
  // The lit count answered the new tokens: report now with the settled number.
  useEffect(() => {
    if (pending.current.length > 0) flush();
  }, [lit]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
}

/** Drop everything that is lit: every token (chart highlights included) and the typed search; an Ask draft is left alone. */
export function clearAllLit(store: CortexStore): void {
  store.batch(() => {
    clearTokens(store);
    store.update("ui", (u) => (u.command.mode === "find" && u.command.text ? { ...u, command: { ...u.command, text: "", resultsOpen: false } } : u));
  });
}

/** The lines of the block (bold count first); pure so the wording is testable. */
export function litBlockText(sum: LitSummary): { count: string; where: string | null; labels: string | null } {
  const count = sum.count === null ? "…" : num(sum.count);
  if (sum.found) return { count: t("rail.found", { n: count }), where: null, labels: null };
  const where = sum.where ? [t("rail.litIn", { where: sum.where }), sum.more > 0 ? t("rail.litMore", { n: num(sum.more) }) : ""].filter(Boolean).join(" ") : null;
  const labels = sum.labels > 0 ? (sum.labels === 1 ? t("rail.litLabelsOne") : t("rail.litLabels", { n: num(sum.labels) })) : null;
  return { count: t("rail.litCount", { n: count }), where, labels };
}

/** The lit block: the count, what lit it, the highlighted labels and Clear. Works without the Time sheet. */
export function LitBlock(p: { summary: LitSummary }): JSX.Element {
  const leaf = useLeaf();
  const x = litBlockText(p.summary);
  return (
    <div class="cx-lit-block" role="group" aria-live="polite" title={t("rail.litTip")}>
      <p class="cx-lit-count">{x.count}</p>
      {x.where ? <p class="cx-lit-where">{x.where}</p> : null}
      {x.labels ? <p class="cx-lit-labels-line">{x.labels}</p> : null}
      <button type="button" class="cx-lit-clear" title={t("rail.clearTip")} onClick={() => clearAllLit(leaf.store)}>
        {t("rail.clear")}
      </button>
    </div>
  );
}

/** The status stack itself (renders nothing while it is empty). */
export function StatusLines(): JSX.Element | null {
  const leaf = useLeaf();
  const shell = useShell();
  useUnlitNotices();
  const provenance = useProvenanceText();
  const summary = litSummary({ tokens: leaf.store.slices.ui.value.tokens }, leaf.store.slices.lit.value);
  const items = stackItems(shell.statusLines.value, summary ? "lit" : null, provenance);
  if (items.length === 0) return null;
  return (
    <div class="cx-status-stack" role="group" aria-label={t("rail.stack")}>
      {items.map((i) =>
        i.kind === "lit" && summary ? (
          <LitBlock key={i.id} summary={summary} />
        ) : (
          <p key={i.id} class={`cx-status-line is-${i.kind}`}>
            {i.text}
          </p>
        ),
      )}
    </div>
  );
}

/** How often the sealed date is looked at again (a seal is made at most a few times a day). */
export const SEALED_REFRESH_MS = 10 * 60_000;

/** "Sealed through <date>": the newest seal block on this computer; nothing while nothing is sealed or in the sample record. */
export function SealedChip(): JSX.Element | null {
  const s = useServices();
  const sandbox = s.sandbox.value;
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    if (sandbox) {
      setAt(null);
      return;
    }
    let alive = true;
    const look = (): void => {
      try {
        void s.runner.request({ cmd: "seals.status", args: {} }).then(
          (st) => {
            if (alive) setAt(st.blocks > 0 && st.lastAt ? st.lastAt : null);
          },
          () => undefined,
        );
      } catch {
        // no runner yet: nothing to show
      }
    };
    look();
    const timer = setInterval(look, SEALED_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sandbox]);
  if (!at) return null;
  return <p class="cx-sealed-chip-line">{t("you.sealedThrough", { date: new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) })}</p>;
}

export function RailStatus(): JSX.Element {
  const desktop = isDesktopHost();
  return (
    <div class="cx-rail-status">
      {desktop ? (
        <>
          <LoadingChip />
          <ArrivalsPill />
          <LiveChip />
          <AgentChip />
        </>
      ) : null}
      <StatusLines />
      <SealedChip />
    </div>
  );
}
