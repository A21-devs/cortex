/**
 * Worker message handling, independent of the transport (real Web Worker or inline on the main thread).
 * Owner: E8 (wiring). Method bodies live in their owners' modules; this file only routes.
 *  - one shared index; per-view state (the last placement's positions) keyed by viewId (H6);
 *  - results are posted through prepareTransfer(): only buffers a result fully owns are transferred; decoded
 *    index and anatomy buffers are registered in `stateOwned` and are never detached (TRANSFER-DETACH). In dev
 *    builds `assertNoStateTransfer` checks every transfer list.
 */
import { CortexError, asCortexError } from "../shared/errors";
import type { DataIndex } from "../shared/index-format";
import type { Pose } from "../shared/settings";
import { prepareTransfer, type FromWorker, type ToWorker, type WorkerMethod, type WorkerMethods } from "../shared/protocol/worker";
import type { SearchIndexData } from "../shared/searchCodec";
import type { AnatomyModel } from "./anatomy";
import { brainSlotBucket, buildAnatomy, resolvePose } from "./anatomy";
import { computeGroupsArrangement } from "./arrangements";
import { CHARTS } from "./charts/registry";
import { computeGrouping } from "./grouping";
import { addSearchShardOp, appendIndexOp, loadIndexOp, loadSearchOp, patchIndexOp, queryOp, relatedOp } from "./indexOps";
import { computeLines } from "./lines";
import { computePlacement, requiredBrainSlots } from "./placement";
import { buildSampleIndex } from "./sampleIndex";
import { runSearch } from "./search";
import { computeStats } from "./stats";

export const WORKER_VERSION = "0.2.0";

export interface ViewState {
  /** Body positions from this view's last placement (arrangements, related lines, global lines). */
  anat: Float32Array | null;
  /** The pose of that placement: arrangements and lines are computed in the skeleton frame and posed like it. */
  pose: Pose;
}

export interface WorkerState {
  index: DataIndex | null;
  search: SearchIndexData | null;
  anatomy: AnatomyModel | null;
  views: Map<string, ViewState>;
  /** Buffers owned by worker state; never transferred. */
  stateOwned: WeakSet<ArrayBufferLike>;
  cancelled: Set<number>;
}

export type Post = (msg: FromWorker, transfer: ArrayBuffer[]) => void;

export type MethodTable = {
  [M in WorkerMethod]: (params: WorkerMethods[M]["params"], st: WorkerState, id: number, viewId: string) => Promise<WorkerMethods[M]["result"]> | WorkerMethods[M]["result"];
};

function requireIndex(st: WorkerState): DataIndex {
  if (!st.index) throw new CortexError("E_BAD_REQUEST", "no index loaded");
  return st.index;
}

function view(st: WorkerState, viewId: string): ViewState {
  let v = st.views.get(viewId);
  if (!v) {
    v = { anat: null, pose: resolvePose(undefined) };
    st.views.set(viewId, v);
  }
  return v;
}

export const METHODS: MethodTable = {
  init: () => ({ version: WORKER_VERSION }),
  loadIndex: (p, st) => loadIndexOp(p, st),
  appendIndex: (p, st) => appendIndexOp(p, st),
  patchIndex: (p, st) => patchIndexOp(p, st),
  loadSearch: (p, st) => loadSearchOp(p, st),
  addSearchShard: (p, st) => addSearchShardOp(p, st),
  placement: (p, st, _id, viewId) => {
    const index = requireIndex(st);
    const need = requiredBrainSlots(index, p);
    if (!st.anatomy || st.anatomy.seed !== p.seed || st.anatomy.slotCount < need) {
      st.anatomy = buildAnatomy(p.seed, brainSlotBucket(need));
      st.stateOwned.add(st.anatomy.brainSlots.buffer);
    }
    const res = computePlacement(index, st.anatomy, p);
    const v = view(st, viewId);
    v.anat = res.anat.slice();
    v.pose = resolvePose(p.pose);
    return res;
  },
  grouping: (p, st) => computeGrouping(requireIndex(st), p),
  arrangement: (p, st, _id, viewId) => {
    const index = requireIndex(st);
    const v = view(st, viewId);
    const anat = v.anat ?? new Float32Array(index.count * 3);
    if (p.kind === "groups") return computeGroupsArrangement(index, p, anat, v.pose);
    const layout = CHARTS[p.spec.chart];
    return layout({ index, spec: p.spec, visibility: p.visibility, members: new Uint32Array(0), seed: () => 0, ...(p.stage ? { stage: p.stage } : {}) });
  },
  lines: (p, st, _id, viewId) => {
    const index = requireIndex(st);
    const v = view(st, viewId);
    return computeLines(index, v.anat ?? new Float32Array(index.count * 3).fill(Number.NaN), p, v.pose);
  },
  search: (p, st) => runSearch(st.search, requireIndex(st), p),
  related: (p, st, _id, viewId) => relatedOp(p, st, viewId),
  query: (p, st) => queryOp(p, st),
  stats: (p, st) => computeStats(requireIndex(st), p),
  loadSample: (p, st) => {
    st.index = buildSampleIndex(p.seed);
    return { count: st.index.count, notes: st.index.header.stats.notes, record: st.index.header.stats.record, seq: 0, epoch: "sample" };
  },
};

export interface WorkerHandler {
  onMessage(msg: ToWorker): void;
  readonly state: WorkerState;
}

/** Dev check: no transfer list may contain a state-owned buffer. */
export function assertNoStateTransfer(transfer: readonly ArrayBuffer[], stateOwned: WeakSet<ArrayBufferLike>): void {
  for (const b of transfer) if (stateOwned.has(b)) throw new CortexError("E_INTERNAL", "attempt to transfer a state-owned buffer");
}

export function createWorkerHandler(post: Post, methods: MethodTable = METHODS, dev = false): WorkerHandler {
  const state: WorkerState = { index: null, search: null, anatomy: null, views: new Map(), stateOwned: new WeakSet(), cancelled: new Set() };
  return {
    state,
    onMessage(msg) {
      if (msg.t === "cancel") {
        state.cancelled.add(msg.id);
        return;
      }
      if (msg.t === "dropView") {
        state.views.delete(msg.viewId);
        return;
      }
      const id = msg.id;
      const fn = methods[msg.method] as (p: unknown, s: WorkerState, id: number, viewId: string) => unknown;
      Promise.resolve()
        .then(() => fn(msg.params, state, id, msg.viewId))
        .then(
          (result) => {
            state.cancelled.delete(id);
            const { value, transfer } = prepareTransfer(result, state.stateOwned);
            if (dev) assertNoStateTransfer(transfer, state.stateOwned);
            post({ t: "result", id, ok: true, result: value as WorkerMethods[WorkerMethod]["result"] }, transfer);
          },
          (e: unknown) => {
            state.cancelled.delete(id);
            const ce = asCortexError(e);
            const code = ce.code === "E_CANCELLED" ? "E_CANCELLED" : ce.code === "E_BAD_REQUEST" ? "E_BAD_PARAMS" : "E_INTERNAL";
            post({ t: "result", id, ok: false, error: { code, message: ce.message } }, []);
          },
        );
    },
  };
}
