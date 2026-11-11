/**
 * Extra Settings rows per tab, so a feature adds its rows without editing settingsTab.ts. The tab calls
 * `renderExtraRows` after a section's own rows; a feature writes `<name>Section.ts` exporting `SectionRow[]` and adds one
 * import and one entry to PROVIDERS below. A row that throws is skipped (the section still draws) and reported by
 * `onError`. No visible change until a provider exists.
 */
import type { Setting } from "obsidian";
import type { CortexSettings } from "../../shared/settings";
import type { CortexServices } from "../services";
import { heirRows } from "./heirSection";
import { keySharesRows } from "./keySharesSection";
import { lockRows } from "./lockSection";
import { privacyRows } from "./privacySection";
import { spacesRows } from "./spacesSection";

/** The sections that take extra rows. */
export const EXTRA_SECTIONS = ["general", "lock", "privacy", "agents", "capture", "advanced"] as const;
export type ExtraSection = (typeof EXTRA_SECTIONS)[number];

/** What a row needs from the settings tab (the same helpers the tab's own rows use). */
export interface SectionHost {
  /** The element rows are built into. */
  readonly mount: HTMLElement;
  /** True in Cortex Desktop. */
  readonly desktopHost: boolean;
  set(patch: (s: CortexSettings) => void): void;
  /** Re-render after a change that adds or removes rows. */
  refresh(): void;
  notify(text: string): void;
  row(name: string, desc?: string): Setting;
  heading(name: string, desc?: string): void;
  toggle(name: string, desc: string | undefined, value: boolean, apply: (s: CortexSettings, v: boolean) => void, disabled?: boolean): void;
  dropdown<V extends string>(name: string, desc: string | undefined, options: Record<V, string>, value: V, apply: (s: CortexSettings, v: V) => void, rerender?: boolean): void;
  text(name: string, desc: string | undefined, value: string, placeholder: string, apply: (s: CortexSettings, v: string) => void): void;
  slider(name: string, desc: string | undefined, range: readonly [number, number], step: number, value: number, apply: (s: CortexSettings, v: number) => void): void;
  services(): Promise<CortexServices>;
  /** Go to another tab of the Settings window (absent in a host without tabs). */
  goTo?(tab: string): void;
}

export interface SectionRow {
  /** Stable id (for tests and for ordering ties). */
  id: string;
  section: ExtraSection;
  /** Lower draws first; rows with the same order draw by id. */
  order?: number;
  /** Return false to draw nothing (for example a desktop-only row in the plugin). */
  when?(s: CortexSettings, host: SectionHost): boolean;
  render(host: SectionHost, s: CortexSettings): void;
}

/** One entry per feature file: `[...lockRows, ...privacyRows]`. Kept sorted by order, then id, when read. */
const PROVIDERS: readonly (readonly SectionRow[])[] = [lockRows, keySharesRows, heirRows, spacesRows, privacyRows];

let extra: SectionRow[] = [];

/** Register rows at run time (tests, and features that load lazily). Returns a function that removes them again. */
export function registerSectionRows(rows: readonly SectionRow[]): () => void {
  extra = [...extra, ...rows];
  return () => {
    extra = extra.filter((r) => !rows.includes(r));
  };
}

/** The rows for one section in draw order. */
export function extraRows(section: ExtraSection | string): SectionRow[] {
  const all = [...PROVIDERS.flat(), ...extra].filter((r) => r.section === section);
  return all.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

export function isExtraSection(id: string): id is ExtraSection {
  return (EXTRA_SECTIONS as readonly string[]).includes(id);
}

/** Draw the extra rows of `section` into the host. A failing row is skipped and handed to `onError`. */
export function renderExtraRows(host: SectionHost, section: string, s: CortexSettings, onError: (id: string, e: unknown) => void = () => undefined): void {
  if (!isExtraSection(section)) return;
  for (const row of extraRows(section)) {
    try {
      if (row.when && !row.when(s, host)) continue;
      row.render(host, s);
    } catch (e) {
      onError(row.id, e);
    }
  }
}
