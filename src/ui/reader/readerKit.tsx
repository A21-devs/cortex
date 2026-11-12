/**
 * Shared reader plumbing (CORTEX-UX §5.13–§5.17). Owner: E12.
 *  - resolving a stable id from the sheet stack to the index ordinal the RecordReader needs (the stack stores ids
 *    so it survives restarts; ordinals change with the index epoch);
 *  - the reader action row: Pin (a pin correction, M15), Show in brain (F) and More (an Obsidian menu);
 *  - "Opening…" for 300 ms, then skeleton blocks, then the reader or its error card;
 *  - Looks right and the Correct box (a comment fix shown as waiting / answered, M7);
 *  - opening vault files in Obsidian and Cortex links for Copy link.
 * Every write goes through CorrectionService; the sample record refuses writes (M13) and the controls say so.
 */
import type { ComponentChildren, JSX } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { App } from "obsidian";
import { ItemFlag } from "../../shared/index-format";
import type { DataIndex } from "../../shared/index-format";
import type { ItemMeta } from "../../plugin/indexer";
import { cortexLink } from "../../plugin/obsidianBridge";
import type { CommentView, CortexServices, LabelView, LeafServices } from "../../plugin/services";
import { findPack } from "../../shared/packs";
import type { CorrectionRecord, LabelValue, NoteKind, PackDef, PackField } from "../../shared/types";
import { openBeside, pushSheet, select } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import type { ReaderRoute, SheetEntry } from "../../shared/views";
import { t } from "../copy";
import { IconButton } from "../primitives/buttons";
import type { MenuItemSpec } from "../primitives/menu";
import { ErrorCard, MenuButton, openMenuAt, Skeleton, useElapsed, useFmt, type Loadable } from "../pages/PageFrame";
import { ServicesContext } from "../context";
import { kindLabel, sourceLabel } from "../valueLabels";
import { KindGlyph, SourceIcon } from "./marks";
import { readerRouteOf } from "./routes";

// ───────────────────────────── index access ─────────────────────────────

/** The loaded index (subscribes the component to index changes); null while it loads or when unavailable. */
export function useIndex(s: CortexServices): DataIndex | null {
  try {
    return s.index.index.value;
  } catch {
    return null;
  }
}

/** Ordinal of a stable id in the loaded index; -1 when unknown or while the index loads. */
export function resolveOrdinal(s: CortexServices, id: string, index: DataIndex | null = null): number {
  try {
    const o = s.index.ordinalOf(id);
    if (o >= 0) return o;
  } catch {
    // the index service may not be ready yet
  }
  try {
    return index ? index.ordinalOf(id) : -1;
  } catch {
    return -1;
  }
}

export function metaOf(s: CortexServices, ordinal: number): ItemMeta | undefined {
  if (ordinal < 0) return undefined;
  try {
    return s.index.meta(ordinal);
  } catch {
    return undefined;
  }
}

/** Stable id of an ordinal (meta first, then the index's id table). */
export function idOf(s: CortexServices, ordinal: number, index: DataIndex | null): string | undefined {
  const m = metaOf(s, ordinal);
  if (m) return m.id;
  try {
    return index && ordinal >= 0 && ordinal < index.count ? index.ids.get(ordinal) : undefined;
  } catch {
    return undefined;
  }
}

/** Flags of an item (0 when unknown). */
export function flagsOf(s: CortexServices, ordinal: number, index: DataIndex | null): number {
  const m = metaOf(s, ordinal);
  if (m) return m.flags;
  return index && ordinal >= 0 && ordinal < index.count ? (index.cols.flags[ordinal] ?? 0) : 0;
}

/** Thrown by reader loaders when the id is not (yet) in the index. */
export class NotInIndex extends Error {
  constructor(readonly loading: boolean) {
    super(loading ? "index loading" : "not in index");
  }
}

// ───────────────────────────── navigation ─────────────────────────────

