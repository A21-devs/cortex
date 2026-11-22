/**
 * Settings › Sources › This vault's notes › Wiki folders and their areas: your rows that put a folder inside wiki/ (and
 * every folder inside it) into one of the ten fixed areas (settings `wikiAreas`, read by shared/spaces.ts
 * `spaceOfWikiPath`). One row per folder (its path, its area, Remove), then a row to add one.
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

/** Change row `i`'s folder. An empty path is one being retyped, and a folder another row has would repeat it: both keep the row as it was. */
export function setWikiAreaFolder(s: CortexSettings, i: number, folder: string): void {
  const row = s.wikiAreas[i];
  const f = normaliseWikiFolder(folder);
  if (!row || f === "" || f.length > WIKI_AREA_LIMITS.folder || s.wikiAreas.some((r, j) => j !== i && r.folder === f)) return;
  row.folder = f;
}

export function setWikiAreaArea(s: CortexSettings, i: number, area: string): void {
  const row = s.wikiAreas[i];
  if (row && isAreaId(area)) row.area = area;
}

export function removeWikiArea(s: CortexSettings, i: number): void {
  if (i >= 0 && i < s.wikiAreas.length) s.wikiAreas.splice(i, 1);
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
        tx.setValue(r.folder)
          .setPlaceholder(c.folderPlaceholder)
          .onChange((v) => host.set((x) => setWikiAreaFolder(x, i, v)));
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
