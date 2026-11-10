/**
 * Time › Figure, rhythm grid (CORTEX-UX §5.19): weekday × hour for this period, one cell per hour on the count
 * ramp (log-scaled to the busiest cell). Weekday labels at the left, hour ticks (00 · 06 · 12 · 18) above. Each
 * cell carries its own tooltip ("Tue 14:00 · 31 entries"); the grid is a table for assistive technology.
 * Owner: E12 (page); counts from worker stats "rhythm".
 */
import type { JSX } from "preact";
import { COUNT_RAMP, rampAt, rgbToHex } from "../../shared/palette";
import { t } from "../copy";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const SUNDAY_FIRST = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const HOUR_TICKS = [0, 6, 12, 18] as const;

/** Cell colour for a count on the count ramp (log-scaled to the period's maximum); empty cells use the empty stop. */
export function rhythmColour(count: number, max: number, light = false): string {
  if (count <= 0 || max <= 0) return light ? COUNT_RAMP.emptyLight : COUNT_RAMP.emptyDark;
  const f = Math.log1p(count) / Math.log1p(max);
  return rgbToHex(rampAt(light ? COUNT_RAMP.light : COUNT_RAMP.dark, f));
}

/** Weekday labels in display order for the week-start setting (the worker's cells follow the same order). */
export function weekdayLabels(weekStart: 0 | 1): readonly string[] {
  return weekStart === 0 ? SUNDAY_FIRST : WEEKDAYS;
}

/** counts: 7 × 24, week-start first, hour-major within a day. */
export function RhythmGrid(p: {
  counts: Uint32Array;
  light?: boolean;
  weekStart?: 0 | 1;
  /** A cell was chosen: the weekday key (Monday = "1" .. Sunday = "7"), the hour key ("00".."23") and the cell's label. */
  onCell?(weekday: string, hour: string, label: string): void;
}): JSX.Element {
  const max = p.counts.reduce((m, x) => Math.max(m, x), 0);
  const days = weekdayLabels(p.weekStart ?? 1);
  return (
    <figure class="cx-rhythm">
      <figcaption>{t("time.rhythm")}</figcaption>
      <div class="cx-rhythm-grid" role="table" aria-label={t("time.rhythm")}>
        <div class="cx-rhythm-row cx-rhythm-ticks" role="row" aria-hidden="true">
          <span class="cx-rhythm-day" />
          {Array.from({ length: 24 }, (_, h) => (
            <span class="cx-rhythm-tick cx-mono">{HOUR_TICKS.includes(h as 0 | 6 | 12 | 18) ? String(h).padStart(2, "0") : ""}</span>
          ))}
        </div>
        {days.map((day, d) => (
          <div role="row" class="cx-rhythm-row">
            <span class="cx-rhythm-day cx-mono" role="rowheader">
              {day}
            </span>
            {Array.from({ length: 24 }, (_, h) => {
              const n = p.counts[d * 24 + h] ?? 0;
              const tip = t("time.rhythmTip", { day, hour: String(h).padStart(2, "0"), n: n.toLocaleString("en-GB") });
              const pick = p.onCell;
              const weekday = String((p.weekStart ?? 1) === 0 ? (d === 0 ? 7 : d) : d + 1);
              const hour = String(h).padStart(2, "0");
              return (
                <span
                  role="cell"
                  class="cx-rhythm-cell"
                  style={{ background: rhythmColour(n, max, p.light), ...(pick ? { cursor: "pointer" } : {}) }}
                  title={tip}
                  aria-label={tip}
                  onClick={pick ? () => pick(weekday, hour, t("time.rhythmToken", { day, from: hour, to: String((h + 1) % 24).padStart(2, "0") })) : undefined}
                />
              );
            })}
          </div>
        ))}
      </div>
    </figure>
  );
}
