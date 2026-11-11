/**
 * The first-paint cloud as a three.js layer: one Points object whose positions the renderer rewrites each frame
 * while the cloud holds, turns and condenses (render/firstPaint.ts has the timeline). Sprites are soft round dots
 * with a per-point size and brightness; the blending follows the stage (additive on Ink, premultiplied over on Paper).
 */
import { BufferAttribute, BufferGeometry, GLSL3, Points, RawShaderMaterial, type IUniform } from "three";
import type { Cloud } from "../firstPaint";
import { RENDER_TUNING } from "../tuning";
import { SRGB_TO_LINEAR, setPointBlending } from "./points";

const T = RENDER_TUNING.firstPaint;

const VERT = /* glsl */ `precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uDpr;
uniform float uCalm;
in vec3 position;
in vec3 aColor;
in vec3 aSizeAlpha;
out vec3 vColor;
out float vAlpha;
void main() {
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
  // Condensing calms the comets: they shrink and dim into the figure instead of arriving as bright clumps.
  gl_PointSize = max(1.0, aSizeAlpha.x * uDpr * (1.0 - 0.45 * aSizeAlpha.z * uCalm));
  vColor = aColor;
  vAlpha = aSizeAlpha.y * (1.0 - 0.8 * aSizeAlpha.z * uCalm);
}
`;

const FRAG = /* glsl */ `precision highp float;
uniform float uAlpha;
uniform float uWriteScale;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.35, 1.0, d)) * vAlpha * uAlpha;
  if (a < 0.004) discard;
  outColor = vec4(vColor * a * 1.5 * uWriteScale, a * uWriteScale);
}
`;

export interface FirstPaintLayer {
  readonly object: Points;
  readonly material: RawShaderMaterial;
  /** World positions the renderer writes each frame (x, y, z per point). */
  readonly positions: Float32Array;
  readonly count: number;
  /** Colour the points from palette colours (sRGB, 0..1 as palette.bucketColor gives them) per slot; comets use the first. */
  setColours(rgb: readonly (readonly [number, number, number])[]): void;
  /** Mark the positions as rewritten. */
  touch(): void;
  setAlpha(a: number): void;
  /** 0..1: how far the points have condensed (comets calm down). */
  setCalm(c: number): void;
  setPaper(paper: boolean): void;
  setDpr(d: number): void;
  dispose(): void;
}

export function createFirstPaintLayer(cloud: Cloud): FirstPaintLayer {
  const n = cloud.count;
  const geom = new BufferGeometry();
  const positions = new Float32Array(n * 3);
  const colour = new Float32Array(n * 3);
  const sizeAlpha = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const comet = cloud.comet[i] === 1;
    const b = cloud.bright[i] as number;
    sizeAlpha[i * 3] = comet ? T.cometSizePx * (0.7 + 0.6 * b) : T.sizePx * (0.8 + 0.5 * b);
    sizeAlpha[i * 3 + 1] = (comet ? T.cometAlpha : T.alpha) * (0.45 + 0.55 * b);
    sizeAlpha[i * 3 + 2] = comet ? 1 : 0;
  }
  const pos = new BufferAttribute(positions, 3);
  geom.setAttribute("position", pos);
  geom.setAttribute("aColor", new BufferAttribute(colour, 3));
  geom.setAttribute("aSizeAlpha", new BufferAttribute(sizeAlpha, 3));
  geom.setDrawRange(0, n);
  const uniforms: Record<string, IUniform> = { uDpr: { value: 1 }, uAlpha: { value: 0 }, uCalm: { value: 0 }, uWriteScale: { value: 1 } };
  const material = new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, uniforms });
  setPointBlending(material, false);
  const object = new Points(geom, material);
  object.frustumCulled = false;
  object.renderOrder = 8;
  object.visible = false;
  const layer: FirstPaintLayer = {
    object,
    material,
    positions,
    count: n,
    setColours(rgb) {
      if (rgb.length === 0) return;
      const attr = geom.getAttribute("aColor") as BufferAttribute;
      for (let i = 0; i < n; i++) {
        const which = cloud.comet[i] === 1 ? 0 : (cloud.slot[i] as number);
        const c = rgb[which % rgb.length] as readonly [number, number, number];
        // Comets run toward white near their origin; body points keep their palette colour.
        const white = cloud.comet[i] === 1 ? 0.45 * (cloud.bright[i] as number) : 0.04;
        for (let k = 0; k < 3; k++) {
          const lin = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round((c[k] as number) * 255)))] as number;
          colour[i * 3 + k] = lin + (1 - lin) * white;
        }
      }
      attr.needsUpdate = true;
    },
    touch() {
      pos.needsUpdate = true;
    },
    setAlpha(a) {
      (uniforms.uAlpha as IUniform).value = a;
      object.visible = a > 0.002;
    },
    setCalm(c) {
      (uniforms.uCalm as IUniform).value = c;
    },
    setPaper(paper) {
      setPointBlending(material, paper);
    },
    setDpr(d) {
      (uniforms.uDpr as IUniform).value = d;
    },
    dispose() {
      geom.dispose();
      material.dispose();
    },
  };
  return layer;
}
