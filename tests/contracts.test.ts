/**
 * Frozen contracts (owner: architect) checked against CORTEX-UX v1.1 (§5, §7, §8, §12): routes, the action
 * registry, dimensions, packs, the chart catalogue, line families, copy coverage and feature phases.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_NAMES, ACTION_SPECS, MAX_ACTIONS_PER_REPLY, MAX_ITEMS_PER_ACTION, MAX_REFRESH_ITEMS, needsApply, verbAllowed } from "../src/shared/actions";
import { BUILTIN_DIMS, dateDim, DIM_GROUP_ORDER, GROUP_LAYOUTS, isDateDim, parseDateDim } from "../src/shared/dims";
import { BUILD_PHASE, FEATURE_PHASE, featureOn } from "../src/shared/features";
import { CORTEX_FRONTMATTER_KEYS } from "../src/shared/notesDoc";
import { FIXES_PACK, PARA_PACK, SESSION_PACK, STARTER_PACKS } from "../src/shared/packs";
import { LINE_FAMILIES } from "../src/shared/protocol/worker";
import { CHART_CATALOGUE, CHART_IDS, PAGE_IDS, PAGE_ROUTE, READER_ROUTES, ROUTE_VIEWS, SHEET_PAGE_ROUTES, SHEET_STACK_MAX, SHEET_WIDTH } from "../src/shared/views";
import { validateActionCall } from "../src/plugin/aiExecutor";
import { COPY, t, type CopyKey } from "../src/ui/copy";
import { SHEET_PAGES } from "../src/ui/pages";
import { valueLabel } from "../src/ui/valueLabels";

const UX = fs.readFileSync(path.join(__dirname, "..", "docs", "CORTEX-UX.md"), "utf8");
const section = (from: string, to: string) => UX.slice(UX.indexOf(from), UX.indexOf(to, UX.indexOf(from) + from.length));

describe("shared/views (§12.2)", () => {
  it("has five page families, sheet page routes (including You) and reader routes", () => {
    expect(PAGE_IDS).toEqual(["brain", "read", "time", "agents", "sources"]);
    expect([...SHEET_PAGE_ROUTES, ...READER_ROUTES].sort()).toEqual(["add", "agents", "change-history", "chart", "conversation", "entry", "guide", "map", "new-entry", "note", "read", "runs", "sources", "thread", "time", "today", "vault-peek", "you"].sort());
    expect(PAGE_ROUTE.brain).toBeNull();
    expect(ROUTE_VIEWS.time).toEqual(["charts", "figure", "data"]);
    expect(ROUTE_VIEWS.agents).toEqual(["ledger", "checks", "access"]);
    expect(ROUTE_VIEWS.sources).toEqual(["sources", "files", "privacy"]);
    expect(SHEET_STACK_MAX).toBe(12);
    expect(SHEET_WIDTH).toEqual({ default: 400, min: 340, max: 560 });
    for (const r of SHEET_PAGE_ROUTES) expect(SHEET_PAGES[r]).toBeTypeOf("function");
  });
  it("matches the chart catalogue of §7.2 (names, groups and phases)", () => {
    const table = section("### 7.2 Catalogue", "### 7.3");
    const rows = [...table.matchAll(/^\| \*\*([^*]+)\*\* \| (Compare|Over time|Rhythm|Connections) \|.*\| (P[12]) \|$/gm)];
    expect(rows.length).toBe(18);
    expect(CHART_IDS.length).toBeGreaterThanOrEqual(18);
    const group = { Compare: "compare", "Over time": "time", Rhythm: "rhythm", Connections: "connections" } as const;
    for (const [, name, g, phase] of rows) {
      const def = CHART_CATALOGUE.find((c) => COPY.charts[c.id] === name);
      expect(def, name).toBeDefined();
      expect(def?.group).toBe(group[g as keyof typeof group]);
      expect(def?.phase).toBe(phase);
    }
  });
});

describe("shared/actions (§5.10, §12.7)", () => {
  it("has exactly the UX verbs with their flags", () => {
    expect([...ACTION_NAMES].sort()).toEqual(["arrange", "correct_entry", "exclude", "include", "make_chart", "merge_groups", "open_view", "pin", "propose_filing", "refile", "refresh", "set_date", "set_label", "set_period", "set_speaker", "trace"].sort());
    const data = ACTION_NAMES.filter((a) => ACTION_SPECS[a].changesData).sort();
    expect(data).toEqual(["correct_entry", "exclude", "include", "merge_groups", "refile", "set_date", "set_label", "set_speaker"].sort());
    expect(ACTION_NAMES.filter((a) => ACTION_SPECS[a].alwaysConfirm).sort()).toEqual(["correct_entry", "include"]);
    expect(ACTION_NAMES.filter((a) => ACTION_SPECS[a].spendsBudget).sort()).toEqual(["propose_filing", "refresh"]);
    expect(MAX_ACTIONS_PER_REPLY).toBe(8);
    expect(MAX_ITEMS_PER_ACTION).toBe(500);
    expect(MAX_REFRESH_ITEMS).toBe(200);
  });
  it("applies the Apply rules (SAFE-04)", () => {
    expect(needsApply("trace", false)).toBe(false);
    expect(needsApply("set_label", false)).toBe(true);
    expect(needsApply("set_label", true)).toBe(false);
    expect(needsApply("include", true)).toBe(true);
    expect(needsApply("correct_entry", true)).toBe(true);
    expect(needsApply("refresh", true)).toBe(true);
  });
  it("validates calls with closed schemas, limits and onlyVerb", () => {
    expect(validateActionCall({ action: "trace", params: { query: "trade" } }).ok).toBe(true);
    expect(validateActionCall({ action: "trace", params: { query: "x", extra: 1 } }).ok).toBe(false);
    expect(validateActionCall({ action: "refresh", params: { scope: "all" } }).ok).toBe(false);
    expect(validateActionCall({ action: "open_view", params: { view: "settings" } }).ok).toBe(false);
    expect(validateActionCall({ action: "open_view", params: { view: "agents", tab: "checks" } }).ok).toBe(true);
    const r = validateActionCall({ action: "exclude", params: { target: "c_aaaaaaaaaaaaaaaa", scope: "conversation" } }, { onlyVerb: "trace" });
    expect(r).toEqual({ ok: false, reason: "not-allowed" });
    expect(verbAllowed("set_date", ["correct_entry", "set_date", "set_speaker"])).toBe(true);
    const many = Array.from({ length: 501 }, (_, i) => `e_${"a".repeat(15)}${"abcdefghijklmnopqrstuvwxyz234567"[i % 32]}`);
    expect(validateActionCall({ action: "set_label", params: { targets: many, pack: "session", field: "work", value: "debug" } }).ok).toBe(false);
    expect(validateActionCall({ action: "trace", params: { query: "x", __proto__: { evil: 1 } } }).ok).toBe(true);
    expect(validateActionCall(JSON.parse('{"action":"trace","params":{"constructor":1}}')).ok).toBe(false);
  });
});

describe("shared/dims (§7.3, §12.5)", () => {
  it("has one date dimension with grain and basis, provenance groups and six layouts", () => {
    expect(DIM_GROUP_ORDER).toEqual(["date", "file", "conversation", "agents", "you", "resume"]);
    expect(GROUP_LAYOUTS).toEqual(["bubbles", "tree", "spine", "strata", "wheel", "grid"]);
    expect(dateDim("week", "imported")).toBe("week:imported");
    expect(dateDim("hour", "imported")).toBe("hour");
    expect(parseDateDim("month:imported")).toEqual({ grain: "month", basis: "imported" });
    expect(isDateDim("space")).toBe(false);
    expect(BUILTIN_DIMS.filter((d) => d.group === "file").map((d) => d.id)).toEqual(["space", "folder", "folderPath", "layer", "layer2", "filing", "recency"]);
    expect(BUILTIN_DIMS.filter((d) => d.group === "conversation").map((d) => d.id)).toEqual(["source", "project", "conversation", "speaker"]);
    for (const d of BUILTIN_DIMS) expect(COPY.dims[d.none]).toBeTruthy();
  });
});

describe("shared/packs and note templates (§12.5, §12.11)", () => {
  it("ships session, placement, PARA (derived), correction and résumé packs", () => {
    expect(STARTER_PACKS.map((p) => `${p.id}@${p.version}`)).toEqual(["session@1.0.0", "placement@1.0.0", "para@1.0.0", "correction@1.0.0", "resume@1.0.0"]);
    expect(SESSION_PACK.fields.map((f) => f.key)).toEqual(["work", "outcome", "project", "topics"]);
    expect(SESSION_PACK.fields[0]?.values).toEqual(["debug", "build", "research", "write", "set up", "plan"]);
    expect(SESSION_PACK.fields[1]?.values).toEqual(["shipped", "partly done", "abandoned", "blocked", "still open"]);
    expect(PARA_PACK.writer).toBe("derived");
    expect(FIXES_PACK.fields[0]).toMatchObject({ key: "fixes", label: "Your fixes" });
    for (const k of CORTEX_FRONTMATTER_KEYS) expect(k === "made_by" || k === "conversation" || k === "space" || k.startsWith("cortex_")).toBe(true);
    expect(CORTEX_FRONTMATTER_KEYS).toContain("cortex_project");
  });
});

describe("protocol/worker lines (§6.10)", () => {
  it("has source lines, conversation stems, map spokes and note links", () => {
    expect(LINE_FAMILIES).toEqual(["source", "stem", "spoke", "link"]);
  });
});

describe("ui/copy coverage", () => {
  it("names every page, route, chart, hint and value", () => {
    for (const k of [...PAGE_IDS, ...SHEET_PAGE_ROUTES]) expect(t(`pages.${k}` as CopyKey)).not.toBe(`pages.${k}`);
    for (const k of READER_ROUTES) expect(t(`routes.${k}` as CopyKey)).not.toBe(`routes.${k}`);
    for (const id of CHART_IDS) expect(COPY.charts[id]).toBeTruthy();
    expect(valueLabel("gist")).toBe("summary");
    expect(valueLabel("hub")).toBe("map");
    expect(valueLabel("quiet")).toBe("cooling");
    expect(valueLabel("cortex-ask")).toBe("Ask history");
  });
  it("keeps the vocabulary of §1.6 (trace, not light)", () => {
    expect(t("command.traced", { n: 214 })).toBe("214 traced");
    expect(t("command.footer", { n: 3 })).toContain("trace all");
  });
});

describe("shared/features (§9 phases)", () => {
  it("ships P2: every feature is on in the build", () => {
    expect(BUILD_PHASE).toBe("P2");
    for (const id of Object.keys(FEATURE_PHASE) as (keyof typeof FEATURE_PHASE)[]) expect(featureOn(id), id).toBe(true);
  });
  it("still gates P1 and P2 surfaces at the earlier phases", () => {
    expect(featureOn("ask", "P0")).toBe(false);
    expect(featureOn("ask", "P1")).toBe(true);
    expect(featureOn("newEntry", "P1")).toBe(false);
    expect(featureOn("newEntry", "P2")).toBe(true);
    expect(FEATURE_PHASE.checks).toBe("P1");
    expect(FEATURE_PHASE.sourcesFiles).toBe("P2");
  });
});
