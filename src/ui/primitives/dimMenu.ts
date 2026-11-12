/**
 * The dimension menu (CORTEX-UX §7.3; ORIG-14), shared by the key bar pickers, the shape bar's Groups picker and
 * the chart zones. Owner: E11. Grouped by provenance: Date ▸ (Day · Week · Month · Year, Rhythm: Hour · Weekday · Calendar month,
 * and a Written · Imported switch at its foot) · From the file · From the conversation · From the agents (each
 * enabled model-written pack field) · From you · All fields… (a searchable list with each field's source and,
 * when known, its coverage). Submenus use MenuItem.setSubmenu where the running Obsidian has it; otherwise the
 * Date items appear as a labelled flat section (menu.tsx). Callers add their own trailing sections (the key bar's
 * colour options, the shape bar's Layout section).
 */
import type { App } from "obsidian";
import { BUILTIN_DIMS, DATE_GRAINS, dateDim, DIM_GROUP_ORDER, isDateDim, isRhythmGrain, labelDim, parseDateDim, RESUME_DIM, RHYTHM_GRAINS, ROLE_DIM, type DateBasis, type DimGroup, type DimId } from "../../shared/dims";
import { STARTER_PACKS } from "../../shared/packs";

const RESUME_PACK_ID = "resume";
import type { CortexSettings } from "../../shared/settings";
import type { PackDef } from "../../shared/types";
import { t, type CopyKey } from "../copy";
import { dimLabel } from "../valueLabels";
import { showMenu, type MenuItemSpec, type ShowMenuOptions } from "./menu";

export interface DimMenuModel {
  date: { grains: { id: DimId; label: string }[]; rhythm: { id: DimId; label: string }[]; basis: DateBasis };
  sections: { group: Exclude<DimGroup, "date">; label: string; items: { id: DimId; label: string }[] }[];
}

/** Packs that colour and group: enabled in Settings › Agents (version ≠ "off"). */
export function enabledPacks(settings: Pick<CortexSettings, "agents">): PackDef[] {
  return STARTER_PACKS.filter((p) => {
    const v = settings.agents.enabledPacks[p.id];
    return typeof v === "string" && v !== "off";
  });
}

/**
 * Build the menu model. Model-written pack fields go under From the agents; fields Cortex derives from the vault's
 * own settings (PARA) go under From the file; the user-only pack is "Your fixes", already under From you.
 */
export function dimMenuModel(packs: readonly PackDef[], basis: DateBasis = "written"): DimMenuModel {
  const sections = DIM_GROUP_ORDER.filter((g): g is Exclude<DimGroup, "date"> => g !== "date").map((group) => {
    const items = BUILTIN_DIMS.filter((d) => d.group === group).map((d) => ({ id: d.id, label: dimLabel(d.id) }));
    const writer = group === "agents" ? "model" : group === "file" ? "derived" : null;
    // The résumé pack is model-written but has its own section, and the item is always offered (empty it reads "No value").
    if (writer) for (const p of packs.filter((x) => x.writer === writer && x.id !== RESUME_PACK_ID)) for (const f of p.fields) items.push({ id: labelDim(p.id, f.key), label: labelDim(p.id, f.key) === ROLE_DIM ? t("dims.function") : f.label });
    if (group === "resume") items.push({ id: RESUME_DIM, label: t("dims.resumeItem") });
    return { group, label: t(`dimGroups.${group}` as CopyKey), items };
  });
  return {
    date: {
      grains: DATE_GRAINS.map((g) => ({ id: dateDim(g, basis), label: dimLabel(g) })),
      rhythm: RHYTHM_GRAINS.map((g) => ({ id: g as DimId, label: dimLabel(g) })),
      basis,
    },
    sections,
  };
}

/** Flat fallback when setSubmenu is unavailable: one labelled section per group. */
export function flatDimItems(model: DimMenuModel): MenuItemSpec<DimId>[] {
  const out: MenuItemSpec<DimId>[] = [];
  for (const it of [...model.date.grains, ...model.date.rhythm]) out.push({ value: it.id, label: it.label, group: "date" });
  for (const s of model.sections) for (const it of s.items) out.push({ value: it.id, label: it.label, group: s.group });
  return out;
}

/** How long the pointer rests on a dimension before the key previews it (FIG-36). */
export const DIM_HOVER_MS = 80;

/** Menu values besides dimension ids. */
export const DIM_MENU = {
  allFields: "dim:all-fields",
  basisWritten: "dim:basis-written",
  basisImported: "dim:basis-imported",
} as const;

