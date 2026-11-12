/**
 * Guide (CORTEX-UX §5.23, P1): five cards, each ending in "Show it", which sets the figure up to show the idea on
 * your own record; the keyboard table (from the key catalogue); "Explore the sample record". Owner: E12.
 * "Show it" changes only the view (never data): the previous view state is kept and "Back" restores it.
 */
import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { featureOn } from "../../shared/features";
import { addToken, openPage, openTab, pushSheet, setPeriod, setScope, setShape } from "../../state/actions";
import { useLeaf, useServices, useShell } from "../context";
import { startTour } from "../walkthrough/TourLayer";
import { COPY, t } from "../copy";
import { Button } from "../primitives/buttons";
import { areaLabel, fmtDate, isoMs } from "../valueLabels";
import { useIndex } from "../reader/readerKit";
import { PageFrame, loaded, openCortexSettings, runObsidianCommand, useFmt, useLoad } from "./PageFrame";
import { SPACE_ORDER } from "../../shared/index-format";
import { RecordDiagram } from "./guide/RecordDiagram";
import { RecordLayers } from "./guide/RecordLayers";
import { areaCounts, type NodeAction, type RecordFacts } from "./guide/recordModel";

export type GuideDemo = "frond" | "strip" | "compass" | "sheet" | "tokens";

export const GUIDE_CARDS: readonly { demo: GuideDemo; title: `guide.${string}Title`; body: `guide.${string}Body` }[] = [
  { demo: "frond", title: "guide.frondsTitle", body: "guide.frondsBody" },
  { demo: "strip", title: "guide.stripTitle", body: "guide.stripBody" },
  { demo: "compass", title: "guide.compassTitle", body: "guide.compassBody" },
  { demo: "sheet", title: "guide.sheetTitle", body: "guide.sheetBody" },
  { demo: "tokens", title: "guide.tokensTitle", body: "guide.tokensBody" },
];

/** Rows of the keyboard table: [keys, what it does], in catalogue order. */
export function keyRows(): { id: string; keys: string; action: string }[] {
  const names = COPY.keyNames as Readonly<Record<string, string>>;
  const what = COPY.keys as Readonly<Record<string, string>>;
  return Object.keys(names)
    .filter((id) => typeof what[id] === "string")
    .map((id) => ({ id, keys: names[id] as string, action: what[id] as string }));
}

