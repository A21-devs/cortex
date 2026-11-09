/**
 * Which reader opens for an item (CORTEX-UX §2.3). Owner: E12. Kept apart from the router so readers and pages can
 * use it without importing every reader.
 */
import { ItemKind } from "../../shared/index-format";
import type { ReaderRoute } from "../../shared/views";

/** Vault notes peek; summaries open their conversation; maps open the map reader; other notes the note reader. */
export function readerRouteOf(kind: number): ReaderRoute {
  if (kind === ItemKind.NoteHub) return "map";
  if (kind === ItemKind.NoteWiki) return "vault-peek";
  if (kind === ItemKind.NoteGist) return "conversation";
  return kind >= ItemKind.NoteWiki ? "note" : "entry";
}
