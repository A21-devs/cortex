/**
 * A section of the Chart page that starts closed: a header with a chevron, the title and a one-line summary, and the body
 * only while it is open (a closed section reads nothing from the worker). Used for Show or hide and for the Start from
 * and Fields lists, so the axes, what shows, the chooser and the reading stay in view.
 */
import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import { Icon } from "../../primitives/buttons";

export function ChartDisclosure(p: { title: string; summary?: string; startOpen?: boolean; class?: string; children: ComponentChildren }): JSX.Element {
  const [open, setOpen] = useState(p.startOpen === true);
  return (
    <section class={`cx-section cx-chart-disclosure${open ? " is-open" : ""}${p.class ? ` ${p.class}` : ""}`} aria-label={p.title}>
      <button type="button" class="cx-chart-disclosure-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="cx-chevron cx-chart-disclosure-chevron" aria-hidden="true">
          <Icon name="chevron" />
        </span>
        <span class="cx-chart-disclosure-title">{p.title}</span>
        {p.summary ? <span class="cx-chart-disclosure-summary">{p.summary}</span> : null}
      </button>
      {open ? <div class="cx-chart-disclosure-body">{p.children}</div> : null}
    </section>
  );
}
