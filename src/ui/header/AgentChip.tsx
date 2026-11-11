/**
 * Agent chip (CORTEX-UX §5.1, §5.11, §5.31; M1): the glyph (rotating 360° per 2.4 s while agents run; "…" under
 * reduced motion) + state word: Organising · ‹n› jobs, Up to date (shown 4 s after the queue empties, then the
 * glyph alone), Paused, Cap reached, Sign-in needed, Claude Code not found, Engine offline, Usage limit reached,
 * Agents off (after "Import only", or when the probe refused the CLI). Hidden before the first-run step.
 * Click → Agents. Tooltip "‹used› of ‹cap› tokens used today · ‹n› conversations waiting". At M the chip is the
 * glyph alone with the state in its name. No mascot. Owner: E11.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { openTab } from "../../state/actions";
import { agentChipState, type AgentChipState } from "../../state/selectors";
import type { ActivityState } from "../../state/types";
import { isReducedMotion, num, useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { planTip } from "../planText";
import { SHELL } from "../breakpoints";
import { Glyph } from "../primitives/buttons";

/** The chip's state: the engine and queue state, "off" when agents are switched off in settings. */
export type ChipState = AgentChipState | "off";

export function chipState(a: ActivityState, agentsEnabled: boolean): ChipState {
  const s = agentChipState(a);
  if (s === "idle" || s === "organising") return agentsEnabled ? s : "off";
  return s;
}

/** Number of agent jobs (imports and index builds are not agent work). */
export function agentJobs(a: ActivityState): number {
  return a.jobs.filter((j) => j.kind !== "import" && j.kind !== "index").length;
}

export function chipText(state: ChipState, jobs: number): string | null {
  switch (state) {
    case "organising":
      return t("agentChip.organising", { n: jobs });
    case "paused":
      return t("agentChip.paused");
    case "capped":
      return t("agentChip.capped");
    case "offline":
      return t("agentChip.offline");
    case "sign-in":
      return t("agentChip.signIn");
    case "missing":
      return t("agentChip.missing");
    case "limit":
      return t("agentChip.limit");
    case "unsafe":
      return t("agentChip.unsafe");
    case "off":
      return t("agentChip.off");
    case "up-to-date":
      return t("agentChip.upToDate");
    default:
      return null;
  }
}

/** Tone of the chip and the Agents tab dot: running, held (paused, capped, limit), trouble (engine). */
export function chipTone(state: ChipState): "running" | "held" | "trouble" | null {
  if (state === "organising") return "running";
  if (state === "paused" || state === "capped" || state === "limit") return "held";
  if (state === "offline" || state === "sign-in" || state === "missing" || state === "unsafe") return "trouble";
  return null;
}

/** Track "Up to date": true for 4 s after the chip leaves Organising for idle. */
export function useUpToDate(state: ChipState, ms: number = SHELL.timing.upToDateMs): boolean {
  const prev = useRef<ChipState>(state);
  const [until, setUntil] = useState(0);
  const shell = useShell();
  useEffect(() => {
    const was = prev.current;
    prev.current = state;
    if (was === "organising" && state === "idle") {
      const end = shell.now() + ms;
      setUntil(end);
      const h = shell.win.setTimeout(() => setUntil(0), ms);
      return () => shell.win.clearTimeout(h);
    }
    if (state !== "idle") setUntil(0);
    return undefined;
  }, [state]);
  return until > 0 && state === "idle";
}

export function AgentChip(p: { iconOnly?: boolean }): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const settings = s.settings.value;
  const a = s.shared.slices.activity.value;
  const queues = s.shared.slices.queues.value;
  const base = chipState(a, settings.agents.enabled);
  const fresh = useUpToDate(base);
  if (!settings.general.firstRunDone) return null;
  const state: ChipState = fresh ? "up-to-date" : base;
  const jobs = agentJobs(a);
  const text = chipText(state, jobs);
  const reduced = isReducedMotion(settings.appearance.motion, shell.systemReducedMotion.value);
  const running = state === "organising";
  const tip = t("agentChip.tip", { used: num(a.tokensToday), plan: planTip(a.plan), n: num(queues.label) });
  const tone = chipTone(state);
  return (
    <button
      type="button"
      class={`cx-agent-chip is-${state}${tone ? ` tone-${tone}` : ""}${p.iconOnly || !text ? " is-glyph-only" : ""}`}
      title={p.iconOnly && text ? `${text} · ${tip}` : tip}
      aria-label={text ? `${t("pages.agents")}: ${text}` : t("pages.agents")}
      onClick={() => openTab(leaf.store, "agents")}
    >
      {running && reduced ? <span class="cx-agent-dots" aria-hidden="true">{t("agentChip.reduced")}</span> : <Glyph size={15} spinning={running && !reduced} />}
      {text && !p.iconOnly ? <span class="cx-agent-text">{text}</span> : null}
    </button>
  );
}
