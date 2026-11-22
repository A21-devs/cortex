/**
 * Settings › Sources › This vault's notes › Wiki folders and their areas: your rows that put a folder inside wiki/ (and
 * every folder inside it) into one of the ten fixed areas (settings `wikiAreas`, read by shared/spaces.ts
 * `spaceOfWikiPath`). One row per folder (its path, its area, Remove), then a row to add one. A row's area is saved as
 * soon as it is chosen, its folder when the field is left or Enter is pressed, with the same checks as Add.
 *
 * Drawn by the settings tab inside the vault's own rows, right after Folders to skip (CORTEX-UX §5.27 Sources), rather
 * than through the extra-rows hook, which draws after a whole tab. The rows only edit settings: the vault part is built
 * again when they change (plugin/vaultSource.ts `watchWikiAreas`), and the runner reads them with every request.
 */
import type { CortexSettings } from "../../shared/settings";
import { AREA_IDS, isAreaId, normaliseWikiFolder, spaceName, WIKI_AREA_LIMITS, type AreaId } from "../../shared/spaces";
import { SETTINGS_COPY } from "../../ui/copy";
import type { SectionHost } from "./index";

const c = SETTINGS_COPY.wikiAreas;
const fill = (s: string, v: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? `{${k}}`));

/** The area choices, by name, in their fixed order. */
export function areaOptions(): Record<AreaId, string> {
  return Object.fromEntries(AREA_IDS.map((id) => [id, spaceName(id)])) as Record<AreaId, string>;
}

// The edits, pure on a settings draft (tested without a settings tab). Each one writes only rows the settings
// validator keeps as they are, so a save is never refused for them.

export type AddWikiArea = "added" | "missing" | "taken" | "full";

/** Add a row for `folder` (any slashes, trimmed). Nothing changes for an empty folder, a folder already listed or a full list. */
export function addWikiArea(s: CortexSettings, folder: string, area: AreaId): AddWikiArea {
  const f = normaliseWikiFolder(folder);
  if (f === "" || f.length > WIKI_AREA_LIMITS.folder) return "missing";
  if (s.wikiAreas.some((r) => r.folder === f)) return "taken";
  if (s.wikiAreas.length >= WIKI_AREA_LIMITS.rows) return "full";
  s.wikiAreas.push({ folder: f, area });
  return "added";
}

export type SetWikiAreaFolder = "set" | "missing" | "taken" | "gone";

/**
 * Change row `i`'s folder (any slashes, trimmed), with the checks Add makes. Nothing changes for an empty or overlong
 * folder, a folder another row has, or a row that is no longer there.
 */
export function setWikiAreaFolder(s: CortexSettings, i: number, folder: string): SetWikiAreaFolder {
  const row = s.wikiAreas[i];
  if (!row) return "gone";
  const f = normaliseWikiFolder(folder);
  if (f === "" || f.length > WIKI_AREA_LIMITS.folder) return "missing";
  if (s.wikiAreas.some((r, j) => j !== i && r.folder === f)) return "taken";
  row.folder = f;
  return "set";
}

export function setWikiAreaArea(s: CortexSettings, i: number, area: string): void {
  const row = s.wikiAreas[i];
  if (row && isAreaId(area)) row.area = area;
}

export function removeWikiArea(s: CortexSettings, i: number): void {
  if (i >= 0 && i < s.wikiAreas.length) s.wikiAreas.splice(i, 1);
}

/**
 * Save row `i`'s folder as typed. Checked against the saved rows, like Add: another row's folder may have been edited
 * since these were drawn. A refused folder gets the reason, and the field then shows the folder as saved (tidied, or the
 * row's own again when refused).
 */
function commitFolder(host: SectionHost, i: number, typed: string, show: (saved: string) => void): void {
  host.set((x) => {
    const done = setWikiAreaFolder(x, i, typed);
    if (done === "missing") host.notify(c.missing);
    else if (done === "taken") host.notify(fill(c.taken, { folder: normaliseWikiFolder(typed) }));
    const saved = x.wikiAreas[i]?.folder;
    if (saved !== undefined) show(saved);
  });
}

/** The heading, one row per folder, then the row that adds one (or the limit once the list is full). */
export function renderWikiAreas(host: SectionHost, s: CortexSettings): void {
  const rows = s.wikiAreas;
  const options = areaOptions();
  host.heading(c.heading, c.headingDesc);
  if (rows.length === 0) host.mount.createEl("p", { cls: "cx-note", text: c.empty });
  rows.forEach((r, i) => {
    host
      .row(fill(c.rowLabel, { n: i + 1, total: rows.length }))
      .addText((tx) => {
        tx.inputEl?.setAttribute?.("aria-label", c.folder);
        tx.setValue(r.folder).setPlaceholder(c.folderPlaceholder);
        // Saved when the field is left or Enter is pressed (the input's change event), never key by key: a half-typed
        // folder is neither saved nor placed in the figure.
        tx.inputEl?.addEventListener?.("change", () => commitFolder(host, i, tx.getValue(), (saved) => tx.setValue(saved)));
      })
      .addDropdown((d) => {
        d.selectEl?.setAttribute?.("aria-label", c.area);
        d.addOptions(options)
          .setValue(r.area)
          .onChange((v) => host.set((x) => setWikiAreaArea(x, i, v)));
      })
      .addExtraButton((b) =>
        b.setIcon?.("x")?.setTooltip?.(c.remove)?.onClick(() => {
          host.set((x) => removeWikiArea(x, i));
          host.refresh();
        }),
      );
  });
  if (rows.length >= WIKI_AREA_LIMITS.rows) {
    host.mount.createEl("p", { cls: "cx-note", text: fill(c.limit, { n: WIKI_AREA_LIMITS.rows }) });
    return;
  }
  let folder = "";
  let area: AreaId = AREA_IDS[0] ?? "vault";
  const add = (): void => {
    const f = normaliseWikiFolder(folder);
    if (f === "" || f.length > WIKI_AREA_LIMITS.folder) return host.notify(c.missing);
    const chosen = area;
    // Checked against the saved rows, not the ones drawn: a row's folder may have been edited since they were drawn.
    host.set((x) => {
      const done = addWikiArea(x, f, chosen);
      if (done === "taken") host.notify(fill(c.taken, { folder: f }));
      else if (done === "full") host.notify(fill(c.limit, { n: WIKI_AREA_LIMITS.rows }));
    });
    host.refresh();
  };
  host
    .row(c.add, c.addDesc)
    .addText((tx) => {
      tx.inputEl?.setAttribute?.("aria-label", c.folder);
      tx.setPlaceholder(c.folderPlaceholder).onChange((v) => (folder = v));
    })
    .addDropdown((d) => {
      d.selectEl?.setAttribute?.("aria-label", c.area);
      d.addOptions(options)
        .setValue(area)
        .onChange((v) => {
          if (isAreaId(v)) area = v;
        });
    })
    .addButton((b) => b.setButtonText(c.addButton).setCta().onClick(add));
}
