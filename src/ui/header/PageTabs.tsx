/**
 * The header's page picker (CORTEX-UX §5.1, §8.3; ORIG-20). At XL and L the left rail (ui/nav) replaces the five
 * page tabs, so this renders nothing there. At M and S it is a button showing the active destination's name and a
 * chevron; it opens a menu of EVERY destination (the same thirteen the rail lists in "Show everything" order), with
 * the Checks badge as the Review row's detail and the activity and attention dots on the button. Owner: E11.
 */
import type { JSX } from "preact";
import { type PageId } from "../../shared/views";
import { useLeaf } from "../context";
import { t } from "../copy";
import { railVisible } from "../breakpoints";
import { navLabel, useNavExtras, useNavOpen } from "../nav/Nav";
import { activeNavItem, navPickerItems } from "../nav/navModel";
import { showMenu } from "../primitives/menu";

export { badgeText, sourcesNeedAttention } from "../nav/Nav";

export function pageLabel(id: PageId): string {
  return t(`pages.${id}`);
}

export function PageTabs(): JSX.Element | null {
  const leaf = useLeaf();
  const open = useNavOpen();
  const extras = useNavExtras();
  const ui = leaf.store.slices.ui.value;
  if (railVisible(ui.breakpoint, ui.immersive)) return null;
  const active = activeNavItem(ui);
  const name = active ? navLabel(active) : t("pages.picker");
  const tone = extras.lab?.tone;
  return (
    <button
      type="button"
      class="cx-page-picker"
      aria-haspopup="menu"
      aria-label={`${t("pages.picker")}: ${name}`}
      onClick={(e) =>
        showMenu(
          navPickerItems().map((id) => ({ value: id, label: navLabel(id), checked: active === id, detail: extras[id]?.badge })),
          e.currentTarget as HTMLElement,
          (id) => open(id),
        )
      }
    >
      <span>{name}</span>
      {tone ? <span class={`cx-tab-dot is-${tone}`} aria-hidden="true" /> : null}
      <span class="cx-select-caret" aria-hidden="true" />
    </button>
  );
}
