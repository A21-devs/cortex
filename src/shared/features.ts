/**
 * Built-in, phase-gated feature map (not a user setting). FROZEN CONTRACT (owner: architect).
 *
 * P0 surfaces must never show a button for something that is not built yet. Every surface that offers a later
 * feature (the Chart target on the shape bar, the sample record on the empty-state card and in Guide, Link
 * views, Replay, Date seals …) checks `featureOn(id)` and hides the control until its phase ships. The
 * integration lead bumps BUILD_PHASE at each milestone (ARCHITECTURE §18).
 */

export type Phase = "P0" | "P1" | "P2";

/** Phase the current build ships. */
export const BUILD_PHASE: Phase = "P2";

export type FeatureId =
  | "chartShape"
  | "chartPage"
  | "maps"
  | "ask"
  | "checks"
  | "guide"
  | "compass"
  | "compassDrag"
  | "exportImports"
  | "geminiImport"
  | "folderSources"
  | "sampleRecord"
  | "replay"
  | "linkViews"
  | "dateSeals"
  | "pinView"
  | "highlightTokens"
  | "combineValues"
  | "appearanceSettings"
  | "advancedSettings"
  /** F49: New entry, Read › Today, Time › Data, Sources › Files (P2). */
  | "newEntry"
  | "today"
  | "dataView"
  | "sourcesFiles"
  /** F47/F68: first-run checklist and one-time hints (P1); the first-run consent step itself is P0. */
  | "hints"
  /** F39/F44: the Agents ledger and its work-waiting bars (P1; the status card and engine line are P0). */
  | "agentsLedger"
  /** F59: live recording, held arrivals and birth on Show them (P1). */
  | "liveArrivals"
  /** F61: reader Correct, map Flag and the correction dialogs (P1). */
  | "corrections"
  /** F12: Tree, Along the spine and Strata layouts (P1; Bubbles is P0). */
  | "groupLayouts"
  /** F20: source lines and conversation stems (P1). */
  | "lines"
  /** F30: the period (strip brush, Time page brush, period picker; P1). */
  | "period"
  /** F66: Display › Points sliders (P1). */
  | "pointControls";

export const FEATURE_PHASE: Readonly<Record<FeatureId, Phase>> = {
  chartShape: "P1",
  chartPage: "P1",
  maps: "P1",
  ask: "P1",
  checks: "P1",
  guide: "P1",
  compass: "P1",
  compassDrag: "P1",
  exportImports: "P1",
  geminiImport: "P2",
  folderSources: "P1",
  sampleRecord: "P2",
  replay: "P2",
  linkViews: "P2",
  dateSeals: "P2",
  pinView: "P2",
  highlightTokens: "P2",
  combineValues: "P2",
  appearanceSettings: "P1",
  advancedSettings: "P2",
  newEntry: "P2",
  today: "P2",
  dataView: "P2",
  sourcesFiles: "P2",
  hints: "P1",
  agentsLedger: "P1",
  liveArrivals: "P1",
  corrections: "P1",
  groupLayouts: "P1",
  lines: "P1",
  period: "P1",
  pointControls: "P1",
};

const ORDER: readonly Phase[] = ["P0", "P1", "P2"];

export function featureOn(id: FeatureId, phase: Phase = BUILD_PHASE): boolean {
  return ORDER.indexOf(FEATURE_PHASE[id]) <= ORDER.indexOf(phase);
}
