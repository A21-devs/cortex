/**
 * Model engine abstraction. Owner: E5.
 * Engines turn (system, prompt, schema) into JSON data plus usage. They never execute anything the model
 * says: output is parsed, validated by the caller, and only then turned into ledger records by Cortex code.
 *
 * Jobs never see a raw engine: the scheduler hands them a GuardedEngine (agents/scheduler.ts) that re-reads the
 * kill switches before every call, reserves and settles the daily budget, enforces the pass deadline and the
 * per-invocation token ceiling, requires the call's ReadRecord to be logged first, and turns failures into
 * engine states (M1). This file holds the shared shapes and the pure helpers those layers use.
 */
import type { EngineState, RunnerErrorCode } from "../shared/protocol/runner";
import type { EngineKind, JobKind, RunId } from "../shared/types";
import { mergePlan, type PlanWindows } from "../shared/planLimits";
import type { JsonSchema } from "../shared/validate";

export interface EngineRequest {
  runId: RunId;
  job: JobKind;
  /** Alias ("haiku", "sonnet", "opus", "fable") or a full model id. */
  model: string;
  system: string;
  /** User prompt; sent on stdin (never on the command line). */
  prompt: string;
  schema: JsonSchema;
  timeoutMs: number;
  /** Per-call dollar ceiling passed to the engine when supported. */
  maxUsd?: number;
  /** Always explicit (never inherited from a parent session's CLAUDE_EFFORT). */
  effort: "low" | "medium" | "high";
  signal: AbortSignal;
  /** Expected output size for the budget reservation; defaults to EXPECTED_OUTPUT_TOKENS[job]. */
  expectedOutputTokens?: number;
}

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** True when the engine reported no usage and numbers are estimates. */
  estimated: boolean;
  /** Model ids that actually served the call. */
  models: string[];
  /** The plan's 5-hour and weekly utilization the call reported (Claude Code's rate-limit events), when it reported any. */
  plan?: PlanWindows;
}

export interface EngineError {
  code: RunnerErrorCode;
  /** Fixed, Cortex-written text (never model output or CLI text). */
  message: string;
  retryable: boolean;
  /** E_ENGINE_LIMIT: when work may resume (ISO). */
  resumeAt?: string;
  /** The engine state this failure puts the engine in (M1), when it is not a per-call problem. */
  state?: EngineState;
  /** A CLI flag the engine rejected (cli-flag-rejected warning). */
  flag?: string;
  /** Why a guard refused the call before it ran (paused, privacy-changed, daily, invocation, deadline, read-not-logged …). */
  reason?: string;
}

export type EngineResult =
  | { ok: true; output: unknown; rawText: string; usage: EngineUsage; durationMs: number; modelUsed: string }
  | {
      ok: false;
      error: EngineError;
      usage?: EngineUsage;
      rawText?: string;
      durationMs: number;
      /** False when nothing was sent (the process never started or a guard refused): no tokens were spent. */
      started?: boolean;
    };

export interface EngineProbe {
  ok: boolean;
  version?: string;
  flags: Record<string, boolean>;
  /** Isolation flags the CLI does not advertise: agents stay off while non-empty. */
  missingMandatory: string[];
  detail: string;
}

export interface Engine {
  readonly kind: EngineKind;
  readonly where: "remote" | "this computer";
  readonly paidBy: "plan" | "api" | "none";
  run(req: EngineRequest): Promise<EngineResult>;
  /** Free check (version/help only; never sends a prompt). */
  probe(): Promise<EngineProbe>;
}

export function zeroUsage(estimated = true): EngineUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimated, models: [] };
}

/** Sum two usages (models de-duplicated, estimated if either was). */
export function addUsage(a: EngineUsage, b: EngineUsage): EngineUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
    estimated: a.estimated || b.estimated,
    models: [...new Set([...a.models, ...b.models])],
    ...(a.plan || b.plan ? { plan: mergePlan(a.plan, b.plan) } : {}),
  };
}

/** Tokens a call is charged: input + output + cache reads + cache writes. */
export function usageTokens(u: EngineUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

/** Output size reserved per call before the real usage is known (BUDGET-RESERVE). */
export const EXPECTED_OUTPUT_TOKENS: Readonly<Record<JobKind, number>> = {
  label: 600,
  gist: 2_500,
  hub: 1_500,
  filing: 800,
  "name-check": 600,
  answer: 1_200,
  directions: 600,
};

/**
 * The engine state a failure moves the engine into (M1, CORTEX-UX §5.31), or undefined for a per-call failure
 * that leaves the engine healthy (a bad answer, a per-call ceiling, a cancel).
 */
export function engineStateForError(e: Pick<EngineError, "code" | "state">): EngineState | undefined {
  if (e.state !== undefined) return e.state;
  switch (e.code) {
    case "E_ENGINE_AUTH":
      return "auth";
    case "E_ENGINE_MISSING":
      return "missing";
    case "E_ENGINE_LIMIT":
      return "limit";
    default:
      return undefined;
  }
}

/** States in which no model call is attempted until a check clears them. */
export function engineBlocked(state: EngineState): boolean {
  return state !== "ok";
}
