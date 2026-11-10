/**
 * Hosts this leaf's WebGL canvas and its overlay layers (label chips, chart overlay, chart readings, tooltip);
 * attaches the leaf's RenderController (E10) on mount and detaches it on unmount. Owner: E11 (component) with
 * E10 (controller behind it). A pre-rendered silhouette (render/silhouette.ts) shows within 50 ms of opening.
 */
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { createRenderController } from "../../render/controller";
import { domIds, useLeaf, useServices } from "../context";
import { t } from "../copy";
import { ChartOverlay } from "./ChartOverlay";
import { GroupOverlay } from "./GroupOverlay";
import { HubCard } from "./HubCard";
import { LabelLayer } from "./LabelLayer";
import { Readings } from "./Readings";
import { Tooltip } from "./Tooltip";

export function CanvasHost(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return undefined;
    const ctl = createRenderController(s, leaf);
    // Inspection handle for live checks (framing, stats) from the developer console; nothing in Cortex reads it.
    (canvas as HTMLCanvasElement & { cortexController?: unknown }).cortexController = ctl;
    ctl.attach(canvas, overlay).catch((e: unknown) => s.log.warn("renderer unavailable", { error: String(e) }));
    const stop = s.bus.on("command", (ev) => {
      if (ev.viewId !== leaf.viewId || ev.id !== "save-image") return;
      void ctl
        .savePicture()
        .then((png) => (png ? s.save({ suggestedName: "cortex.png", mime: "image/png", data: png }) : null))
        .catch((e: unknown) => s.log.warn("save image failed", { error: String(e) }));
    });
    return () => {
      stop();
      ctl.detach();
    };
  }, [s, leaf]);
  return (
    <div class="cx-canvas-host">
      <canvas ref={canvasRef} class="cx-canvas" data-cursor="grab" aria-describedby={domIds(leaf.viewId).summary} aria-label={t("app.name")} />
      <div ref={overlayRef} class="cx-overlay">
        <LabelLayer />
        <ChartOverlay />
        <GroupOverlay />
        <Readings />
        <Tooltip />
        <HubCard />
      </div>
    </div>
  );
}
