/**
 * The left rail (XL, L; about 168 px): the wordmark (bold "cortex" and the area as a light suffix), the search field, the space chip, the nav list, "Show everything", and two meters when the
 * data to back them exists. At M and S the header's page picker (header/PageTabs.tsx) lists the same destinations.
 *
 * The list is role="navigation" with a vertical roving tab index (Up and Down move, Home and End jump, Enter or
 * Space opens). The active destination comes from the sheet (navModel.activeNavItem); it is brighter, semibold,
 * with a short bar in the page's hue (--cx-cat-N). Write and Today share one row. Carried over from the old page
 * tabs: the Agents activity dot and the Checks badge now sit on Lab and Review; the Sources attention dot on
 * + Add and Files. "Show everything" and the More group persist per leaf (state/persist.ts).
 * Meters (Organised, Checks done) come from the ledger's work-waiting totals and are left out when there are none.
 */
import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import { Notice } from "obsidian";
import { featureOn } from "../../shared/features";
import { setCommandMode, setNavFull, setNavMore } from "../../state/actions";
import type { ActivityState, QueueState } from "../../state/types";
import { useLeaf, useServices, useShell } from "../context";
import { t, type CopyKey } from "../copy";
import { focusCommandLine } from "../keymap";
import { chipState, chipText, chipTone } from "../header/AgentChip";
import { openAddSources } from "../header/addSources";
import { ScopePicker } from "../header/ScopePicker";
import { Icon } from "../primitives/buttons";
import { Toggle, rovingKeyDown, useRoving } from "../primitives/controls";
import { loaded, useLoad } from "../pages/PageFrame";
import { activeNavItem, navRows, NAV_SLOT, openNavItem, type NavItemId } from "./navModel";
import { isDesktopHost } from "../host";
import { RailSearch } from "./RailSearch";
import { ActivityRing } from "./ActivityRing";
import { RailStatus } from "./RailStatus";
import { RailWordmark, useRailPalette } from "./RailWordmark";

export function navLabel(id: NavItemId): string {
  return t(`nav.${id}` as CopyKey);
}

/** Checks badge text: nothing at 0, "99+" above 99. */
export function badgeText(n: number): string | null {
  return n <= 0 ? null : n > 99 ? "99+" : String(n);
}

/** A source needs attention: a warning is pending, the background worker is off, or settings are unreadable. */
export function sourcesNeedAttention(a: ActivityState): boolean {
  return a.lastWarning !== undefined || a.runner === "unavailable" || a.settingsCorrupt;
}

/** What a destination carries besides its name. */
export interface NavExtra {
  /** Unresolved checks, capped ("99+"). */
  badge?: string;
  /** The agents' activity dot (green running, amber held, red trouble). */
  tone?: "running" | "held" | "trouble";
  /** Red dot: a source needs attention. */
  attention?: boolean;
  /** Spoken extras, for the accessible name ("Lab, Organising · 2 jobs"). */
  say: string[];
}

/** The dots and badge of the old page tabs, now on Lab, Review, + Add and Files. */
export function navExtras(p: { activity: ActivityState; queues: QueueState; agentsEnabled: boolean; firstRunDone: boolean; checksOn?: boolean }): Partial<Record<NavItemId, NavExtra>> {
  const state = chipState(p.activity, p.agentsEnabled);
  const tone = p.firstRunDone ? chipTone(state) : null;
  const badge = (p.checksOn ?? featureOn("checks")) ? badgeText(p.queues.checks) : null;
  const attention = sourcesNeedAttention(p.activity);
  const out: Partial<Record<NavItemId, NavExtra>> = {};
  if (tone) out.lab = { tone, say: [chipText(state, 0) ?? ""].filter(Boolean) };
  if (badge) out.review = { badge, say: [t("header.checksBadge", { n: p.queues.checks })] };
  if (attention) {
    const say = [t("sources.needsAttention")];
    out.add = { attention: true, say };
    out.files = { attention: true, say };
  }
  return out;
}

/** The two meters: share of conversations and notes filed, and share of machine labels you have checked. */
export function navMeters(rows: readonly { checked: number; done: number; waiting: number }[]): { organised: number | null; checksDone: number | null } {
  let checked = 0, done = 0, waiting = 0;
  for (const r of rows) {
    checked += r.checked;
    done += r.done;
    waiting += r.waiting;
  }
  const filed = checked + done;
  return { organised: filed + waiting > 0 ? Math.round((filed / (filed + waiting)) * 100) : null, checksDone: filed > 0 ? Math.round((checked / filed) * 100) : null };
}

/** Open a destination from anywhere in the shell (rail, page picker). */
export function useNavOpen(): (id: NavItemId) => void {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  return (id) =>
    openNavItem(leaf.store, id, {
      add: () => void openAddSources(s, leaf.store),
      ask: () => {
        if (!featureOn("ask")) return;
        setCommandMode(leaf.store, "ask");
        focusCommandLine(shell);
      },
      canWrite: () => {
        if (!s.sandbox.value) return true;
        new Notice(t("ask.sample"));
        return false;
      },
    });
}

/** Extras of the current activity, queues and settings. */
export function useNavExtras(): Partial<Record<NavItemId, NavExtra>> {
  const s = useServices();
  return navExtras({
    activity: s.shared.slices.activity.value,
    queues: s.shared.slices.queues.value,
    agentsEnabled: s.settings.value.agents.enabled,
    firstRunDone: s.settings.value.general.firstRunDone,
  });
}

