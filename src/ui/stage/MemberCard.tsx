/**
 * Map hover member card (CORTEX-UX §6.9, F9, P1; ORIG-17): one glass-strong 260 px card beside a hovered map —
 * the map's kind and "‹n› notes", then up to 8 members as kind glyph + title, then "+‹n› more". It replaces
 * scattered chips; spokes are drawn only on selection. Flipped near edges. Owner: E11.
 */
import type { JSX } from "preact";
import { t } from "../copy";

export const MEMBER_CARD = { width: 260, maxRows: 8 } as const;

export function MemberCard(p: { kind: string; notes: number; members: readonly { glyph: string; title: string }[]; /** Members in all when `members` holds only the first few. */ total?: number; x: number; y: number }): JSX.Element {
  const shown = p.members.slice(0, MEMBER_CARD.maxRows);
  const more = (p.total ?? p.members.length) - shown.length;
  return (
    <aside class="cx-member-card" style={{ left: `${p.x}px`, top: `${p.y}px`, width: `${MEMBER_CARD.width}px` }}>
      <header>{t("reader.cardHead", { kind: p.kind, n: p.notes.toLocaleString("en-GB") })}</header>
      <ul>
        {shown.map((m) => (
          <li>
            <span class="cx-kind-glyph" aria-hidden="true">
              {m.glyph}
            </span>
            {m.title}
          </li>
        ))}
      </ul>
      {more > 0 ? <p class="cx-note">{t("reader.moreMembers", { n: more })}</p> : null}
    </aside>
  );
}