export function Guide(_p: { params: Readonly<Record<string, string>> }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const index = useIndex(s);
  const [state, setState] = useState<"idle" | "showing" | "nothing">("idle");
  const [saved, setSaved] = useState<ReturnType<typeof leaf.store.snapshot> | null>(null);
  const fmt = useFmt();
  const sandbox = s.sandbox.value;
  const sealsLoad = useLoad(() => (sandbox ? Promise.resolve(null) : s.runner.request({ cmd: "seals.status", args: {} })), [sandbox]);
  const sealStatus = loaded(sealsLoad) ?? null;
  const checksOpen = featureOn("checks") ? s.shared.slices.queues.value.checks : 0;
  const areas = useMemo(() => (index ? areaCounts(index.cols, index.count, SPACE_ORDER) : []), [index]);
  const shares = s.settings.value.record?.shares;
  const facts: RecordFacts = {
    areas,
    ...(shares ? { shares: { threshold: shares.threshold, total: shares.total, splitAt: shares.splitAt, holders: shares.holders.map((h) => ({ share: h.share, name: h.name })) } } : {}),
    seals: sealStatus ? { blocks: sealStatus.blocks, entries: sealStatus.entries, intact: sealStatus.intact, ...(sealStatus.published ? { anchoredAt: sealStatus.published.at } : {}) } : null,
    entries: index ? index.count : null,
    checksOpen,
    date: (iso) => fmtDate(isoMs(iso), fmt.format),
  };
  const recordAction = (a: NodeAction) => {
    if (a.kind === "checks") openPage(leaf.store, "agents", { tab: "checks" }, true);
    else openCortexSettings(s.app, a.section ?? "general");
  };

  const show = (demo: GuideDemo) => {
    const dated = index ? firstConversation(index) : null;
    if (!index || index.count === 0 || (!dated && demo !== "compass")) return setState("nothing");
    setSaved(leaf.store.snapshot());
    leaf.store.batch(() => {
      setShape(leaf.store, "body");
      if (demo === "frond" && dated) pushSheet(leaf.store, { kind: "reader", route: "conversation", id: dated.id });
      else if (demo === "strip" && dated) setPeriod(leaf.store, [Math.max(0, dated.startedAt - 14 * 86_400_000), dated.startedAt + 14 * 86_400_000]);
      else if (demo === "compass") {
        const space = Object.keys(s.colours.current().space ?? {})[0];
        if (space) setScope(leaf.store, space as Parameters<typeof setScope>[1]);
      } else if (demo === "sheet" && dated) pushSheet(leaf.store, { kind: "reader", route: "conversation", id: dated.id });
      else if (demo === "tokens" && dated) addToken(leaf.store, { id: `guide:${dated.space}`, kind: "group", dim: "space", value: dated.space, label: areaLabel(dated.space) });
    });
    setState("showing");
  };

  const back = () => {
    if (saved) leaf.store.restore(saved);
    setSaved(null);
    setState("idle");
  };

  return (
    <PageFrame>
      {GUIDE_CARDS.map((c) => (
        <article class="cx-guide-card" data-demo={c.demo}>
          <h3>{t(c.title as "guide.frondsTitle")}</h3>
          <p>{t(c.body as "guide.frondsBody")}</p>
          <button type="button" class="cx-text-button" onClick={() => show(c.demo)}>
            {t("guide.showIt")}
          </button>
        </article>
      ))}
      <div class="cx-guide-state" role="status" aria-live="polite">
        {state === "showing" ? (
          <p class="cx-note">
            {t("guide.showing")}{" "}
            <button type="button" class="cx-text-button" onClick={back}>
              {t("guide.back")}
            </button>
          </p>
        ) : null}
        {state === "nothing" ? <p class="cx-note">{t("guide.nothing")}</p> : null}
      </div>
      <RecordDiagram settings={s.settings.value} facts={facts} onAction={recordAction} />
      <RecordLayers index={index} areas={areas} date={(ms) => fmtDate(ms, fmt.format)} />
      <section aria-label={t("guide.shortcuts")}>
        <div class="cx-section-label">
          <span>{t("guide.shortcuts")}</span>
        </div>
        <table class="cx-table cx-key-table">
          <thead>
            <tr>
              <th scope="col">{t("guide.keyColumn")}</th>
              <th scope="col">{t("guide.actionColumn")}</th>
            </tr>
          </thead>
          <tbody>
            {keyRows().map((r) => (
              <tr>
                <th scope="row" class="cx-mono">
                  {r.keys}
                </th>
                <td>{r.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <Button
        onClick={() => {
          openTab(leaf.store, "brain");
          startTour(s, shell);
        }}
      >{t("guide.takeTour")}</Button>
      {featureOn("sampleRecord") ? (
        <Button onClick={() => s.bus.emit("command", { viewId: leaf.viewId, id: "toggle-sample" })}>{t("guide.explore")}</Button>
      ) : null}
      <Button onClick={() => runObsidianCommand(s.app, "cortex:show-agreement")}>{t("guide.showAgreement")}</Button>
      <Button onClick={() => runObsidianCommand(s.app, "cortex:connect-agent")}>{t("guide.connectAgent")}</Button>
    </PageFrame>
  );
}

/** The first dated conversation in the index: its id, start time and area. */
function firstConversation(index: NonNullable<ReturnType<typeof useIndex>>): { id: string; startedAt: number; space: string } | null {
  for (let r = 0; r < index.convs.size; r++) {
    const row = index.convs.get(r);
    if (Number.isFinite(row.startedAt) && row.startedAt > 0) return { id: row.id, startedAt: row.startedAt, space: row.space };
  }
  return null;
}