/**
 * Open a reader for an item from inside the sheet (pushes; selects it when the ordinal is known). `beside` is for a page's own
 * list: with two columns showing, the reader takes the place of the one already open beside the page instead of stacking on it.
 */
export function openReader(leaf: LeafServices, route: ReaderRoute, id: string, ordinal = -1, beside = false): void {
  const open = () => (beside ? openBeside(leaf.store, { kind: "reader", route, id }) : pushSheet(leaf.store, { kind: "reader", route, id }));
  if (ordinal >= 0) {
    leaf.store.batch(() => {
      select(leaf.store, ordinal, id);
      open();
    });
  } else open();
}

/** Open the right reader for an item by its index kind (vault notes peek, summaries open their conversation). */
export function openItemReader(s: CortexServices, leaf: LeafServices, ordinal: number, index: DataIndex | null, beside = false): void {
  const m = metaOf(s, ordinal);
  const id = idOf(s, ordinal, index);
  if (!id) return;
  const kind = m?.kind ?? (index ? index.cols.kind[ordinal] : undefined) ?? 0;
  openReader(leaf, readerRouteOf(kind), id, ordinal, beside);
}

/** Replace the current reader entry (frond scrubber steps) without growing the back stack. */
export function replaceReader(store: CortexStore, entry: Extract<SheetEntry, { kind: "reader" }>): void {
  store.update("ui", (ui) => {
    const cur = ui.sheet.stack[ui.sheet.index];
    if (!cur || cur.kind !== "reader") return ui;
    if (cur.route === entry.route && cur.id === entry.id) return ui;
    const stack = ui.sheet.stack.slice();
    stack[ui.sheet.index] = entry;
    return { ...ui, sheet: { ...ui.sheet, stack } };
  });
}

/** Show in brain (F): select the item and fly the camera to it. */
export function showInBrain(s: CortexServices, leaf: LeafServices, ordinal: number, id: string): void {
  if (ordinal < 0) return;
  select(leaf.store, ordinal, id);
  s.bus.emit("camera:fly-to", { viewId: leaf.viewId, ordinal });
}

/** Pinned state: a pin correction folded at load (flag) or since (effective corrections). */
export function isPinned(s: CortexServices, id: string, ordinal: number, index: DataIndex | null): boolean {
  try {
    const eff = s.corrections.effective();
    return eff.pinned.has(id);
  } catch {
    return (flagsOf(s, ordinal, index) & ItemFlag.Pinned) !== 0;
  }
}

export async function setPinned(s: CortexServices, id: string, pin: boolean): Promise<CorrectionRecord> {
  return s.corrections.apply({ via: "reader", action: pin ? "pin" : "unpin", target: id, payload: {} });
}

/** obsidian://cortex link for Copy link (validated ids only). */
export function linkFor(target: { entry: string } | { note: string }): string {
  return "entry" in target ? cortexLink({ kind: "entry", id: target.entry }) : cortexLink({ kind: "note", path: target.note });
}

/** Open a vault file in Obsidian: a new tab next to Cortex, or to the right; with a block id for atomic notes. */
export function openInObsidian(app: App, path: string, how: "tab" | "split" = "tab", blockId?: string): boolean {
  const ws = app.workspace as unknown as { openLinkText?(link: string, source: string, newLeaf?: boolean | "tab" | "split" | "window"): Promise<void> };
  if (!ws.openLinkText) return false;
  const link = blockId ? `${path}#^${blockId}` : path;
  void ws.openLinkText(link, "", how).catch(() => undefined);
  return true;
}

// ───────────────────────────── states ─────────────────────────────

