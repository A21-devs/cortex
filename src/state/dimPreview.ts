/**
 * The colour modes the figure is drawn with while a dimension is pointed at in the key's menu (FIG-36): the hovered
 * dimension stands in for the committed one on the population whose picker is open ("both" = the shared row), and the
 * Spine follows the Brain when the two share their colours. Pure; the render controller calls it on every recolour.
 */
import type { DimId } from "../shared/dims";
import type { ColourMode } from "../shared/protocol/worker";

export function previewColour(colour: { notes: ColourMode; record: ColourMode; same: boolean }, dim: DimId | null, pop: "notes" | "record" | "both"): { notes: ColourMode; record: ColourMode } {
  if (dim === null) return { notes: colour.notes, record: colour.same ? colour.notes : colour.record };
  const hovered: ColourMode = { kind: "categorical", dim };
  const notes = pop !== "record" ? hovered : colour.notes;
  const record = colour.same ? notes : pop !== "notes" ? hovered : colour.record;
  return { notes, record };
}
