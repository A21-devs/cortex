/**
 * The Agents page's plan meter with a reading: the bar fills to the share used, the cap shows as a mark, the line names the
 * cap and the reset time, and the window at its cap says so. (Without a reading the page shows "not reported yet".)
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { planViews } from "../src/shared/planLimits";
import { PlanMeter } from "../src/ui/pages/Agents";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const views = (five: number, caps = { fiveHour: 70, weekly: 70 }) =>
  planViews({ fiveHour: { pct: five, resetsAt: NOW + 2 * 3_600_000, seenAt: NOW }, weekly: { pct: 18, resetsAt: NOW + 86_400_000, seenAt: NOW } }, caps, NOW);

describe("Agents: the plan meter", () => {
  it("fills the bar to the share used and marks the cap", () => {
    const html = render(<PlanMeter view={views(42).fiveHour} on pct={70} onChange={() => undefined} />);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain("width:42%");
    expect(html).toContain("left:70%");
    expect(html).toContain("5-hour limit: 42%");
    expect(html).toContain("42% used · stops at 70% · resets");
    expect(html).not.toContain("is-at-cap");
  });
  it("shows a window at its cap, and no mark when the cap is off", () => {
    const at = render(<PlanMeter view={views(71).fiveHour} on pct={70} onChange={() => undefined} />);
    expect(at).toContain("is-at-cap");
    const off = render(<PlanMeter view={views(71, { fiveHour: 0 as never, weekly: 70 }).fiveHour} on={false} pct={70} onChange={() => undefined} />);
    expect(off).not.toContain("cx-plan-mark");
    expect(off).toContain("no cap");
  });
  it("reads not reported yet before any call has run", () => {
    const html = render(<PlanMeter view={planViews(undefined, { fiveHour: 70, weekly: 70 }, NOW).weekly} on pct={70} onChange={() => undefined} />);
    expect(html).toContain("not reported yet · stops at 70%");
    expect(html).toContain('aria-valuenow="0"');
  });
});
