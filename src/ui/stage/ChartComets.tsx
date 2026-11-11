/**
 * The treemap's comet streaks (CHART-20): a canvas in the chart layer, beside the overlay's. It runs on the chart
 * feed's camera frames, so it moves only while a treemap is on the stage and visible, and it draws nothing under
 * reduced motion. The streaks live in screen space; a camera change re-fits the boxes and keeps them moving.
 */
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { projectMarks, type ChartFeed, type ChartFeedValue } from "./ChartOverlay";
import { boxesFromMarks, drawComets, makeComets, refitComets, rng, stepComet, type CometBox, type Comet, type CometInk } from "./comets";

export interface CometProps {
  feed: ChartFeed;
  value: ChartFeedValue | null;
  win: Window;
  /** The chart is a treemap, is visible and motion is allowed. */
  active: boolean;
}

export function ChartComets(p: CometProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { feed, value, win, active } = p;
  useEffect(() => {
    const canvas = canvasRef.current;
    const clear = () => {
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
    if (!canvas || !active || !value) {
      clear();
      return undefined;
    }
    let boxes: CometBox[] = [];
    let comets: Comet[] = [];
    let planned = false;
    let ink: CometInk = { head: "#ffffff", tail: "232, 84, 60" };
    let last = win.performance?.now() ?? Date.now();
    const rand = rng(value.seq + 7);
    const off = feed.onFrame((f) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const now = win.performance?.now() ?? Date.now();
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const dpr = win.devicePixelRatio || 1;
      const w = Math.round(f.width * dpr);
      const h = Math.round(f.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      if (f.changed || !planned) {
        const next = boxesFromMarks(projectMarks(value.result.overlay, f.camera, f.width, f.height));
        comets = (planned ? refitComets(comets, boxes, next) : null) ?? makeComets(next, value.seq + 1);
        boxes = next;
        planned = true;
        const head = win.getComputedStyle(canvas).getPropertyValue("--cx-stage-text-1").trim();
        ink = { head: head || ink.head, tail: ink.tail };
      }
      comets = comets.map((c) => (boxes[c.box] ? stepComet(c, boxes[c.box]!, dt, rand) : c));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, f.width, f.height);
      drawComets(ctx, comets, boxes, ink);
    });
    return () => {
      off();
      clear();
    };
  }, [feed, value, win, active]);
  return <canvas ref={canvasRef} class="cx-chart-overlay cx-chart-comets" aria-hidden="true" />;
}
