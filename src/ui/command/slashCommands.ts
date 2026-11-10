/**
 * Ask's slash commands (ORIG-08): Cortex's own action verbs, each inserting a template into the command line.
 * Owner: E6. They map onto the action registry (shared/actions.ts); the model still returns validated actions.
 */
import type { OnlyVerb } from "../../shared/actions";

export interface SlashCommand {
  name: string;
  key: "slash.trace" | "slash.chart" | "slash.arrange" | "slash.period" | "slash.correct" | "slash.merge" | "slash.leaveOut" | "slash.refresh" | "slash.notMine";
  insert: "slash.traceInsert" | "slash.chartInsert" | "slash.arrangeInsert" | "slash.periodInsert" | "slash.correctInsert" | "slash.mergeInsert" | "slash.leaveOutInsert" | "slash.refreshInsert" | "slash.notMineInsert";
  /** Sent to the runner as onlyVerb: the model may return only these actions. */
  verbs: OnlyVerb;
  /** A one-step command: choosing it (or Enter on it) acts at once on the selection and asks no model (P21 /not-mine). */
  direct?: "not-mine";
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "trace", key: "slash.trace", insert: "slash.traceInsert", verbs: "trace" },
  { name: "chart", key: "slash.chart", insert: "slash.chartInsert", verbs: "make_chart" },
  { name: "arrange", key: "slash.arrange", insert: "slash.arrangeInsert", verbs: "arrange" },
  { name: "period", key: "slash.period", insert: "slash.periodInsert", verbs: "set_period" },
  { name: "correct", key: "slash.correct", insert: "slash.correctInsert", verbs: ["correct_entry", "set_date", "set_speaker"] },
  { name: "merge", key: "slash.merge", insert: "slash.mergeInsert", verbs: "merge_groups" },
  { name: "leave-out", key: "slash.leaveOut", insert: "slash.leaveOutInsert", verbs: "exclude" },
  { name: "refresh", key: "slash.refresh", insert: "slash.refreshInsert", verbs: "refresh" },
  { name: "not-mine", key: "slash.notMine", insert: "slash.notMineInsert", verbs: "set_speaker", direct: "not-mine" },
];

/** Parse "/name rest" → the command and its argument text (null when the input is not a slash command). */
export function parseSlash(input: string): { command: SlashCommand; rest: string } | null {
  const m = /^\/([a-z-]+)\s*(.*)$/s.exec(input.trim());
  if (!m) return null;
  const command = SLASH_COMMANDS.find((c) => c.name === m[1]);
  return command ? { command, rest: (m[2] ?? "").trim() } : null;
}
