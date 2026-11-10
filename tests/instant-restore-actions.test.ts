import { beforeEach, describe, expect, it } from "vitest";
import { showAllGroups, soloGroup, toggleGroup } from "../src/state/actions";
import { consumeInstantRestore, resetInstantRestore } from "../src/state/instantRestore";
import { createLeafStore } from "../src/state/store";

describe("restore paths mark an instant relight (FIG-25)", () => {
  beforeEach(() => resetInstantRestore());

  it("clearing a solo marks it; setting a solo or hiding one group does not", () => {
    const store = createLeafStore();
    const keys = ["a", "b", "c"];
    soloGroup(store, "a", keys);
    expect(store.get("ui").hiddenGroups).toEqual(["b", "c"]);
    expect(consumeInstantRestore()).toBe(false);
    toggleGroup(store, "b");
    expect(consumeInstantRestore()).toBe(false);
    soloGroup(store, "a", keys);
    soloGroup(store, "a", keys);
    expect(store.get("ui").hiddenGroups).toEqual([]);
    expect(consumeInstantRestore()).toBe(true);
  });

  it("show all marks only when something was hidden", () => {
    const store = createLeafStore();
    showAllGroups(store);
    expect(consumeInstantRestore()).toBe(false);
    toggleGroup(store, "x");
    showAllGroups(store);
    expect(store.get("ui").hiddenGroups).toEqual([]);
    expect(consumeInstantRestore()).toBe(true);
  });
});
