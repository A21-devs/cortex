/**
 * Guide › "How your record is kept": a diagram of Cortex's own pipeline. Five steps along the top (Sources, Screen,
 * Seal, Date, Anchor), five beside them (Vault, Keys, Checks, Outcomes, Export). Pick a step to light it and open
 * its card with the live setting; four tabs pick out the steps each question is about. Pure view: the model is
 * recordModel.ts; the page wires settings, seal facts and the two actions. Keyboard: one tab stop on the diagram,
 * arrows move between steps (Up/Down between the rows), Enter or Space lights one.
 */
import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import type { CortexSettings } from "../../../shared/settings";
import { t } from "../../copy";
import { Button } from "../../primitives/buttons";
import { RecordFigure } from "./RecordFigure";
import {
  moveNode,
  nodeAriaLabel,
  PATH_NODES,
  RECORD_TABS,
  recordNodes,
  SIDE_NODES,
  STATUS_COPY,
  STATUS_ORDER,
  TAB_COPY,
  TAB_NODES,
  type NodeAction,
  type NodeId,
  type NodeView,
  type RecordFacts,
  type RecordTab,
} from "./recordModel";

export interface RecordDiagramProps {
  settings: CortexSettings;
  facts: RecordFacts;
  onAction(a: NodeAction): void;
  /** For tests and screenshots: start with this step lit. */
  initialNode?: NodeId | null;
  initialTab?: RecordTab;
}

export function RecordDiagram(p: RecordDiagramProps): JSX.Element {
  const [lit, setLit] = useState<NodeId | null>(p.initialNode ?? null);
  const [tab, setTab] = useState<RecordTab>(p.initialTab ?? "recorded");
  const [focusId, setFocusId] = useState<NodeId>(p.initialNode ?? "sources");
  const diagram = useRef<HTMLDivElement>(null);
  const nodes = recordNodes(p.settings, p.facts, t);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const hot = new Set<NodeId>(TAB_NODES[tab]);
  const card = lit ? byId.get(lit) : undefined;

  const onKey = (e: KeyboardEvent, from: NodeId) => {
    const to = moveNode(from, e.key);
    if (!to) return;
    e.preventDefault();
    setFocusId(to);
    diagram.current?.querySelector<HTMLElement>(`[data-node="${to}"]`)?.focus();
  };

  const renderNode = (id: NodeId): JSX.Element | null => {
    const n = byId.get(id);
    if (!n) return null;
    const cls = ["cx-rec-node", `is-${n.status}`, lit === id ? "is-lit" : "", hot.has(id) ? "is-hot" : "is-dim", n.built ? "" : "is-unbuilt"].filter(Boolean).join(" ");
    return (
      <li class="cx-rec-cell" data-cell={id}>
        <button
          type="button"
          class={cls}
          data-node={id}
          data-status={n.status}
          aria-pressed={lit === id}
          aria-controls="cx-rec-card"
          aria-label={nodeAriaLabel(n, t)}
          tabIndex={focusId === id ? 0 : -1}
          onFocus={() => setFocusId(id)}
          onKeyDown={(e) => onKey(e, id)}
          onClick={() => setLit(lit === id ? null : id)}
        >
          <span class={`cx-rec-dot${n.built ? " is-built" : ""}`} aria-hidden="true" />
          <span class="cx-rec-name">{t(n.name)}</span>
        </button>
      </li>
    );
  };

  return (
    <section class="cx-guide-card cx-record" data-demo="record" aria-labelledby="cx-rec-title">
      <h3 id="cx-rec-title">{t("guide.record.title")}</h3>
      <p>{t("guide.record.intro")}</p>

      <RecordFigure settings={p.settings} nodes={nodes} facts={p.facts} />

      <div class="cx-rec-diagram" ref={diagram}>
        <p class="cx-rec-rowlabel" id="cx-rec-path">
          {t("guide.record.pathLabel")}
        </p>
        <ol class="cx-rec-row is-path" aria-labelledby="cx-rec-path">
          {PATH_NODES.map(renderNode)}
        </ol>
        <p class="cx-rec-rowlabel" id="cx-rec-side">
          {t("guide.record.sideLabel")}
        </p>
        <ol class="cx-rec-row is-side" aria-labelledby="cx-rec-side">
          {SIDE_NODES.map(renderNode)}
        </ol>
      </div>

      <div class="cx-rec-legend" role="group" aria-label={t("guide.record.legendLabel")}>
        {STATUS_ORDER.map((st) => (
          <span class="cx-rec-key" data-status={st}>
            <span class={`cx-rec-swatch is-${st}`} aria-hidden="true" />
            {t(STATUS_COPY[st])}
          </span>
        ))}
        <span class="cx-rec-key cx-rec-built">
          <span class="cx-rec-dot is-built" aria-hidden="true" />
          <span class="cx-rec-dot" aria-hidden="true" />
          {t("guide.record.builtLegend")}
        </span>
      </div>

      <div class="cx-rec-card" id="cx-rec-card" role="region" aria-live="polite" aria-label={t("guide.record.stateLabel")}>
        {card ? <NodeCard node={card} onAction={p.onAction} /> : <p class="cx-note">{t("guide.record.pickOne")}</p>}
      </div>

      <div class="cx-rec-tabs" role="tablist" aria-label={t("guide.record.tabsLabel")} onKeyDown={(e) => onTabKey(e, tab, setTab)}>
        {RECORD_TABS.map((id) => (
          <button type="button" role="tab" id={`cx-rec-tab-${id}`} aria-selected={tab === id} aria-controls="cx-rec-panel" tabIndex={tab === id ? 0 : -1} class={`cx-seg${tab === id ? " is-on" : ""}`} onClick={() => setTab(id)}>
            {t(TAB_COPY[id].title)}
          </button>
        ))}
      </div>
      <div class="cx-rec-panel" id="cx-rec-panel" role="tabpanel" aria-labelledby={`cx-rec-tab-${tab}`}>
        <p>{t(TAB_COPY[tab].body)}</p>
        <ul class="cx-rec-lines">
          {TAB_NODES[tab].map((id) => {
            const n = byId.get(id);
            return n ? (
              <li>
                <span class="cx-rec-line-name">{t(n.name)}</span> {n.state}
              </li>
            ) : null;
          })}
        </ul>
      </div>
    </section>
  );
}

