/**
 * GLSL 3.00 sources (RawShaderMaterial, glslVersion GLSL3) and the bit layouts they read. Owner: E10.
 * Cortex's own shaders; every number they use arrives as a uniform from RENDER_TUNING (render/tuning.ts).
 *
 * Pipeline (CORTEX-UX §6.5): points, haze, rings and lines draw into an RGBA16F target — additive and
 * PREMULTIPLIED (blend ONE, ONE; PREMULTIPLIED-BLEND) on the Ink stage, premultiplied "over" (ONE,
 * ONE_MINUS_SRC_ALPHA) at 70% alpha without halos on the Paper stage. Colours are converted to linear light in
 * the vertex shader. The composite pass tone-maps out = 1 − exp(−1.35 × Brightness × hdr) per channel and
 * screens it over the stage background (radial lift + vignette) in linear light, then encodes sRGB; Paper
 * composites "over" the background without tone mapping.
 *
 * Per-point attributes (layers/points.ts):
 *   aAnat vec3 · aCentre vec3 · aArr vec3 · aArrPrev vec3 · aColor vec4 (u8 norm, sRGB) · aColorPrev vec4
 *   aMisc vec4 (seed, size, birth, intensity) · aState uvec2 (state bits now, before the last change) · aGeo uint
 * Hover, selection and the active note are uniforms (ordinal = gl_VertexID), so hovering never re-uploads.
 */
import { HUMAN_CUMULATIVE } from "./animation";
import { RENDER_TUNING } from "./tuning";

/** Per-point state bits written by the controller (aState.x = now, aState.y = before the last change). */
export const POINT_STATE = {
  /** Shown: layers, held arrivals and "hide items without a value" allow it. */
  Visible: 1,
  /** In the highlighted set: traced matches, the selection and its related items, a preview's matches. */
  Lit: 2,
  /** Member of a selected group (a conversation, a key chip, a band): × 1.4. */
  Member: 4,
  /** Hidden by the key: a 6% ghost that keeps the shape. */
  HiddenByKey: 8,
  /** Outside the leaf's period: 6% in Body (Groups and Chart drop them through a missing target). */
  OutsidePeriod: 16,
  /** Outside the scope: sinks 25% toward the core and fades to 0. */
  OutsideScope: 32,
  /** A hovered map's sources: +60% brightness, colour 50% toward the map's territory colour. */
  MapSource: 64,
  /** Member of a thin group (under 30) in Groups and Chart: drawn at 50% on its shell. */
  Thin: 128,
} as const;

/** Geometry bits owned by the renderer (aGeo): validity of the positions and the draw kind (bits 4–7). */
export const GEO_BITS = { Placed: 1, HasArr: 2, HasArrPrev: 4, KindShift: 4 } as const;

/** Draw kinds (sprite profile, intensity rules, depth cue). */
export const POINT_KIND = { Frond: 0, Cord: 1, Note: 2, Map: 3, Undated: 4 } as const;
export type PointKind = (typeof POINT_KIND)[keyof typeof POINT_KIND];

/** CORTEX-UX §6.6 multipliers (H4, §12.6). */
export const STATE_ALPHA = RENDER_TUNING.stateAlpha;

export const SCOPE_TIMING = {
  turnMs: RENDER_TUNING.scope.turnMs,
  sinkFadeMs: RENDER_TUNING.scope.sinkFadeMs,
  riseMs: RENDER_TUNING.scope.riseMs,
  refitBelow: RENDER_TUNING.scope.refitBelow,
} as const;

/** Sprite profiles per draw kind as vec4(σc, σh, core peak, halo peak) — the order of POINT_KIND. */
export function kindProfiles(): number[] {
  const S = RENDER_TUNING.sprites;
  const p = (s: { sigmaCore: number; sigmaHalo: number; corePeak: number; haloPeak: number }) => [s.sigmaCore, s.sigmaHalo, s.corePeak, s.haloPeak];
  return [...p(S.record), ...p(S.record), ...p(S.note), ...p(S.map), ...p(S.record)];
}

/** Number of cord-axis samples the shaders interpolate (sink toward the cord, the frond unfurl pivot). */
export const CORD_SAMPLES = 32;

/** Haze kinds the haze shader can index (the protocol lists at most this many). */
export const HAZE_SLOTS = 12;


/** Palette colours the hover trail cycles through (RENDER_TUNING.hover.streakSlots). */
export const STREAK_TINTS = RENDER_TUNING.hover.streakSlots.length;

