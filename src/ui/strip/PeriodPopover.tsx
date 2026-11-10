/**
 * "Custom…" period (CORTEX-UX §5.8, F30, P1): a two-field date popover (From · To) under the strip's period
 * picker; Enter applies, Esc closes. The period is per leaf (H4) and also set by the brushes and `set_period`.
 * Owner: E11.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../copy";

/** Parse the two fields into a period; null when either is invalid or From is after To. */
export function parsePeriod(from: string, to: string): [string, string] | null {
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  if (!ok(from) || !ok(to) || from > to) return null;
  return [from, to];
}

export function PeriodPopover(p: { from: string; to: string; onApply(range: [string, string]): void; onClose?(): void }): JSX.Element {
  const [from, setFrom] = useState(p.from);
  const [to, setTo] = useState(p.to);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const range = parsePeriod(from, to);
  return (
    <form
      class="cx-popover cx-period-popover"
      aria-label={t("strip.custom")}
      onSubmit={(e) => {
        e.preventDefault();
        if (range) p.onApply(range);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          p.onClose?.();
        }
      }}
    >
      <label class="cx-row">
        <span class="cx-row-label">{t("strip.from")}</span>
        <input ref={first} type="date" class="cx-input" value={from} onInput={(e) => setFrom((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <label class="cx-row">
        <span class="cx-row-label">{t("strip.to")}</span>
        <input type="date" class="cx-input" value={to} aria-invalid={range ? undefined : true} onInput={(e) => setTo((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <button type="submit" class="cx-sr-only" tabIndex={-1} disabled={!range}>
        {t("strip.custom")}
      </button>
    </form>
  );
}
