/**
 * "Mark this conversation as not mine" (the /not-mine slash command and a Find action; P21). One step: every message
 * of the selected conversation that is filed as yours becomes Another person's, through the same set-speaker
 * correction the reader's "Correct the speaker" and /correct use (corrections.apply, action set-speaker), so it is
 * recorded in Change history and one Undo restores every message. Nothing is deleted and no model is asked.
 */
import type { CortexServices, LeafServices } from "../../plugin/services";
import type { Selection } from "../../state/types";
import type { Shell } from "../context";
import { t } from "../copy";
import { idOf } from "../reader/readerKit";

/** The conversation of the selected item: its id, title and message count (null when the selection is not in one). */
export function selectedConversation(s: Pick<CortexServices, "index">, selection: Selection): { id: string; title: string; count: number } | null {
  if (!selection) return null;
  let meta: ReturnType<CortexServices["index"]["meta"]>;
  try {
    meta = s.index.meta(selection.ordinal);
  } catch {
    return null;
  }
  const conv = meta?.conversation;
  return conv ? { id: conv.id, title: conv.title, count: conv.count } : null;
}

/** Entry ids of the messages in a conversation filed as the person's own, 200 at a time. */
export async function ownMessageIds(s: CortexServices, conv: { id: string; count: number }): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; from < conv.count; from += 200) {
    const slice = await s.records.conversationSlice(conv.id, from, Math.min(conv.count, from + 200));
    for (const m of slice) {
      if (m.speaker !== "you") continue;
      const id = idOf(s, m.ordinal, null);
      if (id) out.push(id);
    }
  }
  return out;
}

export type NotMineResult = { kind: "done"; changed: number } | { kind: "none" } | { kind: "nothing" } | { kind: "failed" };

/** Mark the selected conversation as not mine; posts a toast with Undo. */
export async function markNotMine(s: CortexServices, leaf: Pick<LeafServices, "store">, shell: Pick<Shell, "toast" | "announce">): Promise<NotMineResult> {
  if (s.sandbox.value) {
    shell.toast({ kind: "info", text: t("ask.sample") });
    return { kind: "failed" };
  }
  const conv = selectedConversation(s, leaf.store.get("selection"));
  if (!conv) {
    shell.toast({ kind: "info", text: t("notMine.select") });
    return { kind: "none" };
  }
  try {
    const ids = await ownMessageIds(s, conv);
    if (ids.length === 0) {
      shell.toast({ kind: "info", text: t("notMine.nothing", { title: conv.title }) });
      return { kind: "nothing" };
    }
    const done: string[] = [];
    try {
      for (const target of ids) done.push((await s.corrections.apply({ via: "ask", action: "set-speaker", target, payload: { speaker: "other" } })).id);
    } catch (e) {
      // Part of the conversation changed before the failure: put those messages back rather than leave it half done.
      for (const id of [...done].reverse()) await s.corrections.undo(id as `k_${string}`, "ask").catch(() => undefined);
      throw e;
    }
    const text = t("notMine.done", { title: conv.title });
    shell.toast({
      kind: "change",
      text,
      undo: async () => {
        for (const id of [...done].reverse()) await s.corrections.undo(id as `k_${string}`, "ask");
      },
    });
    shell.announce(text);
    return { kind: "done", changed: done.length };
  } catch {
    shell.toast({ kind: "error", text: t("errors.action") });
    return { kind: "failed" };
  }
}