const glf = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/** GLSL of the humanoid transit pose, generated from RENDER_TUNING.transit; mirrors humanoidPoint in render/silhouette.ts. */
function humanoidGlsl(): string {
  const parts = RENDER_TUNING.transit.parts;
  const n = parts.length;
  return /* glsl */ `
const int HN = ${n};
const float HCUM[HN] = float[HN](${HUMAN_CUMULATIVE.map(glf).join(", ")});
const int HSHAPE[HN] = int[HN](${parts.map((q) => q.shape).join(", ")});
const vec4 HA[HN] = vec4[HN](${parts.map((q) => `vec4(${q.a.map(glf).join(", ")})`).join(", ")});
const float HWIDTH[HN] = float[HN](${parts.map((q) => glf(q.width)).join(", ")});
vec3 humanoid(uint id) {
  float part = hashUnit(id, 0u);
  float t = hashUnit(id, 1u);
  float u = hashUnit(id, 2u);
  float side = hashUnit(id, 3u) < 0.5 ? -1.0 : 1.0;
  float zz = (hashUnit(id, 4u) - 0.5) * 2.0 * ${glf(RENDER_TUNING.transit.depth)};
  int k = HN - 1;
  for (int i = 0; i < HN; i++) {
    if (part <= HCUM[i]) { k = i; break; }
  }
  vec4 a = HA[k];
  // One exit only: early returns inside branches make the Windows (D3D) shader compiler warn X4000.
  vec3 hp = vec3(0.0, 0.0, zz);
  if (HSHAPE[k] == 0) {
    float ang = t * 6.2831853;
    float r = a.z + (u - 0.5) * HWIDTH[k];
    hp = vec3(a.x + cos(ang) * r, a.y + sin(ang) * r, zz);
  } else if (HSHAPE[k] == 1) {
    hp = vec3(a.x + (a.z - a.x) * t, a.y + (a.w - a.y) * u, zz);
  } else {
    vec2 d = a.zw - a.xy;
    float len = max(length(d), 1e-5);
    float off = (u - 0.5) * HWIDTH[k];
    vec2 p = a.xy + d * t + vec2(-d.y, d.x) / len * off;
    hp = vec3(side * p.x, p.y, zz);
  }
  return hp;
}
`;
}
const HUMANOID_GLSL = humanoidGlsl();

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
const float PI = 3.14159265358979;
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
`;

/** Shared vertex logic of the data points: position (scatter, unfurl, scope sink, morph, form), state look. */
const POINT_CORE = /* glsl */ `
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uIntro;
uniform float uGrowing;
uniform float uUnfurlRad;
uniform float uUnfurlSec;
uniform float uMorph;
uniform float uForm;
uniform float uFormLift;
uniform float uCurlAmp;
uniform vec3 uUp;
uniform float uScatter;
uniform float uStateT;
uniform float uOthers;
uniform float uHiddenDim;
uniform float uPeriodDim;
uniform float uMemberBoost;
uniform float uMemberSize;
uniform float uSourceBoost;
uniform float uThin;
uniform float uScopeSink;
uniform float uScopeFlash;
uniform float uSwirl;
uniform float uSwirlAmp;
uniform float uFade;
uniform float uLodKeep;
uniform vec3 uLongAxis;
uniform vec3 uTip;
uniform vec2 uCordSpan;
uniform vec3 uCord[${CORD_SAMPLES}];
uniform vec4 uBrain;
uniform float uShimmer;
uniform float uShimmerJit;
uniform float uShimmerRate;
uniform float uDissolve;
uniform float uDissolveSplit;
uniform float uDissolveFade;
uniform float uDissolveShrink;
uniform float uDip;
uniform float uRegrow;
uniform float uRegrowSpan;
uniform float uRegrowSoft;
uniform float uDipFloor;
uniform float uHumanW;
uniform vec3 uHumX;
uniform vec3 uHumY;
uniform float uBrainScale;
uniform float uPending;
uniform float uExit;
uniform vec3 uExitAnchor;
uniform vec2 uExitLook;
uniform vec3 uEntry;
in vec3 aAnat;
in vec3 aCentre;
in vec3 aArr;
in vec3 aArrPrev;
in vec4 aColor;
in vec4 aColorPrev;
in vec4 aMisc;
in uvec2 aState;
in uint aGeo;

// PCG hash: the same integer maths as pcgHash / hashUnit in render/animation.ts (the tests pin the two together).
uint pcgHash(uint v) {
  uint st = v * 747796405u + 2891336453u;
  uint w = ((st >> ((st >> 28u) + 4u)) ^ st) * 277803737u;
  return (w >> 22u) ^ w;
}

float hashUnit(uint id, uint salt) {
  return float(pcgHash(id * 8u + salt)) / 4294967296.0;
}
${HUMANOID_GLSL}

vec3 curlField(vec3 p) {
  return vec3(sin(p.y * 1.7 + p.z), sin(p.z * 1.3 + p.x), sin(p.x * 1.9 + p.y));
}

vec3 cordAt(vec3 p) {
  float s = dot(p, uLongAxis);
  float span = uCordSpan.y - uCordSpan.x;
  float t = clamp((s - uCordSpan.x) / (abs(span) < 1e-5 ? 1.0 : span), 0.0, 1.0) * float(${CORD_SAMPLES - 1});
  int i = int(floor(t));
  int j = min(i + 1, ${CORD_SAMPLES - 1});
  vec3 c = mix(uCord[i], uCord[j], fract(t));
  return c + uLongAxis * (s - dot(c, uLongAxis));
}

