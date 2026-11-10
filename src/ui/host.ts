/**
 * Which app hosts the UI. Cortex Desktop (src/desktop) marks its document body `cxd-app`; the Obsidian plugin never
 * does. The shell uses this to lay itself out as the standalone app (no header bar, a rail-first window, a legend
 * list and a display panel instead of the key bar, shape bar and tool column) without changing the plugin.
 * Tests can force either host with `forceHost`.
 */
let forced: "desktop" | "plugin" | null = null;

/** Force the host for a test (null restores detection). */
export function forceHost(host: "desktop" | "plugin" | null): void {
  forced = host;
}

export function isDesktopHost(): boolean {
  if (forced) return forced === "desktop";
  return typeof document !== "undefined" && document.body?.classList.contains("cxd-app") === true;
}
