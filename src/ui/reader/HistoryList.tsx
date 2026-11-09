/**
 * One chronological History list per entry (CORTEX-UX §5.14; ORIG-12): imported → labelled by haiku → corrected by
 * you → read by sonnet. It merges what were separate "used by models" and "versions" lists; every line has its time
 * at the right; machine lines carry a dotted hollow marker and yours a filled amber one; a version line has a
 * "diff" toggle that shows that version's changes inline (a word diff against the version before). Owner: E12.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { HistoryItem } from "../../plugin/services";
import { t } from "../copy";
import type { Fmt } from "../pages/PageFrame";
import { sourceLabel } from "../valueLabels";

export type DiffOp = { op: "same" | "add" | "del"; text: string };

/** Words and the whitespace after them, so joining the parts gives back the text exactly. */
function tokens(s: string): string[] {
  return s.match(/\S+\s*|\s+/g) ?? [];
}

/**
 * Word diff of two versions. Common prefix and suffix are trimmed first (most fixes are small), then an LCS runs on
 * the middle; a middle too large for an LCS is shown as one removal and one addition.
 */
export function wordDiff(before: string, after: string, maxCells = 1_000_000): DiffOp[] {
  const a = tokens(before);
  const b = tokens(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const out: DiffOp[] = [];
  const add = (op: DiffOp["op"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  add("same", a.slice(0, pre).join(""));
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  if (ma.length * mb.length > maxCells) {
    add("del", ma.join(""));
    add("add", mb.join(""));
  } else {
    const n = ma.length;
    const m = mb.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      const row = dp[i] as Uint32Array;
      const below = dp[i + 1] as Uint32Array;
      for (let j = m - 1; j >= 0; j--) row[j] = ma[i] === mb[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        add("same", ma[i] as string);
        i++;
        j++;
      } else if (((dp[i + 1] as Uint32Array)[j] as number) >= ((dp[i] as Uint32Array)[j + 1] as number)) add("del", ma[i++] as string);
      else add("add", mb[j++] as string);
    }
    while (i < n) add("del", ma[i++] as string);
    while (j < m) add("add", mb[j++] as string);
  }
  add("same", a.slice(a.length - suf).join(""));
  return out;
}

export function DiffView(p: { ops: readonly DiffOp[] }): JSX.Element {
  return (
    <p class="cx-diff">
      {p.ops.map((o) => (o.op === "same" ? <span>{o.text}</span> : o.op === "add" ? <ins>{o.text}</ins> : <del>{o.text}</del>))}
    </p>
  );
}

/** Machine lines (dotted hollow marker) vs your own (filled amber). */
export function isMachineLine(h: HistoryItem): boolean {
  return h.kind === "labelled" || h.kind === "summarised" || h.kind === "read" || ((h.kind === "version" || h.kind === "corrected") && h.model !== undefined);
}

/** The words of one History line (§5.14). */
export function historyLine(h: HistoryItem, source: string): string {
  const model = h.model ?? t("agents.none");
  switch (h.kind) {
    case "imported":
      return t("reader.histImported", { source: sourceLabel(source) });
    case "labelled":
      return h.detail ? t("reader.histLabelled", { model, pack: h.detail }) : t("history.labelledBy", { model });
    case "summarised":
      return t("reader.histCited", { model });
    case "read":
      return h.route === "ask" || h.route === undefined ? t("reader.histRead", { model }) : t("history.readBy", { model });
    case "excluded":
      return t("reader.histLeftOut");
    case "included":
      return t("reader.histBack");
    case "version":
      return h.model ? t("history.versionAsk", { v: h.version ?? 2, detail: h.detail ?? "" }) : t("reader.histVersion", { v: h.version ?? 2, detail: h.detail ?? t("history.edited") });
    case "corrected":
      return h.detail ? t("history.correctedDetail", { detail: h.detail }) : t("history.corrected");
  }
}

export interface HistoryListProps {
  items: readonly HistoryItem[];
  source: string;
  fmt: Fmt;
  /** Load the texts of a version and the version before it, for "diff". */
  loadDiff?: (version: number) => Promise<{ before: string; after: string } | null>;
}

export function HistoryList(p: HistoryListProps): JSX.Element {
  const [open, setOpen] = useState<Record<number, DiffOp[] | "loading" | "failed">>({});
  const sorted = [...p.items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const toggle = (v: number) => {
    if (open[v] !== undefined) {
      const next = { ...open };
      delete next[v];
      setOpen(next);
      return;
    }
    const load = p.loadDiff;
    if (!load) return;
    setOpen({ ...open, [v]: "loading" });
    load(v).then(
      (r) => setOpen((o) => ({ ...o, [v]: r ? wordDiff(r.before, r.after) : "failed" })),
      () => setOpen((o) => ({ ...o, [v]: "failed" })),
    );
  };
  return (
    <section class="cx-history" aria-label={t("reader.history")}>
      <ol>
        {sorted.map((h) => {
          const v = h.version;
          const diff = v !== undefined ? open[v] : undefined;
          return (
            <li data-kind={h.kind} class={isMachineLine(h) ? "is-machine" : h.kind === "imported" ? "is-neutral" : "is-yours"}>
              <span class="cx-history-mark" aria-hidden="true" />
              <span class="cx-history-text">
                {historyLine(h, p.source)}
                {h.kind === "version" && v !== undefined && p.loadDiff ? (
                  <>
                    {" · "}
                    <button type="button" class="cx-text-button" aria-expanded={diff !== undefined} onClick={() => toggle(v)}>
                      {diff !== undefined ? t("reader.hideDiff") : t("reader.diff")}
                    </button>
                  </>
                ) : null}
              </span>
              <time class="cx-mono" dateTime={h.at}>
                {p.fmt.dateTime(Date.parse(h.at), true)}
              </time>
              {diff === "loading" ? <p class="cx-note">{t("reader.loadingMore")}</p> : diff === "failed" ? <p class="cx-note">{t("errors.reader")}</p> : diff ? <DiffView ops={diff} /> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
