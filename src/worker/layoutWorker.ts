/**
 * Web Worker entry (bundled to an IIFE string and inlined into main.js). Owner: E8.
 * No DOM, no Node, no Obsidian, no three.js in this bundle (enforced by scripts/check-boundaries.mjs).
 */
import type { FromWorker, ToWorker } from "../shared/protocol/worker";
import { createWorkerHandler, WORKER_VERSION } from "./handler";

interface WorkerScope {
  postMessage(msg: FromWorker, transfer: ArrayBuffer[]): void;
  onmessage: ((ev: { data: ToWorker }) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;
const handler = createWorkerHandler((msg, transfer) => scope.postMessage(msg, transfer));
scope.onmessage = (ev) => handler.onMessage(ev.data);
scope.postMessage({ t: "ready", version: WORKER_VERSION }, []);
