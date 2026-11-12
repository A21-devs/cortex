/**
 * Consent in the key: an "open" or "closed" badge on the rows of the Area and Folder path groupings (whether directions
 * trials, exports and grants may use that space), and an "At the read limit" filter that lights the items models have
 * read as often as Settings > Privacy allows. Owner: consent-grants.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { inList, isOpenPlace } from "../../shared/consent";
import type { CortexSettings } from "../../shared/settings";
import { addToken, removeToken } from "../../state/actions";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";

/** "open" or "closed" for a legend row of the Area or Folder path grouping; null for any other grouping. */
export function openState(dim: string, rowKey: string, s: Pick<CortexSettings, "consent" | "userSpaces">): "open" | "closed" | null {
  if (dim === "space") return isOpenPlace({ space: rowKey, folder: [] }, s.consent, s.userSpaces) ? "open" : "closed";
  if (dim === "folderPath" || dim === "folder") {
    const folder = rowKey.split("/").filter(Boolean);
    return folder.length > 0 && inList({ space: "", folder }, [...s.consent.openSpaces, ...s.userSpaces.filter((u) => u.open).flatMap((u) => u.folders)]) ? "open" : "closed";
  }
  return null;
}

/** `quiet` (the always-visible legend) marks only open rows: closed is the default, so a badge on every row is noise. */
export function OpenBadge(p: { dim: string; rowKey: string; quiet?: boolean }): JSX.Element | null {
  const s = useServices();
  const v = s.settings.signal.value;
  const state = openState(p.dim, p.rowKey, v);
  if (state === null || (p.quiet === true && state === "closed")) return null;
  return (
    <span class={`cx-key-open is-${state}`} title={state === "open" ? t("consent.openState.open") : t("consent.openState.closed")}>
      {state === "open" ? t("consent.badgeOpen") : t("consent.badgeClosed")}
    </span>
  );
}

/** A button that lights the items at the read limit; shown only while the limit is on. */
export function ReadLimitFilter(): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const consent = s.settings.signal.value.consent;
  const [note, setNote] = useState("");
  if (!consent.itemReadLimit.enabled) return null;
  const run = async (): Promise<void> => {
    try {
      const r = s.sandbox.value ? { atLimit: [] as string[] } : await s.runner.request({ cmd: "consent.reads", args: {} });
      if (r.atLimit.length === 0) {
        removeToken(leaf.store, "set:read-limit");
        setNote(t("consent.keyFilterNone"));
        return;
      }
      addToken(leaf.store, { id: "set:read-limit", kind: "set", label: t("consent.keyFilter"), ids: r.atLimit });
      setNote(t("consent.keyFilterOn", { n: r.atLimit.length }));
    } catch {
      setNote(t("errors.action"));
    }
  };
  return (
    <div class="cx-key-consent">
      <button type="button" class="cx-text-button" onClick={() => void run()}>
        {t("consent.keyFilter")}
      </button>
      {note !== "" ? <span class="cx-note"> {note}</span> : null}
    </div>
  );
}
