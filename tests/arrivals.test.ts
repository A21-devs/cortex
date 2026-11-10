/** Held arrivals: the sample record and what is already in the record are never arrivals (CORTEX-UX §6.7). */
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/state/events";
import { heldArrivals } from "../src/state/selectors";
import { createLeafStore, createSharedStore } from "../src/state/store";
import { keepArrivals } from "../src/ui/arrivals";

function rig(autoRefresh = false) {
  const bus = new EventBus();
  const shared = createSharedStore();
  const store = createLeafStore();
  const settings = { value: { sources: { autoRefresh } } };
  const stop = keepArrivals({ bus, shared, settings } as never, store);
  const load = (count: number) => {
    shared.update("data", { phase: "ready", available: count });
    bus.emit("index:loaded", { count, seq: 0, epoch: "e" });
  };
  const arrive = (n: number) => {
    const available = shared.get("data").available + n;
    shared.update("data", { available });
    bus.emit("index:delta", { added: n, seq: 1, epoch: "e" });
    bus.emit("arrivals", { added: n, available });
  };
  const held = () => heldArrivals(store.get("ui"), shared.get("data").available);
  return { load, arrive, held, store, shared, stop };
}

describe("held arrivals", () => {
  it("a fresh leaf with a whole record shown holds nothing (the contract's revealedCount 0)", () => {
    const r = rig();
    r.shared.update("data", { phase: "ready", available: 33_500 });
    expect(heldArrivals(r.store.get("ui"), 33_500)).toBe(0);
  });

  it("entering the sample record is not an arrival, and neither is leaving it", () => {
    const r = rig();
    r.load(1200);
    expect(r.held()).toBe(0);
    r.load(33_500); // the sample record replaces the index
    expect(r.held()).toBe(0);
    r.load(1200); // back to the real record
    expect(r.held()).toBe(0);
  });

  it("holds items appended after the load until Show them", () => {
    const r = rig();
    r.load(100);
    r.arrive(4);
    expect(r.held()).toBe(4);
    r.arrive(1);
    expect(r.held()).toBe(5);
    r.load(105);
    expect(r.held()).toBe(0);
  });

  it("reveals arrivals as they come with Refresh automatically on", () => {
    const r = rig(true);
    r.load(100);
    r.arrive(3);
    expect(r.held()).toBe(0);
    expect(r.store.get("ui").revealedCount).toBe(103);
  });

  it("takes an index that is already showing as the baseline and stops listening when released", () => {
    const bus = new EventBus();
    const shared = createSharedStore();
    shared.update("data", { phase: "ready", available: 50 });
    const store = createLeafStore();
    const stop = keepArrivals({ bus, shared, settings: { value: { sources: { autoRefresh: false } } } } as never, store);
    expect(store.get("ui").revealedCount).toBe(50);
    stop();
    bus.emit("index:loaded", { count: 70, seq: 0, epoch: "e" });
    expect(store.get("ui").revealedCount).toBe(50);
  });
});
