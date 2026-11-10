/**
 * `review.discard` (runner): dismiss the open Checks cards a run, or an Ask change, wrote, so Undo of
 * `propose_filing` is complete (the queued jobs are removed by `agents.dequeue`; this removes what already ran).
 *
 * A card is never deleted: a newer line for the same id carries `dismissedAt`, and every reader treats the card as
 * closed. Cards the person already answered (a standing correction targets the card, or `resolvedBy` is set) are
 * left alone: undoing that answer is the correction's own Undo.
 */
import { CortexError } from "../shared/errors";
import type { ReviewDiscardArgs } from "../shared/protocol/runner";
import type { ReviewCardRecord } from "../shared/types";
import type { LedgerStore } from "../store/ledger";

const TARGET_ID = /^[a-z]_[a-z2-7]{16}$/;
const MAX_TARGETS = 500;

export async function discardChecks(ledger: LedgerStore, args: ReviewDiscardArgs, now: () => Date = () => new Date()): Promise<number> {
  if (typeof args !== "object" || args === null) throw new CortexError("E_BAD_REQUEST", "review.discard needs arguments");
  const { runId, targets, since, kind } = args;
  if (runId !== undefined && (typeof runId !== "string" || !TARGET_ID.test(runId))) throw new CortexError("E_BAD_REQUEST", "invalid run id");
  if (targets !== undefined && (!Array.isArray(targets) || targets.length > MAX_TARGETS || targets.some((t) => typeof t !== "string" || !TARGET_ID.test(t)))) throw new CortexError("E_BAD_REQUEST", "invalid targets");
  if (since !== undefined && (typeof since !== "string" || !Number.isFinite(Date.parse(since)))) throw new CortexError("E_BAD_REQUEST", "invalid since");
  // Without a run or a list of targets this would dismiss every open card.
  if (runId === undefined && (targets === undefined || targets.length === 0)) throw new CortexError("E_BAD_REQUEST", "name a run or the targets to discard");

  const answered = new Set<string>();
  for (const c of await ledger.readCorrections()) answered.add(c.target);
  const latest = new Map<string, ReviewCardRecord>();
  for await (const card of ledger.readAll("review")) latest.set(card.id, card);
  const wanted = targets === undefined ? null : new Set(targets);
  const sinceMs = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
  const stamp = now().toISOString();
  const out: ReviewCardRecord[] = [];
  for (const card of latest.values()) {
    if (card.resolvedBy !== undefined || card.dismissedAt !== undefined || answered.has(card.id)) continue;
    if (runId !== undefined && card.runId !== runId) continue;
    if (wanted && !wanted.has(card.target)) continue;
    if (kind !== undefined && card.kind !== kind) continue;
    if (Date.parse(card.createdAt) < sinceMs) continue;
    out.push({ ...card, dismissedAt: stamp });
  }
  if (out.length > 0) await ledger.append("review", out);
  return out.length;
}
