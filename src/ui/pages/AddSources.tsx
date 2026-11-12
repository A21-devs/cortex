/**
 * Add to your record, as a page docked on the left beside the rail (the stage and the other panels stay live to its
 * right). The content is the Add sources dialog's own (drop zone, "Nothing leaves this computer.", Your resume, one
 * row per source), built into this page's container by the lazily loaded AddSourcesModal. Done puts the page away.
 */
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { closeSheet } from "../../state/actions";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import type { PageProps } from "./index";

export function AddSources(_p: PageProps): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let gone = false;
    let panel: { onClose(): void } | null = null;
    void import("../modals/AddSourcesModal").then((m) => {
      if (gone || !host.current) return;
      const modal = new m.AddSourcesModal(s.app, s).dock(() => closeSheet(leaf.store));
      modal.onOpen();
      host.current.appendChild(modal.contentEl);
      panel = modal;
    });
    return () => {
      gone = true;
      panel?.onClose();
    };
  }, []);
  return <div class="cx-page cx-add-page cx-add-sources-modal" ref={host} aria-label={t("pages.add")} />;
}
