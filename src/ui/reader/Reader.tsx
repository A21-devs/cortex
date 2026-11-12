/**
 * Reader router: maps a sheet reader entry to its reader. Owner: E12.
 *  entry → EntryReader (your original words, CORTEX-UX §5.14); note → NoteReader (a machine note, §5.15);
 *  conversation → ConversationReader (the frond, §5.15); map → MapReader (a map of content, §5.16);
 *  vault-peek → NotePeek (a vault note rendered by Obsidian, §5.17); thread → Thread (a whole conversation).
 */
import type { JSX } from "preact";
import { ItemKind } from "../../shared/index-format";
import type { ReaderRoute, SheetEntry } from "../../shared/views";
import { ConversationReader } from "./ConversationReader";
import { EntryReader } from "./EntryReader";
import { MapReader } from "./MapReader";
import { NotePeek } from "./NotePeek";
import { NoteReader } from "./NoteReader";
import { Thread } from "./Thread";
import { TodayNote } from "./TodayNote";

/** Which reader opens for an item kind on click (CORTEX-UX §2.3): vault notes peek; summaries open their conversation. */
export function readerRouteOf(kind: number): ReaderRoute {
  if (kind === ItemKind.NoteHub) return "map";
  if (kind === ItemKind.NoteWiki) return "vault-peek";
  if (kind === ItemKind.NoteGist) return "conversation";
  return kind >= ItemKind.NoteWiki ? "note" : "entry";
}

export function ReaderRouter(p: { entry: Extract<SheetEntry, { kind: "reader" }> }): JSX.Element {
  switch (p.entry.route) {
    case "entry":
      return <EntryReader id={p.entry.id} />;
    case "note":
      return <NoteReader id={p.entry.id} />;
    case "conversation":
      return <ConversationReader id={p.entry.id} />;
    case "map":
      return <MapReader id={p.entry.id} />;
    case "vault-peek":
      return <NotePeek id={p.entry.id} />;
    case "thread":
      return <Thread id={p.entry.id} />;
    case "today":
      return <TodayNote />;
    default:
      return <EntryReader id={p.entry.id} />;
  }
}
