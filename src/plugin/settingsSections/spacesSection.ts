/**
 * Settings > General > Your spaces: the list of the person's own spaces (shared/userSpaces.ts). Each one has a name, what it
 * gathers (areas by name, folders by path), an optional colour theme and data palette to show while it is chosen, and
 * move up, move down and delete. A space can be added with a name. The rows only edit settings; the wordmark, the scope
 * chip and the space cycle read the list from there.
 */
import { PALETTES, TINT_IDS } from "../../shared/palette";
import type { CortexSettings, PaletteId } from "../../shared/settings";
import { formatMembers, isPaletteId, isTintId, newUserSpace, parseMembers, USER_SPACE_LIMITS, type UserSpace } from "../../shared/userSpaces";
import { COPY } from "../../ui/copy";
import type { SectionHost, SectionRow } from "./index";

const c = COPY.userSpaces;
const fill = (s: string, v: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k] ?? `{${k}}`));

/** The theme choices: "none" keeps the person's own look, then the five colour themes. */
export function themeOptions(): Record<string, string> {
  const out: Record<string, string> = { none: c.themeNone };
  for (const id of TINT_IDS) out[id] = COPY.colourThemes[id];
  return out;
}

/** The palette choices: "none" follows the theme, then every data palette by name. */
export function paletteOptions(): Record<string, string> {
  const out: Record<string, string> = { none: c.paletteNone };
  for (const p of PALETTES) out[p.id] = paletteName(p.id);
  for (const id of TINT_IDS) out[id] = COPY.colourThemes[id];
  return out;
}

function paletteName(id: PaletteId): string {
  const pal = COPY.display.pal as Readonly<Record<string, string>>;
  return pal[id] ?? (COPY.colourThemes as Readonly<Record<string, string>>)[id] ?? id;
}

// The edits, pure on a settings draft (tested without a settings tab).

export function addSpace(s: CortexSettings, name: string): UserSpace | null {
  if (s.userSpaces.length >= USER_SPACE_LIMITS.spaces) return null;
  const sp = newUserSpace(s.userSpaces, name);
  s.userSpaces.push(sp);
  return sp;
}

export function renameSpace(s: CortexSettings, id: string, name: string): void {
  const sp = s.userSpaces.find((u) => u.id === id);
  const clean = name.replace(/\s+/g, " ").trim().slice(0, USER_SPACE_LIMITS.name);
  // An empty name is a name being retyped, not a request to lose the space.
  if (sp && clean !== "") sp.name = clean;
}

export function setMembers(s: CortexSettings, id: string, text: string): void {
  const sp = s.userSpaces.find((u) => u.id === id);
  if (!sp) return;
  const m = parseMembers(text);
  sp.areas = m.areas;
  sp.folders = m.folders;
}

export function setLook(s: CortexSettings, id: string, look: { theme?: string; palette?: string }): void {
  const sp = s.userSpaces.find((u) => u.id === id);
  if (!sp) return;
  if (look.theme !== undefined) {
    if (isTintId(look.theme)) sp.theme = look.theme;
    else delete sp.theme;
  }
  if (look.palette !== undefined) {
    if (isPaletteId(look.palette)) sp.palette = look.palette;
    else delete sp.palette;
  }
}

export function moveSpace(s: CortexSettings, id: string, dir: -1 | 1): void {
  const i = s.userSpaces.findIndex((u) => u.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= s.userSpaces.length) return;
  const [item] = s.userSpaces.splice(i, 1);
  if (item) s.userSpaces.splice(j, 0, item);
}

export function deleteSpace(s: CortexSettings, id: string): void {
  s.userSpaces = s.userSpaces.filter((u) => u.id !== id);
}

function render(host: SectionHost, s: CortexSettings): void {
  const list = s.userSpaces;
  host.heading(c.heading, c.headingDesc);
  if (list.length === 0) host.mount.createEl("p", { cls: "cx-note", text: c.empty });
  list.forEach((sp, i) => {
    const gathers = sp.areas.length + sp.folders.length > 0;
    const head = host.row(fill(c.rowLabel, { n: i + 1, total: list.length, name: sp.name }), gathers ? undefined : c.emptyHint);
    head.addText((tx) => tx.setValue(sp.name).setPlaceholder(c.namePlaceholder).onChange((v) => host.set((x) => renameSpace(x, sp.id, v))));
    head.addExtraButton((b) =>
      b.setIcon?.("arrow-up")?.setTooltip?.(c.moveUp)?.setDisabled?.(i === 0)?.onClick(() => {
        host.set((x) => moveSpace(x, sp.id, -1));
        host.refresh();
      }),
    );
    head.addExtraButton((b) =>
      b.setIcon?.("arrow-down")?.setTooltip?.(c.moveDown)?.setDisabled?.(i === list.length - 1)?.onClick(() => {
        host.set((x) => moveSpace(x, sp.id, 1));
        host.refresh();
      }),
    );
    head.addExtraButton((b) =>
      b.setIcon?.("trash")?.setTooltip?.(c.remove)?.onClick(() => {
        host.set((x) => deleteSpace(x, sp.id));
        host.notify(fill(c.removed, { name: sp.name }));
        host.refresh();
      }),
    );
    host.row(c.members, c.membersDesc).addText((tx) => tx.setValue(formatMembers(sp)).setPlaceholder(c.membersPlaceholder).onChange((v) => host.set((x) => setMembers(x, sp.id, v))));
    host.dropdown(c.theme, undefined, themeOptions(), sp.theme ?? "none", (x, v) => setLook(x, sp.id, { theme: v }));
    host.dropdown(c.palette, undefined, paletteOptions(), sp.palette ?? "none", (x, v) => setLook(x, sp.id, { palette: v }));
  });
  if (list.length < USER_SPACE_LIMITS.spaces) {
    let draft = "";
    const add = (): void => {
      const name = draft.trim();
      if (name === "") return;
      host.set((x) => void addSpace(x, name));
      host.refresh();
    };
    host.row(c.add, c.addDesc).addText((tx) => tx.setPlaceholder(c.namePlaceholder).onChange((v) => (draft = v))).addButton((b) => b.setButtonText(c.add).setCta().onClick(add));
  } else host.mount.createEl("p", { cls: "cx-note", text: fill(c.limit, { n: USER_SPACE_LIMITS.spaces }) });
}

export const spacesRows: SectionRow[] = [{ id: "user-spaces", section: "general", order: 60, render }];
