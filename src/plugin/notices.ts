/**
 * Background notices (CORTEX-UX §2.1, §5.11, §5.31). Owner: E1.
 * At most one Obsidian Notice per kind per 5 minutes, and only while no Cortex leaf is visible (a visible leaf
 * shows toasts instead). Text comes from the copy catalogue (ui/copy.ts), never from runner frames.
 * `noticeForError` turns a failed user action into the catalogue text for its error code; it is shown at once
 * (direct feedback is not a background notice) and cancellations say nothing.
 */
import { COPY, t } from "../ui/copy";
import { isCancellation, isCortexError } from "../shared/errors";

export type NoticeKind = "imported" | "capped" | "engine" | "settings" | "first-run" | "limit" | "runner";

export const NOTICE_THROTTLE_MS = 5 * 60_000;

export interface NoticeService {
  /** Returns true when the notice was shown. */
  notify(kind: NoticeKind, text: string): boolean;
  /** Forget the throttle (a new session of background work). */
  reset(): void;
}

export interface NoticeDeps {
  now(): number;
  anyLeafVisible(): boolean;
  show(text: string): void;
}

export function createNoticeService(deps: NoticeDeps): NoticeService {
  const last = new Map<NoticeKind, number>();
  return {
    notify(kind, text) {
      if (text.length === 0) return false;
      let visible = false;
      try {
        visible = deps.anyLeafVisible();
      } catch {
        visible = false;
      }
      if (visible) return false;
      const now = deps.now();
      const prev = last.get(kind);
      if (prev !== undefined && now - prev < NOTICE_THROTTLE_MS) return false;
      last.set(kind, now);
      deps.show(text);
      return true;
    },
    reset() {
      last.clear();
    },
  };
}

/** Texts ui/copy.ts does not carry yet (requested from E12 in docs/rfcs/E1.md); the catalogue wins once present. */
const EXTRA = {
  failed: "Cortex couldn't finish that. Nothing was changed.",
  busy: "Cortex is busy with another task. Try again in a moment.",
  notFound: "Cortex couldn't find that in your record.",
} as const;

export function noticeText(key: keyof typeof EXTRA): string {
  const fromCopy = (COPY.notices as Readonly<Record<string, string>>)[key];
  return typeof fromCopy === "string" ? fromCopy : EXTRA[key];
}

/** Catalogue text for a failed user action, or null when nothing should be said (cancelled). */
export function noticeForError(e: unknown): string | null {
  if (isCancellation(e)) return null;
  if (!isCortexError(e)) return noticeText("failed");
  // The model on this computer is not answering (server stopped, wrong address, model not installed).
  const reason = e.detail?.["reason"];
  if (e.code === "E_ENGINE_FAILED" && typeof reason === "string" && reason.startsWith("local:")) return t("notices.localUnreachable");
  switch (e.code) {
    case "E_SETTINGS":
      return t("notices.settings");
    case "E_NODE_MISSING":
      return t("warnings.node-missing");
    case "E_ENGINE_MISSING":
      return t("notices.missing");
    case "E_ENGINE_AUTH":
      return t("notices.signIn");
    case "E_ENGINE_LIMIT":
      return t("notices.limit");
    case "E_BUDGET_CAPPED":
      return t("notices.capped");
    case "E_PAUSED":
      return t("agents.paused");
    case "E_LOCKED":
      return noticeText("busy");
    default:
      return noticeText("failed");
  }
}
