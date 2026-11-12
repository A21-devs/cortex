/**
 * The chart panel's question line and one-line answer (TB-18): the pure builders live in shared/chartAnswers.ts, this
 * renders them through the copy table with the display names the rest of the UI uses.
 */
import { buildAnswer, type AnswerInput, type AnswerLine, type ChartAnswer } from "../../shared/chartAnswers";
import { t, type CopyKey } from "../copy";
import { dimLabel, fmtDayRange } from "../valueLabels";
import { categoryName, renamesOf, spanText, type ChartFeedValue } from "./ChartOverlay";

export interface AnswerText {
  question: string;
  /** Null when the chart has nothing placed to read. */
  answer: string | null;
}

export function answerLineText(l: AnswerLine): string {
  return t(l.key as CopyKey, l.values);
}

/** The builder's input from a chart result and the spec it was computed for. */
export function answerInputOf(v: ChartFeedValue): AnswerInput {
  const names = renamesOf(v.spec.options);
  return {
    chart: v.spec.chart,
    x: v.spec.x.dim,
    y: v.spec.y?.dim ?? null,
    colour: v.spec.colour,
    options: v.spec.options,
    categories: v.result.categories ?? [],
    marks: v.result.overlay.marks.map((m) => ({ label: m.label, count: m.count, key: m.key })),
    placed: v.placed,
    name: (dim, key, fallback) => categoryName(dim, key, fallback, names),
    dimName: (dim) => dimLabel(dim).toLowerCase(),
    period: (from, to) => fmtDayRange(from, Math.max(from, to - 1)),
    span: spanText,
  };
}

/** Question and answer sentence for the chart on screen; recomputed whenever its result changes. */
export function answerTextOf(v: ChartFeedValue): AnswerText {
  const a: ChartAnswer = buildAnswer(answerInputOf(v));
  return { question: answerLineText(a.question), answer: a.answer ? answerLineText(a.answer) : null };
}
