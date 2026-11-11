/** Guide "How your record is kept": node states from settings and facts, honest built flags, keyboard order, markup. */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import { COPY, t } from "../src/ui/copy";
import { RecordDiagram } from "../src/ui/pages/guide/RecordDiagram";
import { BUILT, moveNode, NODE_IDS, PATH_NODES, peek, recordNodes, RECORD_TABS, SIDE_NODES, sourcesOn, STATUS_COPY, TAB_NODES, type NodeId, type RecordFacts } from "../src/ui/pages/guide/recordModel";

const facts = (over: Partial<RecordFacts> = {}): RecordFacts => ({ seals: null, entries: null, checksOpen: 0, date: (iso) => iso.slice(0, 10), ...over });
const settings = (patch?: (s: CortexSettings) => void): CortexSettings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  patch?.(s);
  return s;
};
const node = (list: ReturnType<typeof recordNodes>, id: NodeId) => list.find((n) => n.id === id)!;

describe("record diagram model", () => {
  it("has the ten steps in order: five on the path, five beside it", () => {
    expect(PATH_NODES).toEqual(["sources", "screen", "seal", "date", "anchor"]);
    expect(SIDE_NODES).toEqual(["vault", "keys", "checks", "outcomes", "export"]);
    expect(recordNodes(settings(), facts(), t).map((n) => n.id)).toEqual([...NODE_IDS]);
  });

  it("every node, status, tab and gap has copy", () => {
    for (const n of recordNodes(settings(), facts(), t)) {
      expect(t(n.name)).not.toContain("guide.record");
      expect(t(n.what)).not.toContain("guide.record");
      expect(n.state).not.toContain("guide.record");
      for (const g of n.gaps) expect(g).not.toContain("guide.record");
    }
    for (const k of Object.values(STATUS_COPY)) expect(t(k)).not.toContain("guide.record");
    for (const id of RECORD_TABS) expect(COPY.guide.record.tabs[id].length).toBeGreaterThan(3);
    for (const id of RECORD_TABS) for (const n of TAB_NODES[id]) expect(NODE_IDS).toContain(n);
  });

  it("seal says on or off from the setting and counts blocks from the facts", () => {
    const off = recordNodes(settings((s) => void (s.advanced.dateSeals.sealLocally = false)), facts(), t);
    expect(node(off, "seal").status).toBe("optional");
    expect(node(off, "seal").state).toBe("Sealing off. Turn it on.");
    expect(node(recordNodes(settings(), facts(), t), "seal").status).toBe("local"); // new records are sealed by default
    const on = (f: RecordFacts) => recordNodes(settings((s) => void (s.advanced.dateSeals.sealLocally = true)), f, t);
    expect(node(on(facts()), "seal").state).toBe("Sealing on");
    expect(node(on(facts({ seals: { blocks: 0, entries: 0, intact: true } })), "seal").state).toBe("Sealing on, no block yet");
    const live = on(facts({ seals: { blocks: 418, entries: 9000, intact: true } }));
    expect(node(live, "seal").state).toBe("Sealing on, 418 blocks");
    expect(node(live, "seal").status).toBe("local");
    expect(node(live, "date").state).toBe("9000 entries have a provable bound");
    expect(node(on(facts({ seals: { blocks: 3, entries: 4, intact: false } })), "seal").state).toContain("chain is broken");
  });

  it("anchor needs consent and shows the date it was anchored, never claiming it when it was not", () => {
    const none = recordNodes(settings(), facts({ seals: { blocks: 2, entries: 5, intact: true } }), t);
    expect(node(none, "anchor").status).toBe("consent");
    expect(node(none, "anchor").state).toContain("Not anchored");
    const done = recordNodes(settings(), facts({ seals: { blocks: 2, entries: 5, intact: true, anchoredAt: "2026-11-02T10:00:00Z" } }), t);
    expect(node(done, "anchor").state).toBe("Anchored publicly on 2026-11-02");
    const weekly = recordNodes(settings((s) => void (s.advanced.dateSeals.weeklyStamp = true)), facts(), t);
    expect(node(weekly, "anchor").state).toContain("weekly timestamp is on");
  });

  it("screen follows the redaction settings", () => {
    const def = recordNodes(settings(), facts(), t);
    expect(node(def, "screen").state).toContain("secrets, emails, phone numbers");
    const off = recordNodes(settings((s) => void (s.privacy.redact = { secrets: false, emails: false, phones: false, personal: false, custom: [] })), facts(), t);
    expect(node(off, "screen").status).toBe("optional");
    expect(node(off, "screen").state).toBe("Screening off. Turn it on.");
    const own = recordNodes(settings((s) => void (s.privacy.redact = { secrets: false, emails: false, phones: false, personal: false, custom: ["x"] })), facts(), t);
    expect(node(own, "screen").state).toContain("your own patterns");
  });

  it("keys follow the lock; encryption is not claimed while this build lacks it", () => {
    const none = node(recordNodes(settings(), facts(), t), "keys");
    expect(none.state).toBe("No passphrase. The lock only blanks the screen.");
    expect(none.built).toBe(true);
    expect(none.gaps.join(" ")).toContain("Encrypting the record at rest");
    const set = node(recordNodes(settings((s) => void (s.privacy.lock = { salt: "a", hash: "b", iterations: 1, autoLockMinutes: 10 })), facts(), t), "keys");
    expect(set.state).toBe("Passphrase set, locks after 10 minutes");
    const never = node(recordNodes(settings((s) => void (s.privacy.lock = { salt: "a", hash: "b", iterations: 1, autoLockMinutes: 0 })), facts(), t), "keys");
    expect(never.state).toBe("Passphrase set, never locks on its own");
  });

  it("a later feature reads its own setting once it is built, and shows no gap", () => {
    const all = { encryption: true, keyShares: true, signing: true, proofExport: true, outcomes: true };
    const withEnc = (on: boolean) => settings((s) => void ((s as unknown as Record<string, unknown>).record = { encryption: { enabled: on } }));
    const off = recordNodes(withEnc(false), facts(), t, all);
    expect(node(off, "keys").state).toContain("Encryption off. Turn it on.");
    expect(node(off, "keys").gaps).toEqual([]);
    expect(node(recordNodes(withEnc(true), facts(), t, all), "keys").state).toContain("Encryption on");
    const outcomes = node(off, "outcomes");
    expect(outcomes.built).toBe(true);
    expect(outcomes.status).toBe("optional");
    expect(peek(withEnc(true), "record.encryption.enabled")).toBe(true);
    expect(peek({}, "record.encryption.enabled")).toBeUndefined();
  });

  it("outcomes is not offered, with a hollow dot, until the build has it", () => {
    const o = node(recordNodes(settings(), facts(), t, { ...BUILT, outcomes: false }), "outcomes");
    expect(o.status).toBe("notOffered");
    expect(o.built).toBe(false);
    expect(o.gaps.length).toBe(1);
  });

  it("vault, checks and sources read the facts and settings", () => {
    const n = recordNodes(settings(), facts({ entries: 12345, checksOpen: 7 }), t);
    expect(node(n, "vault").state).toBe("12,345 entries kept");
    expect(node(n, "checks").state).toBe("7 checks open");
    expect(node(recordNodes(settings(), facts({ entries: 0 }), t), "vault").state).toBe("Nothing kept yet.");
    expect(node(recordNodes(settings(), facts(), t), "checks").state).toBe("No checks open");
    expect(sourcesOn(settings())).toBeGreaterThan(0);
    const allOff = settings((s) => {
      s.sources.vault.enabled = s.sources.raw.enabled = s.sources.claudeCode.enabled = s.sources.claudeAi.enabled = false;
      s.sources.chatgpt.enabled = s.sources.gemini.enabled = s.sources.written.enabled = false;
      s.sources.folders = [];
    });
    expect(node(recordNodes(allOff, facts(), t), "sources").state).toContain("No source is on");
  });

  it("arrows move along the order and between the two rows", () => {
    expect(moveNode("sources", "ArrowRight")).toBe("screen");
    expect(moveNode("anchor", "ArrowRight")).toBe("vault");
    expect(moveNode("sources", "ArrowLeft")).toBe("export");
    expect(moveNode("seal", "ArrowDown")).toBe("checks");
    expect(moveNode("checks", "ArrowUp")).toBe("seal");
    expect(moveNode("seal", "ArrowUp")).toBe("seal");
    expect(moveNode("seal", "Home")).toBe("sources");
    expect(moveNode("seal", "End")).toBe("export");
    expect(moveNode("seal", "a")).toBeNull();
  });
});

