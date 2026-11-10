/**
 * The disk-backed CorrectionService (ledger, notes writer). Owner: E7.
 * Kept apart from corrections.ts so the types that the UI imports never pull Node modules into the browser
 * typecheck; the container builds the service from here.
 */
import type { StoreContext } from "../store/layout";
import type { LedgerStore } from "../store/ledger";
import { restoreDerivedNote, tombstoneDerivedNote } from "../store/notesWriter";
import { createCorrectionService, type CorrectionDeps, type CorrectionServiceExt } from "./corrections";

export interface NodeCorrectionDeps extends Pick<CorrectionDeps, "settings" | "sandbox" | "applyTheirs" | "now" | "log"> {
  ctx: StoreContext;
  ledger: LedgerStore;
}

export function createNodeCorrectionService(nd: NodeCorrectionDeps): CorrectionServiceExt {
  const { ctx, ledger, ...rest } = nd;
  return createCorrectionService({
    ...rest,
    ledger,
    notes: {
      all: () => ledger.readAll("notes"),
      append: async (records) => void (await ledger.append("notes", records)),
    },
    cards: {
      all: () => ledger.readAll("review"),
      append: async (records) => void (await ledger.append("review", records)),
    },
    files: {
      tombstone: (file, expectedOwnedSha, leftOutOn) => tombstoneDerivedNote(ctx, file, expectedOwnedSha, leftOutOn),
      restore: (file, noteId, placeholderOwnedSha, previousOwnedSha) => restoreDerivedNote(ctx, file, noteId as Parameters<typeof restoreDerivedNote>[2], placeholderOwnedSha, previousOwnedSha),
    },
  });
}