/** "Opening…" for up to 300 ms, then skeleton blocks (§5.14 States). */
export function ReaderOpening(p: { ordinal?: number } = {}): JSX.Element {
  const late = useElapsed(300);
  const s = useContext(ServicesContext);
  const fmt = useFmt();
  const body = late ? <Skeleton rows={6} /> : <p class="cx-opening">{t("app.opening")}</p>;
  // The title, kind and date come from the index at once; only the body waits (the "Opening…" / skeleton slot).
  const meta = s && p.ordinal !== undefined ? metaOf(s, p.ordinal) : undefined;
  if (!meta) return body;
  const when = meta.writtenAt ? Date.parse(meta.writtenAt) : Number.NaN;
  return (
    <article class="cx-reader cx-reader-opening" data-id={meta.id} aria-busy="true">
      <div class="cx-reader-head">
        <span class="cx-kind-line">
          {meta.population === "record" ? <SourceIcon source={meta.source} /> : <KindGlyph kind={meta.noteKind ?? "note"} />}
          {meta.population === "record" ? sourceLabel(meta.source) : kindLabel(meta.noteKind ?? "note")}
          {Number.isFinite(when) ? <span class="cx-mono">{fmt.dateTime(when, true)}</span> : null}
        </span>
        <h3 class="cx-reader-title">{meta.conversation?.title && !meta.title ? meta.conversation.title : meta.title || t("read.untitled")}</h3>
      </div>
      {body}
    </article>
  );
}

/** Loading, error and not-in-index states shared by every reader. */
export function ReaderLoad<T>(p: { value: Loadable<T>; children: (v: T) => JSX.Element; ordinal?: number }): JSX.Element {
  const v = p.value;
  if (v.state === "error") {
    if (v.error instanceof NotInIndex) return v.error.loading ? <p class="cx-note">{t("errors.indexLoading")}</p> : <ErrorCard message={t("errors.notInIndex")} retry={v.retry} />;
    return <ErrorCard message={t("errors.reader")} retry={v.retry} />;
  }
  if (v.state === "loading") return v.previous === undefined ? <ReaderOpening ordinal={p.ordinal} /> : <div aria-busy="true">{p.children(v.previous)}</div>;
  return p.children(v.value);
}

// ───────────────────────────── action row ─────────────────────────────

export interface ReaderMoreItem {
  value: string;
  label: string;
  disabled?: boolean;
  run(): void;
}

/** Pin · Show in brain (F) · More, as 28 px icon buttons (§5.14 Header). */
export function ReaderActions(p: { pinned?: boolean; onPin?: () => void; onShow?: () => void; more: readonly ReaderMoreItem[]; extra?: ComponentChildren; disabledPin?: boolean }): JSX.Element {
  const items: MenuItemSpec[] = p.more.map((m) => ({ value: m.value, label: m.label, disabled: m.disabled }));
  return (
    <div class="cx-reader-actions" role="toolbar" aria-label={t("reader.more")}>
      {p.extra}
      {p.onPin ? <IconButton icon="pin" label={p.pinned ? t("reader.unpin") : t("reader.pin")} pressed={p.pinned === true} onClick={() => (p.disabledPin ? undefined : p.onPin?.())} /> : null}
      {p.onShow ? <IconButton icon="showInBrain" label={`${t("reader.showInBrain")} (F)`} onClick={() => p.onShow?.()} /> : null}
      {items.length > 0 ? (
        <span class="cx-more-anchor" onClick={(e) => openMenuAt(e, items, (v) => p.more.find((m) => m.value === v)?.run())}>
          <IconButton icon="more" label={t("reader.more")} onClick={() => undefined} />
        </span>
      ) : null}
    </div>
  );
}

/**
 * Pin and Focus in the brain as named text actions near the foot of an entry or conversation reader. Below about 340 px of
 * reader width a container query swaps them for the icon pair (`PinFocusIcons`, passed to ReaderActions as `extra`).
 */
