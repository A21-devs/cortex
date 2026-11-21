/**
 * The "Check for updates" command (P21). Runs only when the person invokes it: ONE request to the GitHub
 * releases API of the plugin's repository, read for the newest release tag and compared with manifest.version.
 * Nothing is installed here; the notice points to Obsidian's Community plugins, which does the update.
 * Pure helpers plus an injected fetcher, so tests need no network.
 */

/**
 * "owner/repo" whose releases are checked when the manifest carries no GitHub `authorUrl`: the public repository.
 * With an empty value and no `authorUrl`, the check would say it cannot tell and send nothing.
 */
export const RELEASES_REPO = "A21-devs/cortex";

const REPO_PART = /^[A-Za-z0-9_.-]+$/;

/** "owner/repo" from a manifest: a github.com authorUrl with two parts, or with one part plus the plugin id; else the constant. */
export function releasesRepo(manifest: { authorUrl?: string; id?: string }, fallback: string = RELEASES_REPO): string | null {
  const url = manifest.authorUrl;
  if (typeof url === "string") {
    const m = /^https:\/\/(?:www\.)?github\.com\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:[?#].*)?$/i.exec(url.trim());
    if (m) {
      const owner = m[1] ?? "";
      const repo = (m[2] ?? manifest.id ?? "").replace(/\.git$/i, "");
      if (REPO_PART.test(owner) && REPO_PART.test(repo)) return `${owner}/${repo}`;
    }
  }
  const parts = fallback.split("/");
  return parts.length === 2 && parts.every((p) => REPO_PART.test(p)) ? fallback : null;
}

export function latestReleaseUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/** [major, minor, patch] from "1.2.3", "v1.2.3" or "1.2.3-beta.1"; null when it is not a version. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 when a is older than b, 0 when equal, 1 when newer; null when either is not a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type UpdateVerdict = { kind: "current"; current: string } | { kind: "available"; current: string; latest: string } | { kind: "unknown"; current: string };

/** The verdict for the installed version and the latest release tag. A pre-release tag never counts as newer than its release. */
export function judgeUpdate(current: string, latestTag: string): UpdateVerdict {
  const cmp = compareVersions(latestTag, current);
  if (cmp === null) return { kind: "unknown", current };
  if (cmp > 0) return { kind: "available", current, latest: latestTag.trim().replace(/^v/i, "") };
  return { kind: "current", current };
}

let lastVerdict: UpdateVerdict | null = null;
const verdictListeners = new Set<() => void>();

/** Remember the verdict of the last check the person ran (the tray's foot line reads it; nothing is sent anywhere). */
export function rememberVerdict(v: UpdateVerdict | null): void {
  lastVerdict = v;
  for (const fn of [...verdictListeners]) fn();
}

export function lastUpdateVerdict(): UpdateVerdict | null {
  return lastVerdict;
}

/** Call `fn` whenever a check finishes; returns the way to stop. */
export function onVerdict(fn: () => void): () => void {
  verdictListeners.add(fn);
  return () => void verdictListeners.delete(fn);
}

/** The `tag_name` of a GitHub "latest release" response, or null. */
export function tagOf(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const tag = (json as { tag_name?: unknown }).tag_name;
  return typeof tag === "string" && tag.length > 0 && tag.length < 64 ? tag : null;
}

/** Fetch the newest release tag (one request) and judge it. Rejects when the request fails; "unknown" when the reply has no usable tag. */
export async function checkForUpdate(opts: { version: string; repo: string; fetchJson(url: string): Promise<unknown> }): Promise<UpdateVerdict> {
  const tag = tagOf(await opts.fetchJson(latestReleaseUrl(opts.repo)));
  return tag === null ? { kind: "unknown", current: opts.version } : judgeUpdate(opts.version, tag);
}
