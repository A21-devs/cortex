/**
 * The screenshot harness's stand-in agents status (src/desktop/shotSteps.ts `agentsStatus`, `--agents-status`): the
 * sample files in scripts/shots/ are valid and neutral, and a status applied through the runner's own path
 * (src/plugin/container.ts applyStatus) fills the shared queues the Agents page reads, so its status card says what is
 * waiting. Pure: no Electron, no runner.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { loadStatusFiles, parseAgentsStatusText, parseStepsText } from "../src/desktop/shotSteps";
import { applyStatus } from "../src/plugin/container";
import { createSharedStore } from "../src/state/store";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { SHEET_PAGES } from "../src/ui/pages";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

const shots = path.resolve(__dirname, "..", "scripts", "shots");
const read = (name: string): string => readFileSync(path.join(shots, name), "utf8");
const sample = parseAgentsStatusText(read("agents-status.json"));

function agentsPage(h: FakeHarness): string {
  const Page = SHEET_PAGES.agents;
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>
        <Page params={{}} />
      </LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

describe("the sample stand-in status and its steps", () => {
  it("is a valid status whose groups use neutral folder names and add up to the pending work", () => {
    expect(sample.groups?.map((g) => g.where ?? g.what)).toEqual(["Projects", "Inbox", "docs", "chats", "Vault", "summaries", "maps"]);
    expect(sample.pending).toMatchObject({ label: 412, gist: 6, hub: 2 });
    expect(sample.engine).toBe("ok");
  });

  it("applies the sample status, shows agents as on without saving, opens the Agents page and captures it", () => {
    const steps = loadStatusFiles(parseStepsText(read("agents-waiting.json")), read);
    expect(steps.map((s) => s.kind)).toEqual(["agentsStatus", "eval", "eval", "wait", "capture"]);
    expect(steps[0]).toEqual({ kind: "agentsStatus", file: "agents-status.json", status: sample });
    const js = steps.flatMap((s) => (s.kind === "eval" ? [s.js] : [])).join("\n");
    expect(js).toContain("settings.preview(");
    expect(js).not.toContain("settings.update(");
    expect(js).toContain("cortex:open-agents");
    expect(steps.at(-1)).toEqual({ kind: "capture", path: "agents-waiting.png" });
  });
});

describe("applying a stand-in status", () => {
  it("fills the shared queues and the activity as the runner's agents.status does", () => {
    const shared = createSharedStore();
    applyStatus(shared, sample);
    expect(shared.get("queues")).toMatchObject({ label: 412, summaries: 6, maps: 2, checks: 14, groups: sample.groups });
    expect(shared.get("activity")).toMatchObject({ engine: "ok", capped: false, tokensToday: 0, usdToday: 0, plan: sample.plan });
  });

  it("puts the count and what is waiting on the Agents page's status card", () => {
    const h = fakeServices((s) => void (s.agents.enabled = true));
    expect(agentsPage(h)).not.toContain('aria-label="What is waiting"');
    applyStatus(h.services.shared, sample);
    const html = agentsPage(h);
    expect(html).toContain("420 items waiting · starting within a minute");
    expect(html).toContain('aria-label="What is waiting"');
    expect(html).toContain("<li>268 notes to organise in Projects (Website, Garden…)</li>");
    expect(html).toContain("<li>97 notes to organise in Inbox</li>");
    expect(html).toContain("The other 55: 38 notes in docs and Vault, 9 chats, 6 chat summaries and 2 area maps.");
  });

  it("keeps the count and the lines off while agents are switched off, as for a real status", () => {
    // The sample vault has agents off: a stand-in status alone shows this, so agents-waiting.json turns them on.
    const h = fakeServices((s) => void (s.agents.enabled = false));
    applyStatus(h.services.shared, sample);
    const html = agentsPage(h);
    expect(html).toContain(t("agents.off"));
    expect(html).not.toContain(t("agents.waitingSoon", { n: "420" }));
    expect(html).not.toContain('aria-label="What is waiting"');
  });
});
