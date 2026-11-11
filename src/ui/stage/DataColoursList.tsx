/**
 * "Data colours": seven named rows, each a stripe of the palette's first seven colours, the one in use outlined.
 * A click writes `appearance.palette` and nothing else (the window theme and the Stage tint are untouched, so any
 * theme goes with any palette) and posts "‹name› data colours · Undo". Resting on a row, or arrowing onto it, shows
 * it on the figure without saving (the settings handle's preview); leaving ends the preview. Up and Down move
 * between rows, Enter or Space picks. Exported on its own so the colour theme popover can embed the same list.
 */
import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { dataColourRows, stepDataColour } from "../../shared/palette";
import type { PaletteId } from "../../shared/settings";
import { useServices, useShell } from "../context";
import { t } from "../copy";

/** The display name of a data palette. */
export function paletteName(id: PaletteId): string {
  switch (id) {
    case "prism":
      return t("display.pal.prism");
    case "signal":
      return t("display.pal.signal");
    case "harbor":
      return t("display.pal.harbor");
    case "orchard":
      return t("display.pal.orchard");
    case "ember":
      return t("display.pal.ember");
    case "reef":
      return t("display.pal.reef");
    case "print":
      return t("display.pal.print");
    default:
      return id;
  }
}

export function DataColoursList(p: { class?: string }): JSX.Element {
  const s = useServices();
  const shell = useShell();
  const current = s.settings.value.appearance.palette;
  const rows = dataColourRows(current);
  // Whatever happens, a preview never outlives the list.
  useEffect(() => () => s.settings.endPreview?.(), [s]);
  const preview = (id: PaletteId) => {
    if (id !== s.settings.value.appearance.palette) s.settings.preview?.((x) => void (x.appearance.palette = id));
  };
  const endPreview = () => s.settings.endPreview?.();
  const pick = (id: PaletteId) => {
    const before = s.settings.value.appearance.palette;
    if (id === before) return;
    void s.settings
      .update((x) => void (x.appearance.palette = id))
      .then(() => {
        const undoId = shell.pushUndo(() => void s.settings.update((x) => void (x.appearance.palette = before)).catch(() => undefined));
        shell.toast({ kind: "change", text: t("display.dataColoursSet", { name: paletteName(id) }), undo: () => void shell.runUndo(undoId) });
      })
      .catch(() => undefined);
  };
  const move = (e: KeyboardEvent, id: PaletteId) => {
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const next = stepDataColour(id, dir);
    const list = (e.currentTarget as HTMLElement).parentElement;
    list?.querySelector<HTMLElement>(`[data-palette="${next}"]`)?.focus();
  };
  return (
    <div class={`cx-data-colours${p.class ? ` ${p.class}` : ""}`} role="radiogroup" aria-label={t("display.dataColours")} onPointerLeave={endPreview}>
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          role="radio"
          aria-checked={r.selected}
          tabIndex={r.selected || (rows.every((x) => !x.selected) && r.id === rows[0]?.id) ? 0 : -1}
          class={`cx-data-colour${r.selected ? " is-on" : ""}`}
          data-palette={r.id}
          onPointerEnter={() => preview(r.id)}
          onFocus={() => preview(r.id)}
          onBlur={endPreview}
          onKeyDown={(e) => move(e as unknown as KeyboardEvent, r.id)}
          onClick={() => pick(r.id)}
        >
          <span class="cx-data-colour-name">{paletteName(r.id)}</span>
          <span class="cx-data-colour-stripe" aria-hidden="true">
            {r.stripe.map((hex, i) => (
              <i key={i} style={{ background: hex }} />
            ))}
          </span>
        </button>
      ))}
    </div>
  );
}
