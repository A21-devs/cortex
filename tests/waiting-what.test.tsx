/**
 * The Agents status card says what is waiting under its count: the main groups one line each, then one line for the rest.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import type { PendingGroup } from "../src/shared/protocol/runner";
import { WaitingWhat } from "../src/ui/pages/Agents";

describe("Agents: what is waiting", () => {
  it("lists the main groups and sums up the others in one line", () => {
    const groups: PendingGroup[] = [
      { what: "notes", where: "Game Notes V2", n: 840, inside: ["03 Animation", "04 Gameplay"], insideTotal: 53 },
      { what: "notes", where: "Vault", n: 11 },
      { what: "notes", where: "docs", n: 10 },
      { what: "summaries", n: 1 },
      { what: "maps", n: 1 },
      { what: "chats", n: 1 },
      { what: "notes", where: "Animations", n: 1 },
    ];
    const html = render(<WaitingWhat groups={groups} />);
    expect(html).toContain('aria-label="What is waiting"');
    expect(html.match(/<li>/g)).toHaveLength(1);
    expect(html).toContain("<li>840 notes to organise in Game Notes V2 (03 Animation, 04 Gameplay…)</li>");
    expect(html).toContain('<p class="cx-note">The other 25: 22 notes in Vault, docs and Animations, 1 chat, 1 chat summary and 1 area map.</p>');
  });

  it("shows nothing when nothing waits", () => {
    expect(render(<WaitingWhat groups={[]} />)).toBe("");
  });
});
