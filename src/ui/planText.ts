/**
 * Words for the plan windows (pure): the 5-hour and weekly limits, how much is used, the cap and the reset time.
 * Shared by the Agents page, the chip and status-bar tips and Settings, so they always agree.
 */
import type { PlanWindowId, PlanWindowView } from "../shared/planLimits";
import { t } from "./copy";

/** The window's name ("5-hour limit", "Weekly limit"). */
export function windowName(id: PlanWindowId): string {
  return t(id === "fiveHour" ? "plan.five" : "plan.week");
}

/** Short name for tips ("5-hour", "weekly"). */
export function windowShort(id: PlanWindowId): string {
  return t(id === "fiveHour" ? "plan.fiveShort" : "plan.weekShort");
}

/** A percent for display: one decimal when it has one ("18.3%"), whole otherwise ("42%"); a tiny share reads 0.1%, not 0. */
export function pctText(pct: number): string {
  const v = Math.max(0, pct);
  const r = Math.round(v * 10) / 10;
  return `${r === 0 && v > 0 ? 0.1 : r}%`;
}

/** When a window resets: a clock time today ("18:30"), otherwise the weekday and time ("Thu 09:00"). */
export function resetWhen(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const clock = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const same = new Date(now).toDateString() === d.toDateString();
  return same ? clock : `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${clock}`;
}

/** "42%" or "not reported yet". */
export function usedText(v: PlanWindowView): string {
  return v.pct === null ? t("plan.unknown") : pctText(v.pct);
}

/** One sentence for a window: used, the cap and the reset ("42% used · stops at 70% · resets 18:30"). */
export function windowLine(v: PlanWindowView, now: number = Date.now()): string {
  const parts: string[] = [v.pct === null ? t("plan.unknown") : t("plan.used", { pct: pctText(v.pct).replace("%", "") })];
  parts.push(v.capPct === null ? t("plan.noCap") : t("plan.stopAt", { pct: Math.round(v.capPct) }));
  if (v.resetsAt !== null) parts.push(t("plan.resets", { when: resetWhen(v.resetsAt, now) }));
  return parts.join(" · ");
}

/** The reading alone for a Settings row ("Used 42%, resets 18:30."). */
export function readingText(v: PlanWindowView, now: number = Date.now()): string {
  if (v.pct === null) return t("plan.readingNone");
  if (v.resetsAt === null) return t("plan.readingStale");
  return t("plan.reading", { pct: pctText(v.pct).replace("%", ""), when: resetWhen(v.resetsAt, now) });
}

/** "5-hour 42% · weekly 18%" for the chip and status-bar tips ("—" for a window with no reading). */
export function planTip(plan: Record<PlanWindowId, PlanWindowView>): string {
  const one = (v: PlanWindowView): string => (v.pct === null ? "—" : pctText(v.pct));
  return t("plan.tip", { five: one(plan.fiveHour), week: one(plan.weekly) });
}
