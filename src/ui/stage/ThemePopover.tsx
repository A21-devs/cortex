/**
 * Figure colour popover: the stage's palette button opens a small swatch menu of figure colour themes (Default and
 * the colour themes of shared/colourTheme.ts). One pick recolours only the figure's particles: the brain, the spine, the
 * body and nerve fibres, the haze and the record dots (they fade over a few hundred milliseconds). Everything else stays
 * as set in Settings > Appearance: the window theme, the stage ground, the rail, the key and the time strip, the charts
 * and the accent. It writes its own setting (`appearance.figureColours`), which only the render pipeline reads; Default
 * clears it. Both hosts open it from their top-right tool buttons.
 */
import type { JSX } from "preact";
import { SHELL } from "../breakpoints";
import { paletteDots } from "../../shared/palette";
import { activeColourTheme, applyColourTheme, COLOUR_THEMES, type ColourTheme, type ColourThemeId } from "../../shared/colourTheme";
import { openPopover } from "../../state/actions";
import { useLeaf, useServices } from "../context";
import { t, type CopyKey } from "../copy";
import { isDesktopHost } from "../host";
import { IconButton } from "../primitives/buttons";
import { Popover } from "../primitives/controls";

export const THEME_NAME: Readonly<Record<ColourThemeId, CopyKey>> = {
  default: "colourThemes.default",
  garnet: "colourThemes.garnet",
  sapphire: "colourThemes.sapphire",
  verdant: "colourThemes.verdant",
  saffron: "colourThemes.saffron",
  orchid: "colourThemes.orchid",
};

/** The four figure colours a swatch draws (and the first one as its edge); Default shows the person's own palette. */
export function swatchColours(theme: ColourTheme, ownPalette: Parameters<typeof paletteDots>[0]): { accent: string; dots: string[] } {
  const dots = paletteDots(theme.palette ?? ownPalette, 4);
  return { accent: dots[0] ?? "#8a5cf5", dots };
}

/** Pick a colour theme: one settings write, so the Settings cards and every consumer follow. */
export function pickColourTheme(s: ReturnType<typeof useServices>, id: ColourThemeId): void {
  void s.settings.update((x) => applyColourTheme(x.appearance, id)).catch(() => undefined);
}

export function ThemePopover(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const a = s.settings.value.appearance;
  const active = activeColourTheme(a);
  const own = a.palette;
  const close = () => openPopover(leaf.store, null);
  const g = SHELL.geometry;
  return (
    <Popover id="themes" label={t("colourThemes.title")} class="cx-theme-pop" style={isDesktopHost() ? undefined : { right: `${g.inset + g.tools.w + g.popover.gapToTools}px`, top: `${g.tools.top}px` }} onClose={close}>
      <header class="cx-popover-title">
        <h3>{t("colourThemes.title")}</h3>
        <IconButton icon="close" label={t("display.close")} onClick={close} />
      </header>
      <div class="cx-theme-grid" role="radiogroup" aria-label={t("colourThemes.title")}>
        {COLOUR_THEMES.map((c) => {
          const sw = swatchColours(c, own);
          const on = c.id === active;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={on}
              class={on ? "cx-theme-opt is-on" : "cx-theme-opt"}
              data-colour-theme={c.id}
              style={{ "--sw-accent": sw.accent }}
              onClick={() => pickColourTheme(s, c.id)}
            >
              <span class="cx-theme-opt-sw" aria-hidden="true">
                {sw.dots.map((d, i) => (
                  <i key={i} style={{ background: d }} />
                ))}
              </span>
              <span class="cx-theme-opt-name">{t(THEME_NAME[c.id])}</span>
            </button>
          );
        })}
      </div>
      <p class="cx-popover-foot">{t("colourThemes.hint")}</p>
    </Popover>
  );
}