function NavButton(p: { id: NavItemId; active: boolean; extra?: NavExtra; onOpen(id: NavItemId): void }): JSX.Element {
  const name = navLabel(p.id);
  const say = p.extra ? p.extra.say.filter(Boolean) : [];
  return (
    <button
      type="button"
      data-roving=""
      data-nav={p.id}
      class={`cx-nav-item${p.active ? " is-active" : ""}`}
      style={{ "--cx-nav-hue": `var(--cx-cat-${NAV_SLOT[p.id]})` }}
      aria-current={p.active ? "page" : undefined}
      aria-pressed={p.active}
      aria-label={say.length > 0 ? `${p.id === "add" ? t("nav.addLabel") : name}, ${say.join(", ")}` : p.id === "add" ? t("nav.addLabel") : undefined}
      onClick={() => p.onOpen(p.id)}
    >
      <span class="cx-nav-name">{name}</span>
      {p.extra?.badge ? (
        <span class="cx-tab-badge" aria-hidden="true">
          {p.extra.badge}
        </span>
      ) : null}
      {p.extra?.tone ? <span class={`cx-tab-dot is-${p.extra.tone}`} aria-hidden="true" /> : null}
      {p.extra?.attention ? <span class="cx-tab-dot is-trouble" aria-hidden="true" /> : null}
    </button>
  );
}

function Meters(): JSX.Element | null {
  const s = useServices();
  const sandbox = s.sandbox.value;
  const q = s.shared.slices.queues.value;
  const work = useLoad(() => (sandbox ? Promise.resolve(null) : s.ledger.workWaiting()), [sandbox, q.label, q.summaries, q.checks]);
  // No honest number yet (loading, failed, sample record, nothing queued): no meters.
  const w = sandbox ? undefined : loaded(work);
  const rp = useRailPalette();
  if (!w) return null;
  const m = navMeters(w.bySource);
  const checksOn = featureOn("checks");
  if (m.organised === null && (m.checksDone === null || !checksOn)) return null;
  const row = (icon: "names" | "reset", label: string, tip: string, value: number | null) =>
    value === null ? null : (
      <div class="cx-rail-meter" title={tip}>
        {isDesktopHost() ? <Icon name={icon} class="cx-rail-meter-icon" /> : null}
        <span class="cx-rail-meter-label">{label}</span>
        <span class="cx-rail-meter-bar" role="img" aria-label={tip} style={{ "--cx-meter-fill": rp.gradient }}>
          <span style={{ width: `${value}%` }} />
        </span>
        <span class="cx-rail-meter-value">{value}%</span>
      </div>
    );
  return (
    <div class="cx-rail-meters">
      {row("names", t("nav.organised"), t("nav.organisedTip", { p: m.organised ?? 0 }), m.organised)}
      {checksOn ? row("reset", t("nav.checksDone"), t("nav.checksDoneTip", { p: m.checksDone ?? 0 }), m.checksDone) : null}
    </div>
  );
}

export function NavRail(): JSX.Element {
  const leaf = useLeaf();
  const ref = useRef<HTMLElement>(null);
  useRoving(ref);
  const open = useNavOpen();
  const extras = useNavExtras();
  const ui = leaf.store.slices.ui.value;
  const active = activeNavItem(ui);
  const rows = navRows(ui.navFull, ui.navMore);
  /** The open page is one of the destinations the closed More group is hiding. */
  const hiddenActive = active !== null && !rows.some((r) => r.kind === "items" && r.items.includes(active));
  return (
    <div class="cx-rail">
      <div class="cx-rail-head">
        <RailWordmark />
        <RailSearch />
      </div>
      <div class="cx-rail-scope">
        <ScopePicker />
      </div>
      <nav ref={ref} class="cx-nav" role="navigation" aria-label={t("nav.label")} onKeyDown={(e) => rovingKeyDown(e as unknown as KeyboardEvent, ref.current, "vertical")}>
        {rows.map((row, i) =>
          row.kind === "more" ? (
            <button
              key="more"
              type="button"
              data-roving=""
              class={`cx-nav-item cx-nav-more${ui.navMore ? " is-open" : ""}${!ui.navMore && hiddenActive ? " has-active" : ""}`}
              aria-expanded={ui.navMore}
              aria-label={t("nav.moreLabel")}
              onClick={() => setNavMore(leaf.store, !ui.navMore)}
            >
              <span class="cx-nav-name">{t("nav.more")}</span>
              <Icon name="chevron" class="cx-nav-chevron" />
            </button>
          ) : (
            <div key={`${i}:${row.items.join("+")}`} class={`cx-nav-row${row.items.length > 1 ? " is-pair" : ""}${row.items.includes("add") ? " is-add" : ""}`}>
              {row.items.map((id) => (
                <NavButton key={id} id={id} active={active === id} extra={extras[id]} onOpen={open} />
              ))}
            </div>
          ),
        )}
      </nav>
      {/* Desktop: the toggle sits right under the destinations (after a hairline). The rail has no minimap: the user removed it on purpose. */}
      {isDesktopHost() ? (
        <div class="cx-rail-showall">
          <Toggle inline label={t("nav.showEverything")} checked={ui.navFull} onChange={(on) => setNavFull(leaf.store, on)} />
        </div>
      ) : null}
      <div class="cx-rail-foot">
        {isDesktopHost() ? null : <Toggle inline label={t("nav.showEverything")} checked={ui.navFull} onChange={(on) => setNavFull(leaf.store, on)} />}
        {/* Mount point for the status block, directly above the meters. */}
        <RailStatus />
        <ActivityRing />
        <Meters />
      </div>
    </div>
  );
}