function NodeCard(p: { node: NodeView; onAction(a: NodeAction): void }): JSX.Element {
  const n = p.node;
  return (
    <article class="cx-rec-card-body" data-node-card={n.id}>
      <header>
        <h4>{t(n.name)}</h4>
        <span class={`cx-rec-chip is-${n.status}`}>{t(STATUS_COPY[n.status])}</span>
        <span class="cx-rec-chip is-built-chip">
          <span class={`cx-rec-dot${n.built ? " is-built" : ""}`} aria-hidden="true" />
          {t(n.built ? "guide.record.built" : "guide.record.notBuilt")}
        </span>
      </header>
      <p>{t(n.what)}</p>
      <p class="cx-rec-state">
        <span class="cx-rec-state-label">{t("guide.record.stateLabel")}</span> {n.state}
      </p>
      {n.gaps.length > 0 ? (
        <p class="cx-note cx-rec-gaps">
          <span class="cx-rec-state-label">{t("guide.record.gapsLabel")}</span> {n.gaps.join(". ")}.
        </p>
      ) : null}
      {n.action ? <Button onClick={() => p.onAction(n.action as NodeAction)}>{t(n.action.label)}</Button> : null}
    </article>
  );
}

function onTabKey(e: KeyboardEvent, tab: RecordTab, setTab: (t: RecordTab) => void): void {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
  const i = RECORD_TABS.indexOf(tab);
  const n = RECORD_TABS.length;
  const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
  const id = RECORD_TABS[next];
  if (!id) return;
  e.preventDefault();
  setTab(id);
  (e.currentTarget as HTMLElement | null)?.querySelectorAll?.<HTMLElement>("[role=tab]")[next]?.focus?.();
}