/** The Date ▸ submenu, the provenance sections and All fields…, with the current dimension checked. */
export function dimMenuItems(model: DimMenuModel, current: DimId | null): MenuItemSpec[] {
  const dateLabel = t("dims.date");
  const dateChildren: MenuItemSpec[] = [
    ...model.date.grains.map((g) => ({ value: g.id, label: g.label, checked: g.id === current, group: "grain" })),
    ...model.date.rhythm.map((g) => ({ value: g.id, label: g.label, checked: g.id === current, group: "rhythm", groupLabel: t("dims.rhythm") })),
    { value: DIM_MENU.basisWritten, label: t("dims.written"), checked: model.date.basis === "written", group: "basis" },
    { value: DIM_MENU.basisImported, label: t("dims.imported"), checked: model.date.basis === "imported", group: "basis" },
  ];
  const items: MenuItemSpec[] = [{ value: "dim:date", label: dateLabel, checked: current !== null && isDateDim(current), submenu: dateChildren, group: "date" }];
  for (const s of model.sections) {
    for (const it of s.items) items.push({ value: it.id, label: it.label, checked: it.id === current, group: s.group, groupLabel: s.label });
  }
  items.push({ value: DIM_MENU.allFields, label: t("key.allFields"), group: "all" });
  return items;
}

/** The date dimension a basis switch lands on: the same grain on the other basis (Month · Imported …). */
export function switchBasis(current: DimId | null, basis: DateBasis): DimId {
  const parsed = current ? parseDateDim(current) : null;
  const grain = parsed && !isRhythmGrain(parsed.grain) ? parsed.grain : "month";
  return dateDim(grain, basis);
}

export interface DimMenuOptions {
  app: App;
  settings: Pick<CortexSettings, "agents">;
  current: DimId | null;
  basis?: DateBasis;
  onPick(dim: DimId): void;
  /** A dimension is pointed at (after `hoverDelayMs`, 80 by default) or the pointer leaves it / the menu closes (null): the key's live preview. */
  onHover?(dim: DimId | null): void;
  /** Trailing sections (key options, Layout); their values reach `onExtra`. */
  extras?: MenuItemSpec[];
  onExtra?(value: string): void;
  coverage?: Readonly<Record<string, number>>;
  menu?: ShowMenuOptions<string>;
}

/** Open the dimension menu under `anchor`. */
export function openDimMenu(anchor: HTMLElement, o: DimMenuOptions): void {
  const basis = o.basis ?? (o.current ? (parseDateDim(o.current)?.basis ?? "written") : "written");
  const model = dimMenuModel(enabledPacks(o.settings), basis);
  const items = [...dimMenuItems(model, o.current), ...(o.extras ?? [])];
  const onHover = o.onHover;
  const menu: ShowMenuOptions<string> | undefined = onHover
    ? {
        ...o.menu,
        hoverDelayMs: o.menu?.hoverDelayMs ?? DIM_HOVER_MS,
        onHover: (v) => {
          o.menu?.onHover?.(v);
          onHover(v !== null && isDimValue(v, model) ? (v as DimId) : null);
        },
        onHide: () => {
          onHover(null);
          o.menu?.onHide?.();
        },
      }
    : o.menu;
  showMenu(
    items,
    anchor,
    (v) => {
      if (v === DIM_MENU.allFields) openAllFields(o.app, model, o.onPick, o.coverage);
      else if (v === DIM_MENU.basisWritten || v === DIM_MENU.basisImported) o.onPick(switchBasis(o.current, v === DIM_MENU.basisImported ? "imported" : "written"));
      else if (isDimValue(v, model)) o.onPick(v as DimId);
      else o.onExtra?.(v);
    },
    menu,
  );
}

function isDimValue(v: string, model: DimMenuModel): boolean {
  if (model.date.grains.some((g) => g.id === v) || model.date.rhythm.some((g) => g.id === v)) return true;
  return model.sections.some((s) => s.items.some((it) => it.id === v));
}

export interface FieldRow {
  id: DimId;
  label: string;
  source: string;
  coverage?: number;
}

/** Every field with its provenance ("From the agents") and coverage, for All fields…. */
export function allFieldRows(model: DimMenuModel, coverage?: Readonly<Record<string, number>>): FieldRow[] {
  const date = t("dims.date");
  const rows: FieldRow[] = [...model.date.grains, ...model.date.rhythm].map((g) => ({ id: g.id, label: g.label, source: date }));
  for (const s of model.sections) for (const it of s.items) rows.push({ id: it.id, label: it.label, source: s.label, coverage: coverage?.[it.id] });
  return rows;
}

/** All fields…: Obsidian's own fuzzy picker (the class is created on first use, outside module evaluation). */
export function openAllFields(app: App, model: DimMenuModel, onPick: (dim: DimId) => void, coverage?: Readonly<Record<string, number>>): void {
  void import("obsidian").then(({ FuzzySuggestModal }) => {
    if (typeof FuzzySuggestModal !== "function") return;
    const rows = allFieldRows(model, coverage);
    class AllFields extends FuzzySuggestModal<FieldRow> {
      getItems(): FieldRow[] {
        return rows;
      }
      getItemText(r: FieldRow): string {
        const cov = r.coverage === undefined ? "" : ` · ${t("dims.coverage", { p: Math.round(r.coverage * 100) })}`;
        return `${r.label} · ${r.source}${cov}`;
      }
      onChooseItem(r: FieldRow): void {
        onPick(r.id);
      }
    }
    const m = new AllFields(app);
    m.setPlaceholder(t("key.allFields"));
    m.open();
  });
}