vec3 rotateAbout(vec3 v, vec3 axis, float ang) {
  float c = cos(ang);
  float s = sin(ang);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

float bitOn(uint b, uint m) {
  return (b & m) != 0u ? 1.0 : 0.0;
}

// x = brightness factor, y = scope sink (0..1), z = map-source tint (0..1), w = thin group
vec4 stateLook(uint b) {
  float a = bitOn(b, 1u);
  a *= mix(uOthers, 1.0, bitOn(b, 2u));
  a *= mix(1.0, uMemberBoost, bitOn(b, 4u));
  a *= mix(1.0, uHiddenDim, bitOn(b, 8u));
  a *= mix(1.0, uPeriodDim, bitOn(b, 16u));
  float scope = bitOn(b, 32u);
  a *= 1.0 - scope;
  float src = bitOn(b, 64u);
  a *= mix(1.0, uSourceBoost, src);
  return vec4(a, scope, src, bitOn(b, 128u));
}

struct PointOut {
  vec3 p;
  vec4 look;
  float e;
  float presence;
  int kind;
  bool live;
  float fsize;
};

PointOut pointPosition() {
  PointOut o;
  uint geo = aGeo;
  o.kind = int((geo >> 4u) & 15u);
  o.live = (geo & 1u) != 0u;
  bool hasArr = (geo & 2u) != 0u;
  bool hasPrev = (geo & 4u) != 0u;
  float seed = aMisc.x;
  o.look = mix(stateLook(aState.y), stateLook(aState.x), uStateT);
  if (o.kind == 0 && seed > uLodKeep) o.live = false;
  uint id = uint(gl_VertexID);
  vec3 body = aCentre + (aAnat - aCentre) * uScatter;
  // Spread contracts the whole body: the cerebrum (notes and maps) scales about its centre.
  if (o.kind == 2 || o.kind == 3) body = uBrain.xyz + (body - uBrain.xyz) * uBrainScale;
  float age = uIntro - aMisc.z;
  if (o.kind == 0 && uGrowing > 0.5) {
    float u = 1.0 - smoothstep(0.0, uUnfurlSec, age);
    if (u > 0.0) {
      // A nerve is born lying along the cord and swings out and down to its course: the offset from the cord is
      // tilted toward the tip (uTip, the way time runs along the cord) about the axis across both.
      vec3 pivot = cordAt(body);
      vec3 off = body - pivot;
      vec3 ax = cross(off, uTip);
      if (dot(ax, ax) > 1e-10) body = pivot + rotateAbout(off, normalize(ax), uUnfurlRad * u);
    }
  }
  vec3 sinkTo = (o.kind == 2 || o.kind == 3) ? uBrain.xyz : cordAt(body);
  body = mix(body, sinkTo, uScopeSink * o.look.y);
  float m = clamp((uMorph - 0.25 * seed) / 0.75, 0.0, 1.0);
  o.e = m * m * (3.0 - 2.0 * m);
  float f = clamp((uForm - 0.2 * seed) / 0.8, 0.0, 1.0);
  float ef = f * f * (3.0 - 2.0 * f);
  vec3 tgt = body;
  if (hasArr && hasPrev) {
    tgt = mix(aArrPrev, aArr, ef) + uUp * (uFormLift * sin(PI * ef));
    // Per-chart entry style (a form morph): uEntry = (style, amplitude, curl share). 1 smear along X, 2 diagonal burst, 3 rise.
    float bump = sin(PI * ef);
    float hr = hashUnit(id, 6u) - 0.5;
    if (uEntry.x > 0.5 && uEntry.x < 1.5) tgt += vec3(1.0, 0.0, 0.0) * (uEntry.y * bump * 2.0 * hr);
    else if (uEntry.x < 2.5 && uEntry.x > 1.5) tgt += (vec3(1.0, 0.0, 0.0) + uUp) * (uEntry.y * bump * (0.35 + hashUnit(id, 7u)));
    else if (uEntry.x > 2.5) tgt += uUp * (uEntry.y * (1.0 - ef) * (0.4 + hashUnit(id, 7u))) - uUp * (uEntry.y * 0.5 * (1.0 - ef));
  } else if (hasArr) tgt = aArr;
  else if (hasPrev) tgt = aArrPrev;
  o.presence = mix(hasPrev ? 1.0 : 0.0, hasArr ? 1.0 : 0.0, ef);
  // A flat chart closing: its layout shrinks toward a small rectangle at the top (uExitAnchor) while it fades.
  if (uExit > 0.0 && (hasArr || hasPrev)) tgt = uExitAnchor + (tgt - uExitAnchor) * (1.0 - uExit * (1.0 - uExitLook.x));
  float moving = (hasArr || hasPrev) ? 1.0 : 0.0;
  o.p = mix(body, tgt, o.e) + uCurlAmp * moving * sin(PI * o.e) * curlField(body * 0.8 + 0.15 * uTime);
  if (uSwirl > 0.0 && uSwirl < 1.0) o.p += uSwirlAmp * sin(PI * uSwirl) * curlField(body * 1.3 + 0.9 * uTime);
  o.presence = mix(1.0, o.presence, o.e);
  // Transit silhouette: part-way through a morph the moving points are drawn toward a humanoid pose.
  if (uHumanW > 0.0 && moving > 0.5) {
    vec3 hp = humanoid(id);
    float sw = sin(PI * o.e);
    o.p = mix(o.p, uHumX * hp.x + uHumY * hp.y + vec3(0.0, 0.0, hp.z), uHumanW * sw * sw);
  }
  // A click is waiting for the worker's arrangement: the points already dissolve toward the silhouette.
  if (uPending > 0.0) {
    vec3 hp2 = humanoid(id);
    o.p = mix(o.p, uHumX * hp2.x + uHumY * hp2.y + vec3(0.0, 0.0, hp2.z), uPending);
  }
  // Shimmer: a tiny per-point jitter (the alpha twinkle is in the points vertex shader).
  if (uShimmer > 0.0) {
    float t = uTime * uShimmerRate;
    float hs = hashUnit(id, 1u) * 6.2831853;
    o.p += (uShimmer * uShimmerJit) * vec3(sin(t * 1.3 + hs), sin(t * 1.7 + hs * 2.0), sin(t * 1.1 + hs * 3.0));
  }
  // Effect alphas folded into presence (so a dissolved or dipped point is not hit-tested or ringed): a grouping-change
  // dissolve (the faded share out, the rest shrink) and the query dip and regrow.
  o.fsize = 1.0;
  if (uDissolve >= 0.0) {
    bool fades = hashUnit(id, 5u) < uDissolveFade;
    if (uDissolve < uDissolveSplit) {
      float k = uDissolve / uDissolveSplit;
      if (fades) o.presence *= 1.0 - k; else o.fsize = mix(1.0, uDissolveShrink, k);
    } else {
      float k = (uDissolve - uDissolveSplit) / (1.0 - uDissolveSplit);
      k = k * k * (3.0 - 2.0 * k);
      if (fades) o.presence *= k; else o.fsize = mix(uDissolveShrink, 1.0, k);
    }
  }
  float rv = 1.0;
  if (uRegrow >= 0.0 && aMisc.z <= uRegrowSpan) {
    float k = clamp((uRegrow * uRegrowSpan - aMisc.z) / uRegrowSoft, 0.0, 1.0);
    rv = uDipFloor + (1.0 - uDipFloor) * k * k * (3.0 - 2.0 * k);
  }
  o.presence *= uDip * rv * (1.0 - uExit * (1.0 - uExitLook.y));
  return o;
}
`;

/** Data points: CORTEX-UX §6.5 sprites with the §6.6 states, growth flashes, depth cue and beacons. */
export const POINTS_VERT = /* glsl */ `${COMMON}${POINT_CORE}
uniform float uDotSize;
uniform float uGlow;
uniform float uDpr;
uniform float uRefDist;
uniform float uDistPow;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uExtent;
uniform float uRecolourT;
uniform int uHover;
uniform int uSelected;
uniform float uFlashSec;
uniform float uFlashSize;
uniform float uHoverSize;
uniform float uSelectedSize;
uniform float uWhitePeak;
uniform float uMapBoost;
uniform float uMapWhite;
uniform float uSmallBrain;
uniform float uSmallRecord;
uniform float uWarm;
uniform vec3 uSourceTint;
uniform float uSourceTintMix;
uniform float uPaper;
uniform float uPaperAlpha;
uniform float uCoreScale;
uniform float uBrainZ;
uniform vec4 uFigure;
uniform float uFigureZ;
uniform float uRimBase;
uniform float uRimGain;
uniform float uInside;
uniform vec4 uProfile[5];
uniform float uShimmerAmp;
uniform float uCordBright;
uniform float uCordSize;
uniform vec4 uFibre;
uniform vec4 uSpeck;
uniform vec3 uHumanTint;
uniform float uHumanTintMix;
uniform float uHoverOn;
uniform int uHoverGroup;
uniform int uHoverPop;
uniform float uHoverDim;
uniform float uHoverBoost;
uniform float uHoverGrow;
uniform float uHoverGlow;
uniform float uHoverGlowPx;
uniform float uStreak;
uniform float uStreakPx;
in uint aGroup;
out vec4 vColor;
out vec4 vShape;
out float vDiam;
out vec4 vHot;

void main() {
  PointOut o = pointPosition();
  float age = uIntro - aMisc.z;
  if (!o.live || age < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec4(0.0);
    vShape = vec4(1.0);
    vDiam = 0.0;
    vHot = vec4(0.0);
    return;
  }
  vec4 mv = modelViewMatrix * vec4(o.p, 1.0);
  gl_Position = projectionMatrix * mv;
  int kind = o.kind;
  vec4 prof = uProfile[kind];
  bool hovered = gl_VertexID == uHover;
  bool selected = gl_VertexID == uSelected;
  float flash = 1.0 - clamp(age / uFlashSec, 0.0, 1.0);
  float white = max(max(flash, (hovered || selected) ? 1.0 : 0.0), uScopeFlash * (1.0 - bitOn(aState.x, 32u)));

  // colour: per-point recolour in linear light, maps a white spark faintly tinted by their area, a hovered map's sources toward its territory,
  // in flight toward warm white, flashes and hover white
  vec3 col = mix(toLinear(aColorPrev.rgb), toLinear(aColor.rgb), uRecolourT);
  float valueAlpha = mix(aColorPrev.a, aColor.a, uRecolourT);
  if (kind == 3) col = mix(col, vec3(1.0), uMapWhite);
  col = mix(col, uSourceTint, uSourceTintMix * o.look.z);
  col = mix(col, vec3(1.0, 0.93, 0.82), uWarm * sin(PI * o.e));
  float transit = sin(PI * o.e);
  col = mix(col, uHumanTint, uHumanTintMix * transit * transit * ((aGeo & 6u) != 0u ? 1.0 : 0.0));
  // Fibre look: a frond is a pale thin strand with a few colour specks; a selected or traced group keeps its full colour.
  float fibreSize = 1.0;
  float fibreInten = 1.0;
  if (kind == 0) {
    float emphasised = max(bitOn(aState.x, 4u), uOthers < 0.99 ? bitOn(aState.x, 2u) : 0.0);
    bool speck = hashUnit(uint(gl_VertexID), 9u) < uFibre.w;
    float keep = max(uFibre.x, emphasised);
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum) * vec3(0.92, 1.0, 1.1), col, speck ? 1.0 : keep);
    if (speck) {
      col = mix(col, vec3(1.0), uSpeck.z);
      fibreSize = uSpeck.x;
      fibreInten = uSpeck.y;
    } else {
      fibreSize = mix(uFibre.y, 1.0, emphasised);
      fibreInten = mix(uFibre.z, 1.0, emphasised);
    }
  }
  col = mix(col, vec3(1.0), white);

  // depth cue: brain points by their nearness within the brain, everything else over the whole figure
  float nf = clamp((mv.z - (uFigureZ - uFigure.w)) / (2.0 * uFigure.w), 0.0, 1.0);
  float cue = 0.55 + 0.45 * pow(nf, 0.8);
  float inten = aMisc.w;
  if (kind == 2) {
    float nb = clamp((mv.z - (uBrainZ - uBrain.w)) / (2.0 * uBrain.w), 0.0, 1.0);
    float brainCue = 0.16 + 0.84 * pow(nb, 1.6);
    vec3 nrm = normalize(mat3(modelViewMatrix) * (o.p - uBrain.xyz) + vec3(1e-6));
    float rim = 1.0 - abs(dot(nrm, normalize(-mv.xyz)));
    float r = length(o.p - uBrain.xyz) / max(1e-3, uBrain.w);
    float surf = mix(uInside, 1.0, smoothstep(0.55, 0.85, r));
    float brainInten = (uRimBase + uRimGain * rim * rim) * surf;
    cue = mix(brainCue, cue, o.e);
    inten *= mix(brainInten, 1.0, o.e);
  }
  if (kind == 3) inten *= uMapBoost;
  inten *= fibreInten;
  inten = mix(inten, max(inten, uWhitePeak / prof.z), white);

  float thin = mix(1.0, uThin, o.look.w * o.e);
  float state = o.look.x * o.presence * thin * uFade * valueAlpha;
  // Spread: the cord's points get brighter and thicker as the body contracts.
  if (kind == 1) inten *= uCordBright;
  // Shimmer: a per-point twinkle of the alpha, 1 + amp sin(rate t + phase).
  uint pid = uint(gl_VertexID);
  float twinkle = 1.0 + uShimmer * uShimmerAmp * sin(uTime * uShimmerRate + hashUnit(pid, 1u) * 6.2831853);
  // Hover emphasis (a chart row or label): the group is brighter, larger and glows with a short trail; the rest dim.
  uint gv = aGroup;
  float inGroup = (uHoverOn > 0.0 && gv != 0u && (gv & 0x7fffffffu) == uint(uHoverGroup) && (uHoverPop < 0 || (gv >> 31u) == uint(uHoverPop))) ? 1.0 : 0.0;
  float emph = uHoverOn * inGroup;
  float hoverK = mix(1.0, uHoverDim, uHoverOn * (1.0 - inGroup)) * mix(1.0, uHoverBoost, emph);
  state *= twinkle * hoverK;

  // size: Dot size × base size × (d0/d)^0.35 × state; σ in CSS px; the sprite holds 3σ of the halo
  float s = uDotSize * aMisc.y * pow(uRefDist / max(0.1, -mv.z), uDistPow);
  if (kind == 2) s *= uSmallBrain;
  if (kind == 0 || kind == 1) s *= uSmallRecord;
  if (kind == 1) s *= uCordSize * uSpeck.w;
  s *= fibreSize;
  s *= o.fsize * mix(1.0, uHoverGrow, emph);
  // Members of a selected group (a conversation) are drawn a little larger, so a short frond still reads as a bold line.
  s *= mix(1.0, uMemberSize, bitOn(aState.x, 4u) * bitOn(aState.x, 2u));
  float grow = 1.0 + (uFlashSize - 1.0) * flash;
  if (hovered) grow = max(grow, uHoverSize);
  if (selected) grow = max(grow, uSelectedSize);
  s *= grow;
  float sc = prof.x * s * mix(1.0, uCoreScale, uPaper);
  float sh = prof.y * s;
  float halo = prof.w * uGlow * (1.0 - uPaper);
  float radius = uExtent * (halo > 0.0 ? max(sc, sh) : sc);
  // A hovered group's glow and trail need room around the sprite.
  float streakLen = uStreakPx * uStreak * emph * (0.45 + 0.55 * hashUnit(pid, 6u));
  float glowSigma = uHoverGlowPx * emph;
  radius = max(radius, max(streakLen + 2.0, uExtent * glowSigma * 0.8));
  float diam = clamp(2.0 * radius, uMinPx, uMaxPx);
  gl_PointSize = diam * uDpr;
  vDiam = diam;
  vShape = vec4(max(sc, 1e-3), max(sh, 1e-3), mix(prof.z, 1.0, uPaper), halo);
  vHot = vec4(emph * uHoverGlow, max(glowSigma, 1e-3), streakLen, hashUnit(pid, 7u));
  float weight = uPaper > 0.5 ? clamp(state * cue, 0.0, 1.0) * uPaperAlpha : inten * cue * state;
  vColor = vec4(col, weight);
}
`;

export const POINTS_FRAG = /* glsl */ `${COMMON}
uniform float uWriteScale;
uniform float uPaper;
uniform vec2 uStreakDir;
uniform vec3 uStreakTint[${STREAK_TINTS}];
in vec4 vColor;
in vec4 vShape;
in float vDiam;
// x = glow peak of a hovered group, y = glow sigma (px), z = streak length (px), w = a per-point hue offset
in vec4 vHot;
out vec4 outColor;
vec3 streakHue(float f) {
  float x = fract(f) * float(${STREAK_TINTS});
  int i = int(floor(x));
  int j = (i + 1) % ${STREAK_TINTS};
  return mix(uStreakTint[i], uStreakTint[j], fract(x));
}
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r = length(q) * 2.0;
  if (r > 1.0) discard;
  vec2 d = q * vDiam;
  float d2 = dot(d, d);
  float g = vShape.z * exp(-d2 / (2.0 * vShape.x * vShape.x)) + vShape.w * exp(-d2 / (2.0 * vShape.y * vShape.y));
  // Hover glow: an additive halo around a hovered group's points.
  if (vHot.x > 0.0) g += vHot.x * exp(-d2 / (2.0 * vHot.y * vHot.y));
  float edge = 1.0 - smoothstep(0.82, 1.0, r);
  float a = vColor.a * g * edge;
  if (uPaper > 0.5) a = min(a, 1.0);
  vec3 rgb = vColor.rgb * a;
  float ta = 0.0;
  // Hover trail: a short streak behind the point along the row direction, tinted through the palette.
  if (vHot.z > 0.5) {
    float along = dot(d, uStreakDir);
    float across = length(d - along * uStreakDir);
    float tt = clamp(-along / vHot.z, 0.0, 1.0);
    float body = (along <= 0.0 ? 1.0 : exp(-along * along / 1.2)) * (1.0 - tt) * exp(-across * across / 0.9);
    ta = vColor.a * body * 0.9 * edge;
    if (vColor.a > 0.0) rgb += streakHue(vHot.w + tt * 0.5) * ta;
  }
  float aa = a + (vColor.a > 0.0 ? ta : 0.0);
  if (aa < 0.0004) discard;
  outColor = vec4(rgb * uWriteScale, min(aa, uPaper > 0.5 ? 1.0 : 1e4) * uWriteScale);
}
`;

/** Rings for the hovered, selected and active-note point: one vertex drawn at its ordinal (draw range). */
export const RING_VERT = /* glsl */ `${COMMON}${POINT_CORE}
uniform float uDpr;
uniform float uRingExtent;
out float vExtent;
void main() {
  PointOut o = pointPosition();
  if (!o.live || o.look.x * o.presence < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vExtent = 0.0;
    return;
  }
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(o.p, 1.0));
  gl_PointSize = 2.0 * uRingExtent * uDpr;
  vExtent = uRingExtent;
}
`;

export const RING_FRAG = /* glsl */ `${COMMON}
uniform vec3 uRingColor;
uniform vec3 uRingA;
uniform vec3 uRingB;
uniform float uRingGain;
uniform float uWriteScale;
uniform float uFade;
in float vExtent;
out vec4 outColor;
float band(float d, vec3 ring) {
  // ring = (radius, width, alpha) in CSS px
  if (ring.z <= 0.0) return 0.0;
  return ring.z * (1.0 - smoothstep(ring.y * 0.5 - 0.35, ring.y * 0.5 + 0.65, abs(d - ring.x)));
}
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0 * vExtent;
  float a = (band(d, uRingA) + band(d, uRingB)) * uFade;
  if (a < 0.002) discard;
  float w = a * uRingGain;
  outColor = vec4(uRingColor * w * uWriteScale, min(1.0, a) * uWriteScale);
}
`;

/** GPU picking: ordinal + 1 into an R32UI target (or RGBA8, PICK_RGBA8), pickable points only. */
export function pickVert(): string {
  return /* glsl */ `${COMMON}${POINT_CORE}
