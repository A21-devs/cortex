/**
 * Who made it (Agents > Ledger > Influence): the record's nodes and links by the set of makers behind them, as two
 * tables ("By makers together", "By maker") with a share bar, read for the notes alone or the whole record. A picked row
 * lights its nodes in the figure. Counted by the background worker from the index; no model is asked anything.
 * Owner: lab.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { InfluenceScope, StatsResult } from "../../../shared/protocol/worker";
import { addToken, removeToken } from "../../../state/actions";
import { useLeaf, useServices } from "../../context";
import { t } from "../../copy";
import { Segmented } from "../../primitives/controls";
import { fmtInt, sourceLabel } from "../../valueLabels";
import { Load, useLoad } from "../PageFrame";

type InfluenceResult = Extract<StatsResult, { kind: "influence" }>;

/** Token id prefix of the row whose nodes are lit (Agents.tsx clears it when a pack is lit). */
export const MAKER_TOKEN_PREFIX = "lab:maker:";

/** "You", "Claude Code", "Cortex's agents": a maker as the page names it. */
export function makerName(maker: string): string {
  if (maker.startsWith("app:")) return sourceLabel(maker.slice(4));
  switch (maker) {
    case "you":
      return t("agents.makerYou");
    case "machine":
      return t("agents.makerMachine");
    case "tool":
      return t("agents.makerTool");
    default:
      return t("agents.makerOther");
  }
}

/** "You only", "You and Claude Code", "You, Claude Code and Tools". */
export function makersName(makers: readonly string[]): string {
  const names = makers.map(makerName);
  if (names.length <= 1) return t("agents.makersOnly", { a: names[0] ?? "" });
  return t("agents.makersAnd", { a: names.slice(0, -1).join(", "), b: names[names.length - 1]! });
}

/** "86.0%": a share to one decimal, "0.0%" for nothing. */
export function shareText(n: number, total: number): string {
  return `${(total > 0 ? (100 * n) / total : 0).toFixed(1)}%`;
}

function Count(p: { n: number; total: number }): JSX.Element {
  const w = p.total > 0 ? Math.min(100, (100 * p.n) / p.total) : 0;
  return (
    <td class="cx-mono">
      {fmtInt(p.n)}
      <span class="cx-note cx-lab-sub">{shareText(p.n, p.total)}</span>
      <span class="cx-lab-bar" aria-hidden="true">
        <i style={{ width: `${w}%` }} />
      </span>
    </td>
  );
}

export function Influence(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const [scope, setScope] = useState<InfluenceScope>("notes");
  const lit = leaf.store.slices.ui.value.tokens.find((x) => x.id.startsWith(MAKER_TOKEN_PREFIX))?.id ?? null;
  const res = useLoad<InfluenceResult>(
    async (signal) => {
      const r = await s.worker.call(`agents#influence`, "stats", { kind: "influence", scope }, { signal });
      if (r.kind !== "influence") throw new Error("unexpected stats result");
      return r;
    },
    [scope, s.shared.slices.data.value.seq, s.shared.slices.data.value.phase],
  );
  const light = (of: InfluenceScope, value: string, name: string) => {
    const id = `${MAKER_TOKEN_PREFIX}${of}:${value}`;
    for (const x of leaf.store.slices.ui.value.tokens) if (x.id.startsWith(MAKER_TOKEN_PREFIX) || x.id.startsWith("lab:pack:")) removeToken(leaf.store, x.id);
    if (lit !== id) addToken(leaf.store, { id, kind: "group", dim: `maker:${of}`, value, label: t("agents.influenceToken", { row: name }) });
  };
  const pick = (of: InfluenceScope, value: string, name: string): JSX.Element => {
    const on = lit === `${MAKER_TOKEN_PREFIX}${of}:${value}`;
    return (
      <th scope="row">
        <button type="button" class="cx-lab-pick" aria-pressed={on} title={t("agents.influenceLight", { row: name })} onClick={() => light(of, value, name)}>
          {name}
        </button>
      </th>
    );
  };
  return (
    <section class="cx-influence" aria-label={t("agents.influenceTitle")}>
      <div class="cx-section-label">
        <span>{t("agents.influenceTitle")}</span>
      </div>
      <p class="cx-note">{t("agents.influenceHint")}</p>
      <Segmented<InfluenceScope>
        label={t("agents.influenceScope")}
        value={scope}
        options={[
          { value: "notes", label: t("agents.influenceScopeNotes") },
          { value: "record", label: t("agents.influenceScopeRecord") },
        ]}
        onChange={setScope}
      />
      <Load value={res} failed={t("errors.agents")} rows={3}>
        {(r) =>
          r.nodes === 0 ? (
            <p class="cx-note">{t("agents.influenceEmpty")}</p>
          ) : (
            <>
              <p class="cx-note cx-lab-count">{t(r.scope === "notes" ? "agents.influenceCountNotes" : "agents.influenceCountRecord", { nodes: fmtInt(r.nodes), links: fmtInt(r.links) })}</p>
              <h4 class="cx-lab-sub-title">{t("agents.influenceTogether")}</h4>
              <div class="cx-table-wrap">
                <table class="cx-table cx-lab-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("agents.influenceMakers")}</th>
                      <th scope="col" class="is-num">{t("agents.influenceNodes")}</th>
                      <th scope="col" class="is-num">{t("agents.influenceLinks")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.together.map((row) => (
                      <tr key={row.key} class={`cx-lab-row${lit === `${MAKER_TOKEN_PREFIX}${r.scope}:${row.key}` ? " is-picked" : ""}`}>
                        {pick(r.scope, row.key, makersName(row.makers))}
                        <Count n={row.nodes} total={r.nodes} />
                        <Count n={row.links} total={r.links} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h4 class="cx-lab-sub-title">{t("agents.influenceBy")}</h4>
              <div class="cx-table-wrap">
                <table class="cx-table cx-lab-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("agents.influenceMaker")}</th>
                      <th scope="col" class="is-num">{t("agents.influenceTouched")}</th>
                      <th scope="col" class="is-num">{t("agents.influenceMade")}</th>
                      <th scope="col" class="is-num">{t("agents.influenceLinks")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.byMaker.map((row) => (
                      <tr key={row.maker} class={`cx-lab-row${lit === `${MAKER_TOKEN_PREFIX}${r.scope}:has:${row.maker}` ? " is-picked" : ""}`}>
                        {pick(r.scope, `has:${row.maker}`, makerName(row.maker))}
                        <Count n={row.touched} total={r.nodes} />
                        <td class="cx-mono">{fmtInt(row.made)}</td>
                        <Count n={row.links} total={r.links} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        }
      </Load>
    </section>
  );
}