export function PinFocusText(p: { pinned: boolean; disabledPin?: boolean; onPin(): void; onShow?: () => void }): JSX.Element {
  return (
    <div class="cx-text-actions">
      <button type="button" class="cx-text-button" aria-pressed={p.pinned} disabled={p.disabledPin} onClick={p.onPin}>
        {p.pinned ? t("reader.unpin") : t("reader.pin")}
      </button>
      {p.onShow ? (
        <button type="button" class="cx-text-button" onClick={p.onShow}>
          {t("reader.focusInBrain")}
        </button>
      ) : null}
    </div>
  );
}

export function PinFocusIcons(p: { pinned: boolean; disabledPin?: boolean; onPin(): void; onShow?: () => void }): JSX.Element {
  return (
    <span class="cx-text-icons">
      <IconButton icon="pin" label={p.pinned ? t("reader.unpin") : t("reader.pin")} pressed={p.pinned} onClick={() => (p.disabledPin ? undefined : p.onPin())} />
      {p.onShow ? <IconButton icon="showInBrain" label={`${t("reader.showInBrain")} (F)`} onClick={() => p.onShow?.()} /> : null}
    </span>
  );
}

// ───────────────────────────── Looks right · Correct ─────────────────────────────

/**
 * Looks right (counts as checked) and the Correct box ("What's wrong or missing?"), saved as your comment and
 * passed to the next refresh; earlier comments show waiting / answered (M7).
 */
