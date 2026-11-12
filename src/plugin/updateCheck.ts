/**
 * Check for updates (command and More-menu item; P21). Only runs when invoked: ONE request to the GitHub releases
 * API for the newest release tag (shared/update.ts), compared with the installed version. Cortex never installs
 * anything itself; the notice's button opens Obsidian's Community plugins, which does the update.
 */
import { Notice, type App } from "obsidian";
import { t } from "../ui/copy";
import { checkForUpdate, releasesRepo, rememberVerdict, type UpdateVerdict } from "../shared/update";

const TIMEOUT_MS = 8000;

/** GET a JSON document; rejects on a network failure, a timeout or a non-200 reply. */
export async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** Open Obsidian's Settings at Community plugins (internal API, feature-detected). */
export function openCommunityPlugins(app: App): void {
  const setting = (app as unknown as { setting?: { open?(): void; openTabById?(id: string): unknown } }).setting;
  try {
    setting?.open?.();
    setting?.openTabById?.("community-plugins");
  } catch {
    // An Obsidian without the internal settings API: nothing to open.
  }
}

/** The notice text for a verdict. */
export function verdictText(v: UpdateVerdict): string {
  if (v.kind === "available") return t("update.available", { version: v.latest });
  if (v.kind === "current") return t("update.current", { version: v.current });
  return t("update.unknown");
}

function show(app: App, v: UpdateVerdict): void {
  if (v.kind !== "available") {
    new Notice(verdictText(v));
    return;
  }
  const frag = document.createDocumentFragment();
  const line = document.createElement("div");
  line.textContent = verdictText(v);
  const button = document.createElement("button");
  button.textContent = t("update.open");
  button.addEventListener("click", () => openCommunityPlugins(app));
  frag.append(line, button);
  new Notice(frag, 15_000);
}

/** Run the check and show the result. Never throws. */
export async function runUpdateCheck(app: App, manifest: { version: string; authorUrl?: string; id?: string }, fetcher: (url: string) => Promise<unknown> = fetchJson): Promise<UpdateVerdict | null> {
  const repo = releasesRepo(manifest);
  if (repo === null) {
    new Notice(t("update.noRepo"));
    return null;
  }
  try {
    const verdict = await checkForUpdate({ version: manifest.version, repo, fetchJson: fetcher });
    rememberVerdict(verdict);
    show(app, verdict);
    return verdict;
  } catch {
    new Notice(t("update.failed"));
    return null;
  }
}
