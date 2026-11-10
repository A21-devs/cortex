/**
 * New entry (CORTEX-UX §5.24, P2): write in your own words; it joins your record as yours, in
 * .raw/written/<yyyy>/<mm>/…, and is never rewritten. Title (optional), Area, the text, Save (Ctrl+Enter) and
 * Discard (asks first when there is text). A draft is kept per view every 2 s and restored when you come back.
 * Not available in the sample record. Owner: E12; data via NewEntryService (E3).
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { sheetBack } from "../../state/actions";
import { revealOwnEntry } from "../arrivals";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { confirm } from "../modals/ConfirmModal";
import { Button } from "../primitives/buttons";
import { Select } from "../primitives/controls";
import { openReader } from "../reader/readerKit";
import { areaLabel } from "../valueLabels";
import { ChangeSlot, PageFrame, useChange } from "./PageFrame";

/** A draft is saved to the leaf's draft slot this often while you type. */
export const DRAFT_INTERVAL_MS = 2000;
const NO_AREA = "none";

/** Save is enabled when the body has any non-space text. */
export function canSave(body: string): boolean {
  return body.trim().length > 0;
}

export function NewEntry(_p: { params: Readonly<Record<string, string>> }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const change = useChange();
  const sandbox = s.sandbox.value;
  const stored = useRef(s.newEntry.loadDraft(leaf.viewId));
  const [title, setTitle] = useState(stored.current?.title ?? "");
  const [body, setBody] = useState(stored.current?.body ?? "");
  const [space, setSpace] = useState(stored.current?.space ?? NO_AREA);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const dirty = useRef(false);

  // Keep a draft every 2 s while there are unsaved changes.
  useEffect(() => {
    if (!dirty.current) return;
    const id = setTimeout(() => {
      if (body.trim() || title.trim()) {
        s.newEntry.saveDraft(leaf.viewId, { title, body, space: space === NO_AREA ? undefined : space });
        dirty.current = false;
      }
    }, DRAFT_INTERVAL_MS);
    return () => clearTimeout(id);
  }, [title, body, space]);

  const edit = <V,>(set: (v: V) => void) => (v: V) => {
    dirty.current = true;
    set(v);
  };

  const save = async () => {
    if (!canSave(body) || saving || sandbox) return;
    setSaving(true);
    try {
      const res = await s.newEntry.save({ title: title.trim(), body, space: space === NO_AREA ? undefined : space });
      s.newEntry.clearDraft(leaf.viewId);
      dirty.current = false;
      setTitle("");
      setBody("");
      setSaved(res.entryId);
      revealOwnEntry(s, leaf.store, res.entryId);
      change.post(t("newEntry.saved"));
    } catch {
      change.post(t("newEntry.failed"));
    } finally {
      setSaving(false);
    }
  };

  const discard = async () => {
    if (canSave(body) || title.trim()) {
      const ok = await confirm(s.app, { title: t("newEntry.discardTitle"), confirm: t("newEntry.discard"), cancel: t("newEntry.keepWriting"), warning: true });
      if (!ok) return;
    }
    s.newEntry.clearDraft(leaf.viewId);
    dirty.current = false;
    sheetBack(leaf.store);
  };

  const areas = Object.keys(s.colours.current().space ?? {});
  return (
    <PageFrame subtitle={t("newEntry.subtitle")}>
      {sandbox ? <p class="cx-note">{t("newEntry.sample")}</p> : null}
      <div
        class="cx-new-entry"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <input class="cx-input" type="text" maxLength={200} placeholder={t("newEntry.titlePlaceholder")} aria-label={t("newEntry.titlePlaceholder")} value={title} disabled={sandbox} onInput={(e) => edit(setTitle)((e.currentTarget as HTMLInputElement).value)} />
        <Select label={t("newEntry.area")} value={space} options={[{ value: NO_AREA, label: areaLabel("none") }, ...areas.map((a) => ({ value: a, label: areaLabel(a) }))]} onChange={edit(setSpace)} />
        <textarea class="cx-textarea" aria-label={t("newEntry.body")} value={body} disabled={sandbox} onInput={(e) => edit(setBody)((e.currentTarget as HTMLTextAreaElement).value)} />
        <div class="cx-new-entry-actions">
          <Button primary disabled={!canSave(body) || saving || sandbox} onClick={() => void save()} title={t("newEntry.shortcut")}>
            {saving ? t("newEntry.saving") : t("newEntry.save")}
          </Button>
          <Button onClick={() => void discard()}>{t("newEntry.discard")}</Button>
          <span class="cx-note">{t("newEntry.shortcut")}</span>
          {saved ? (
            <button type="button" class="cx-text-button" onClick={() => openReader(leaf, "entry", saved)}>
              {t("read.open")}
            </button>
          ) : null}
        </div>
      </div>
      <ChangeSlot state={change} />
    </PageFrame>
  );
}
