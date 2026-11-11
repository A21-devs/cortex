import { describe, expect, it } from "vitest";
import { migrateSettingsChecked } from "../src/shared/settings";
import { closeSheet, openTab, pushSheet } from "../src/state/actions";
import { createLeafStore } from "../src/state/store";
import { defaultView } from "../src/state/types";

describe("a reader opened from the stage", () => {
  it("starts a fresh sheet stack when the sheet was closed (no stale back crumb)", () => {
    const store = createLeafStore({ view: defaultView(migrateSettingsChecked(undefined).settings) });
    pushSheet(store, { kind: "reader", route: "note", id: "w_one" });
    closeSheet(store);
    pushSheet(store, { kind: "reader", route: "map", id: "n_two" });
    const sheet = store.get("ui").sheet;
    expect(sheet.stack).toHaveLength(1);
    expect(sheet.index).toBe(0);
    expect(sheet.stack[0]).toMatchObject({ id: "n_two" });
  });
  it("keeps the stack while the sheet is open", () => {
    const store = createLeafStore({ view: defaultView(migrateSettingsChecked(undefined).settings) });
    openTab(store, "read");
    pushSheet(store, { kind: "reader", route: "entry", id: "e_1" });
    expect(store.get("ui").sheet.stack).toHaveLength(2);
  });
});