export function CorrectBox(p: { comments: readonly CommentView[]; onLooksRight?: () => Promise<void>; onSave(text: string): Promise<void>; disabled?: boolean; prompt?: string; saved?: string; fmtDate(ms: number): string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed" | "marked">("idle");
  const save = async () => {
    const body = text.trim();
    if (!body) return;
    setState("saving");
    try {
      await p.onSave(body);
      setText("");
      setOpen(false);
      setState("saved");
    } catch {
      setState("failed");
    }
  };
  return (
    <div class="cx-correct">
      {p.comments.length > 0 ? (
        <ul class="cx-comments">
          {p.comments.map((c) => (
            <li class={`cx-comment is-${c.state}`}>
              <span class="cx-comment-text">{c.text}</span>
              <span class="cx-comment-state cx-mono">{c.state === "answered" && c.answeredAt ? t("reader.answered", { date: p.fmtDate(Date.parse(c.answeredAt)) }) : t("reader.waitingRefresh")}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <div class="cx-correct-box">
          <textarea
            class="cx-textarea is-short"
            rows={3}
            placeholder={p.prompt ?? t("reader.correctPrompt")}
            aria-label={p.prompt ?? t("reader.correctPrompt")}
            value={text}
            onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <div class="cx-row-buttons">
            <button type="button" class="cx-button is-primary" disabled={state === "saving" || text.trim().length === 0} onClick={() => void save()}>
              {state === "saving" ? t("dialogs.saving") : t("reader.save")}
            </button>
            <button type="button" class="cx-button" onClick={() => setOpen(false)}>
              {t("reader.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div class="cx-row-buttons">
          {p.onLooksRight ? (
            <button
              type="button"
              class="cx-button"
              disabled={p.disabled || state === "marked"}
              onClick={() => {
                const run = p.onLooksRight;
                if (!run) return;
                run().then(
                  () => setState("marked"),
                  () => setState("failed"),
                );
              }}
            >
              {state === "marked" ? t("reader.marked") : t("reader.looksRight")}
            </button>
          ) : null}
          <button type="button" class="cx-button" disabled={p.disabled} onClick={() => setOpen(true)}>
            {t("reader.correct")}
          </button>
        </div>
      )}
      {state === "saved" ? <p class="cx-note" role="status">{p.saved ?? t("reader.correctSaved")}</p> : null}
      {state === "failed" ? <p class="cx-note is-error" role="alert">{t("dialogs.failed")}</p> : null}
    </div>
  );
}

// ───────────────────────────── labels ─────────────────────────────

/** Reader route of a note by its kind (maps, summaries → conversation, vault notes → peek). */
export function routeOfNoteKind(kind: NoteKind | string): ReaderRoute {
  return kind === "hub" ? "map" : kind === "gist" ? "conversation" : kind === "wiki" || kind === "reference" || kind === "log" ? "vault-peek" : "note";
}

/** A label value as words: lists joined with " · ", booleans yes / no. */
export function labelValueText(v: LabelValue): string {
  if (v === null) return t("reader.noValue");
  if (Array.isArray(v)) return v.join(" · ");
  if (typeof v === "boolean") return v ? t("reader.yes") : t("reader.no");
  return v;
}

export interface LabelChip {
  key: string;
  field: string;
  value: string;
  byUser: boolean;
  /** Held for your check (Settings › Agents › After labelling = Hold): shown, but counts nowhere yet. */
  held: boolean;
  /** Guessed by the No model rules (a dashed "rule" chip; a model run replaces it). */
  rule: boolean;
  title: string;
}

/**
 * The current labels as chips: one per (pack, field), your own label winning over a model's, the newest winning
 * otherwise; superseded labels and labels the model declined or left empty are not shown.
 */
export function labelChips(labels: readonly LabelView[]): LabelChip[] {
  const best = new Map<string, LabelView>();
  for (const l of labels) {
    const r = l.label;
    if (r.supersededBy || (r.state !== "set" && r.state !== "held") || r.value === null) continue;
    const key = `${r.pack}/${r.field}`;
    const cur = best.get(key);
    if (!cur || (l.byUser && !cur.byUser) || (l.byUser === cur.byUser && Date.parse(r.at) > Date.parse(cur.label.at))) best.set(key, l);
  }
  return [...best.entries()].map(([key, l]) => {
    const by = l.label.by;
    const who = "model" in by ? by.model : t("reader.you");
    const rule = "engine" in by && by.engine === "rule";
    return { key, field: l.label.field, value: labelValueText(l.label.value), byUser: l.byUser, held: l.label.state === "held", rule, title: rule ? t("reader.labelledByRule") : `${l.label.pack} ${l.label.packVersion} · ${who}` };
  });
}

export interface LabelField {
  target: string;
  pack: PackDef;
  field: PackField;
  current: LabelValue;
}

/** The fields the label pickers offer: the conversation's session pack, a note's placement, and Your fixes. */
export function labelFields(labels: readonly LabelView[], who: { entryId?: string; conversationId?: string; noteId?: string }): LabelField[] {
  const out: LabelField[] = [];
  const currentOf = (pack: string, field: string): LabelValue => {
    const chips = labels.filter((l) => l.label.pack === pack && l.label.field === field && !l.label.supersededBy && l.label.state === "set");
    const mine = chips.find((l) => l.byUser) ?? chips[chips.length - 1];
    return mine?.label.value ?? null;
  };
  const add = (packId: string, target: string | undefined) => {
    if (!target) return;
    const pack = findPack(packId);
    if (!pack) return;
    for (const field of pack.fields) out.push({ target, pack, field, current: currentOf(pack.id, field.key) });
  };
  add("session", who.conversationId);
  add("resume", who.conversationId);
  add("placement", who.noteId);
  add("correction", who.entryId ?? who.noteId ?? who.conversationId);
  return out;
}

export interface LabelChangeSpec {
  target: string;
  pack: string;
  packVersion: string;
  field: string;
  value: LabelValue;
}

function sameValue(a: LabelValue, b: LabelValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Parse a picker's text for a field type (multi = comma separated, capped to the field's maximum). */
export function parseFieldText(field: PackField, text: string): LabelValue {
  const v = text.trim();
  if (field.type === "multi") {
    const parts = v.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
    return parts.length === 0 ? null : parts.slice(0, field.maxValues ?? 5);
  }
  return v.length === 0 ? null : v.slice(0, 200);
}

/** Inline pickers per field (§5.14 Labels › Correct; §5.21 Change). */
export function LabelEditor(p: { fields: readonly LabelField[]; onSave(changes: LabelChangeSpec[]): Promise<void>; onCancel(): void; saveLabel?: string; /** "pack/field": the control to focus when the editor opens (the "+" on a blank row). */ focusField?: string }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p.focusField) return;
    const row = box.current?.querySelector<HTMLElement>(`[data-field="${p.focusField}"]`);
    row?.querySelector<HTMLElement>("input, button")?.focus();
    row?.scrollIntoView?.({ block: "nearest" });
  }, []);
  const [values, setValues] = useState<Record<string, LabelValue>>(() => Object.fromEntries(p.fields.map((f) => [`${f.target}|${f.pack.id}|${f.field.key}`, f.current])));
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const keyOf = (f: LabelField) => `${f.target}|${f.pack.id}|${f.field.key}`;
  const set = (f: LabelField, v: LabelValue) => setValues({ ...values, [keyOf(f)]: v });
  const changes = (): LabelChangeSpec[] =>
    p.fields.filter((f) => !sameValue(values[keyOf(f)] ?? null, f.current)).map((f) => ({ target: f.target, pack: f.pack.id, packVersion: f.pack.version, field: f.field.key, value: values[keyOf(f)] ?? null }));
  const save = async () => {
    setState("saving");
    try {
      await p.onSave(changes());
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  return (
    <div class="cx-label-editor" ref={box}>
      {p.fields.map((f) => {
        const v = values[keyOf(f)] ?? null;
        const id = `cx-field-${f.pack.id}-${f.field.key}`;
        return (
          <div class="cx-field-row" data-field={`${f.pack.id}/${f.field.key}`}>
            <label class="cx-field-label" for={id} title={f.field.description}>
              {f.field.label}
            </label>
            {f.field.type === "enum" ? (
              <MenuButton
                label={f.field.label}
                value={v === null ? t("reader.chooseValue") : labelValueText(v)}
                items={() => [
                  { value: "\u0000", label: t("reader.noValue"), checked: v === null },
                  ...(f.field.values ?? []).map((x) => ({ value: x, label: x, checked: v === x })),
                ]}
                onPick={(x: string) => set(f, x === "\u0000" ? null : x)}
              />
            ) : f.field.type === "bool" ? (
              <button type="button" role="switch" aria-checked={v === true} id={id} class={`cx-toggle${v === true ? " is-on" : ""}`} onClick={() => set(f, v !== true)}>
                <span class="cx-toggle-knob" />
              </button>
            ) : (
              <input
                id={id}
                class="cx-input is-inline"
                type="text"
                value={v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v)}
                placeholder={f.field.description}
                onInput={(e) => set(f, parseFieldText(f.field, (e.currentTarget as HTMLInputElement).value))}
              />
            )}
          </div>
        );
      })}
      <div class="cx-row-buttons">
        <button type="button" class="cx-button is-primary" disabled={state === "saving"} onClick={() => void save()}>
          {state === "saving" ? t("dialogs.saving") : p.saveLabel ?? t("reader.save")}
        </button>
        <button type="button" class="cx-button" onClick={p.onCancel}>
          {t("reader.cancel")}
        </button>
      </div>
      {state === "failed" ? (
        <p class="cx-note is-error" role="alert">
          {t("dialogs.failed")}
        </p>
      ) : null}
    </div>
  );
}

/** A comment fix on a summary, note or map (§5.15 Correct, §5.16 Flag). */
export function saveComment(s: CortexServices, target: string, text: string, via: "reader" | "map-flag" = "reader"): Promise<CorrectionRecord> {
  return s.corrections.apply({ via, action: "comment", target, payload: { text } });
}

/** Looks right: a confirm fix on a machine note (counts as checked). */
export function confirmNote(s: CortexServices, noteId: string): Promise<CorrectionRecord> {
  return s.corrections.apply({ via: "reader", action: "confirm", target: noteId, payload: { noteId: noteId as `n_${string}` } });
}