describe("record diagram markup", () => {
  const html = (over: Partial<Parameters<typeof RecordDiagram>[0]> = {}) => render(<RecordDiagram settings={settings()} facts={facts()} onAction={() => undefined} {...over} />);

  it("lists the nodes in reading order with names a screen reader gets in full", () => {
    const out = html();
    const order = NODE_IDS.map((id) => out.indexOf(`data-node="${id}"`));
    expect(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
    expect(out).toContain("Seal, On this computer, Built. Sealing on");
    expect(out).toContain("Outcomes, Optional, Built.");
    expect((out.match(/tabindex="0"/g) ?? []).length).toBe(2); // one node and the selected tab
  });

  it("shows the legend, four tabs and no card until a step is lit", () => {
    const out = html();
    for (const k of Object.values(STATUS_COPY)) expect(out).toContain(t(k));
    for (const id of RECORD_TABS) expect(out).toContain(COPY.guide.record.tabs[id]);
    expect(out).toContain('role="tablist"');
    expect(out).toContain(t("guide.record.pickOne"));
    expect(out).not.toContain("data-node-card");
  });

  it("a lit step opens its card with the live line, status and the way to change it", () => {
    const out = html({ initialNode: "seal", settings: settings((s) => void (s.advanced.dateSeals.sealLocally = true)), facts: facts({ seals: { blocks: 418, entries: 1, intact: true } }) });
    expect(out).toContain('data-node-card="seal"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("Sealing on, 418 blocks");
    expect(out).toContain(t("guide.record.openSettings"));
  });

  it("the selected tab shows its own question and live lines", () => {
    const out = html({ initialTab: "dated", settings: settings((s) => void (s.advanced.dateSeals.sealLocally = false)) });
    expect(out).toContain(COPY.guide.record.tabBody.dated);
    expect(out).toContain("Sealing off. Turn it on.");
    expect(out).toContain('aria-selected="true"');
  });
});