uniform float uDotSize;
uniform float uRefDist;
uniform float uDistPow;
uniform float uMinPickPx;
uniform float uMinAlpha;
uniform vec4 uProfile[5];
flat out uint vId;
void main() {
  PointOut o = pointPosition();
  float age = uIntro - aMisc.z;
  float alpha = o.look.x * o.presence * uFade;
  if (!o.live || age < 0.0 || alpha < uMinAlpha) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vId = 0u;
    return;
  }
  vec4 mv = modelViewMatrix * vec4(o.p, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = uDotSize * aMisc.y * pow(uRefDist / max(0.1, -mv.z), uDistPow);
  float visible = 4.0 * uProfile[o.kind].x * s;
  gl_PointSize = max(visible, uMinPickPx);
  vId = uint(gl_VertexID) + 1u;
}
`;
}

export const PICK_FRAG = /* glsl */ `
precision highp float;
precision highp int;
flat in uint vId;
out uint outId;
void main() {
  if (length(gl_PointCoord * 2.0 - 1.0) > 1.0) discard;
  outId = vId;
}
`;

/** RGBA8 fallback of the pick pass: 24-bit id in rgb (decodeIdRgba8). */
export const PICK_FRAG_RGBA8 = /* glsl */ `
precision highp float;
precision highp int;
flat in uint vId;
out vec4 outColor;
void main() {
  if (length(gl_PointCoord * 2.0 - 1.0) > 1.0) discard;
  outColor = vec4(float(vId & 255u) / 255.0, float((vId >> 8u) & 255u) / 255.0, float((vId >> 16u) & 255u) / 255.0, 1.0);
}
`;

/** Anatomy haze: decorative points (not pickable) that keep the silhouette legible. */
export const HAZE_VERT = /* glsl */ `${COMMON}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uIntro;
uniform float uFadeSec;
uniform float uFlashSec;
uniform float uMorph;
uniform float uHazeDim;
uniform float uKeep;
uniform float uBoost;
uniform float uBrainBoost;
uniform float uDotSize;
uniform float uGlow;
uniform float uDpr;
uniform float uRefDist;
uniform float uDistPow;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uExtent;
uniform float uFade;
uniform float uPaper;
uniform float uPaperAlpha;
uniform float uCoreScale;
uniform vec4 uFigure;
uniform float uFigureZ;
uniform vec4 uProfile;
uniform float uIntensity[${HAZE_SLOTS}];
uniform float uBrainKind[${HAZE_SLOTS}];
uniform float uFlashKind[${HAZE_SLOTS}];
uniform float uBodyKind[${HAZE_SLOTS}];
uniform vec3 uBrainC;
uniform float uBrainScale;
uniform float uHazeDensity;
uniform vec3 uHazeSpeck;
uniform float uHazeSpeckShare;
in vec3 aPos;
in vec4 aColor;
in vec4 aMisc;
out vec4 vColor;
out vec4 vShape;
out float vDiam;
out vec4 vHot;
void main() {
  vHot = vec4(0.0);
  int kind = int(aMisc.y + 0.5);
  float age = uIntro - aMisc.z;
  float vis = (age >= 0.0 && aMisc.x < uKeep) ? 1.0 : 0.0;
  bool flashes = uFlashKind[kind] > 0.5;
  float fadeIn = flashes ? 1.0 : clamp(age / uFadeSec, 0.0, 1.0);
  float flash = flashes ? 1.0 - clamp(age / uFlashSec, 0.0, 1.0) : 0.0;
  // Spread: the brain's haze contracts with the cerebrum, the body field's density follows the slider.
  float weight = vis * fadeIn * uHazeDim * (1.0 - uMorph) * uFade * mix(1.0, uHazeDensity, uBodyKind[kind]);
  if (weight <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec4(0.0);
    vShape = vec4(1.0);
    vDiam = 0.0;
    return;
  }
  vec3 hp = aPos;
  if (uBrainKind[kind] > 0.5) hp = uBrainC + (hp - uBrainC) * uBrainScale;
  vec4 mv = modelViewMatrix * vec4(hp, 1.0);
  gl_Position = projectionMatrix * mv;
  float nf = clamp((mv.z - (uFigureZ - uFigure.w)) / (2.0 * uFigure.w), 0.0, 1.0);
  float cue = 0.55 + 0.45 * pow(nf, 0.8);
  float inten = uIntensity[kind] * aMisc.w * uBoost * (uBrainKind[kind] > 0.5 ? uBrainBoost : 1.0);
  inten = mix(inten, max(inten, 0.9 / uProfile.z), flash);
  // Specks: a few of the body's fibre and field points are small bright dots.
  float speck = (uBodyKind[kind] > 0.5 && fract(aMisc.x * 97.13) < uHazeSpeckShare) ? 1.0 : 0.0;
  inten *= mix(1.0, uHazeSpeck.y, speck);
  float s = uDotSize * pow(uRefDist / max(0.1, -mv.z), uDistPow) * (1.0 + 1.2 * flash) * mix(1.0, uHazeSpeck.x, speck);
  float sc = uProfile.x * s * mix(1.0, uCoreScale, uPaper);
  float sh = uProfile.y * s;
  float halo = uProfile.w * uGlow * (1.0 - uPaper);
  float radius = uExtent * (halo > 0.0 ? max(sc, sh) : sc);
  float diam = clamp(2.0 * radius, uMinPx, uMaxPx);
  gl_PointSize = diam * uDpr;
  vDiam = diam;
  vShape = vec4(max(sc, 1e-3), max(sh, 1e-3), mix(uProfile.z, 1.0, uPaper), halo);
  vec3 col = mix(toLinear(aColor.rgb), vec3(1.0), max(flash, speck * uHazeSpeck.z));
  float w = uPaper > 0.5 ? clamp(weight * cue * inten, 0.0, 1.0) * uPaperAlpha : inten * cue * weight;
  vColor = vec4(col, w);
}
`;

/** The seed ring of the intro: one sprite at the brainstem whose ring grows 0 → 40 px and fades. */
export const SEED_VERT = /* glsl */ `${COMMON}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uSeedPos;
uniform float uSeedPx;
uniform float uDpr;
in vec3 position;
void main() {
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(uSeedPos + position * 0.0, 1.0));
  gl_PointSize = (2.0 * uSeedPx + 6.0) * uDpr;
}
`;

export const SEED_FRAG = /* glsl */ `${COMMON}
uniform float uSeedT;
uniform float uSeedPx;
uniform float uWriteScale;
uniform vec3 uRingColor;
out vec4 outColor;
void main() {
  float extent = uSeedPx + 3.0;
  float d = length(gl_PointCoord - 0.5) * 2.0 * extent;
  float r = uSeedT * uSeedPx;
  float a = (1.0 - uSeedT) * 0.8 * (1.0 - smoothstep(0.4, 1.4, abs(d - r)));
  if (a < 0.002) discard;
  outColor = vec4(uRingColor * a * 1.5 * uWriteScale, a * uWriteScale);
}
`;

/** Lines (CORTEX-UX §6.10): 1 px, premultiplied additive, depth cue, per-vertex draw-on parameter t. */
export const LINES_VERT = /* glsl */ `${COMMON}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uDraw;
uniform float uAlpha;
uniform float uAlphaFar;
uniform float uDim;
uniform vec4 uFigure;
uniform float uFigureZ;
in vec3 position;
in vec4 color;
in float t;
out vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float nf = clamp((mv.z - (uFigureZ - uFigure.w)) / (2.0 * uFigure.w), 0.0, 1.0);
  float cue = 0.55 + 0.45 * pow(nf, 0.8);
  float drawn = step(t, uDraw + 1e-4);
  float a = color.a * mix(uAlphaFar, uAlpha, t) * cue * drawn * uDim;
  vColor = vec4(toLinear(color.rgb), a);
}
`;

export const LINES_FRAG = /* glsl */ `
precision highp float;
uniform float uWriteScale;
uniform float uPaper;
in vec4 vColor;
out vec4 outColor;
void main() {
  float a = uPaper > 0.5 ? min(1.0, vColor.a) : vColor.a;
  if (a < 0.002) discard;
  outColor = vec4(vColor.rgb * a * uWriteScale, a * uWriteScale);
}
`;

/** Full-screen triangle for the composite pass (positions in clip space). */
export const COMPOSITE_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Composite: tone map and screen over the stage (Ink), or "over" the stage (Paper). The background is drawn here
 * (stage colour with the radial lift and the corner vignette) so saved pictures are self-contained.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uHdr;
uniform float uExposure;
uniform float uReadScale;
uniform float uPaper;
uniform vec3 uStage;
uniform vec3 uLift;
uniform vec2 uSize;
uniform vec4 uLiftEllipse;
uniform float uLiftPow;
uniform vec4 uVignette;
uniform vec2 uStageOrigin;
uniform vec2 uStageSize;
in vec2 vUv;
out vec4 outColor;
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec2 px = vec2(vUv.x * uSize.x, (1.0 - vUv.y) * uSize.y);
  vec2 sp = px - uStageOrigin;
  vec2 le = (sp - uLiftEllipse.xy) / max(uLiftEllipse.zw, vec2(1.0));
  float t = pow(clamp(1.0 - length(le), 0.0, 1.0), uLiftPow);
  vec3 bg = mix(uStage, uLift, t);
  vec2 ve = (sp - uStageSize * 0.5) / max(uStageSize * uVignette.xy, vec2(1.0));
  float vign = clamp(1.0 - uVignette.w * clamp(length(ve) - uVignette.z, 0.0, 1.0), 0.0, 1.0);
  bg *= vign;
  vec4 hdr = texture(uHdr, vUv) * uReadScale;
  vec3 outc;
  if (uPaper > 0.5) {
    outc = hdr.rgb + bg * (1.0 - clamp(hdr.a, 0.0, 1.0));
  } else {
    vec3 mapped = 1.0 - exp(-uExposure * max(hdr.rgb, vec3(0.0)));
    outc = bg + mapped - bg * mapped;
  }
  outColor = vec4(toSrgb(outc), 1.0);
}
`;
