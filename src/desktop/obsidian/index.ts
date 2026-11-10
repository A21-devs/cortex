/**
 * The "obsidian" module of Cortex Desktop. The desktop renderer bundle aliases `obsidian` to this file
 * (scripts/build-config.mjs desktopRendererOptions), so Cortex's plugin code runs unchanged outside Obsidian.
 * It implements the part of Obsidian's API that Cortex uses — nothing more — with plain DOM and Node:
 *   vault + metadataCache over the real folder (vault.ts, metadataCache.ts, markdown.ts), the workspace host
 *   (workspace.ts), Plugin (plugin.ts), Component / Scope / Keymap (component.ts), Menu / Notice / Modal /
 *   suggest prompts (ui.ts), Setting and the Settings page (setting.ts), Lucide icons (icons.ts) and the
 *   markdown renderer (markdownRenderer.ts). dom.ts installs Obsidian's DOM helpers on the prototypes.
 */
export { App } from "./app";
export { Component, Keymap, Scope, type KeymapContext, type KeymapEventHandler, type KeymapEventListener, type Modifier } from "./component";
export { Events, type EventRef } from "./events";
export { addIcon, getIcon, getIconIds, removeIcon, setIcon } from "./icons";
export { getAllTags, getLinkpath, parseFrontmatter, parseLinktext, parseYaml, stringifyYaml, type CachedMetadata, type FrontMatterCache, type HeadingCache, type LinkCache, type Pos, type TagCache } from "./markdown";
export { MarkdownRenderer } from "./markdownRenderer";
export { MetadataCache } from "./metadataCache";
export { Plugin, type Command, type PluginManifest } from "./plugin";
export {
  BaseComponent,
  ButtonComponent,
  DropdownComponent,
  ExtraButtonComponent,
  PluginSettingTab,
  SearchComponent,
  Setting,
  SliderComponent,
  TextAreaComponent,
  TextComponent,
  ToggleComponent,
} from "./setting";
export { FuzzySuggestModal, Menu, MenuItem, Modal, Notice, prepareFuzzySearch, SuggestModal, type FuzzyMatch, type Instruction, type SearchMatches } from "./ui";
export { FileSystemAdapter, normalizePath, TAbstractFile, TFile, TFolder, Vault, type FileStats, type Stat } from "./vault";
export { ItemView, View, Workspace, WorkspaceLeaf, WorkspaceSplit, type ViewState, type ViewStateResult } from "./workspace";

/** The Obsidian API level this shim follows (the typed `obsidian` package Cortex builds against). */
export const apiVersion = "1.12.3";

const platform = typeof navigator === "undefined" ? "" : navigator.platform;

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: /Mac/i.test(platform),
  isWin: /Win/i.test(platform),
  isLinux: /Linux/i.test(platform),
  isSafari: false,
  resourcePathPrefix: "file:///",
} as const;

/** `requireApiVersion("1.4.0")`: the shim follows apiVersion. */
export function requireApiVersion(version: string): boolean {
  const a = apiVersion.split(".").map(Number);
  const b = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Obsidian's debounce (trailing call, optional reset of the timer on each call). */
export function debounce<T extends unknown[]>(cb: (...args: T) => unknown, timeout = 0, resetTimer = false): ((...args: T) => void) & { cancel(): void; run(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: T | null = null;
  const run = (): void => {
    timer = null;
    if (last) cb(...last);
    last = null;
  };
  const fn = ((...args: T) => {
    last = args;
    if (timer && !resetTimer) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, timeout);
  }) as ((...args: T) => void) & { cancel(): void; run(): void };
  fn.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    last = null;
  };
  fn.run = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  return fn;
}

/** Obsidian's `requestUrl` (no cross-origin rules inside Obsidian; here it is plain `fetch`). Used by the local model Test button. */
export async function requestUrl(request: string | { url: string; method?: string; body?: string; contentType?: string; throw?: boolean }): Promise<{ status: number; text: string }> {
  const r = typeof request === "string" ? { url: request } : request;
  const init: RequestInit = { method: ("method" in r && r.method) || "GET", redirect: "error" };
  if ("body" in r && r.body !== undefined) {
    init.body = r.body;
    init.headers = { "content-type": ("contentType" in r && r.contentType) || "application/json" };
  }
  const res = await fetch(r.url, init);
  return { status: res.status, text: await res.text() };
}
