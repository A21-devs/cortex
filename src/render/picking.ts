/**
 * GPU picking (CORTEX-UX §6.14, §12.18). Owner: E10.
 * The pickable points (visible, state alpha ≥ 0.2) are drawn into a small integer target with id = ordinal + 1,
 * point size max(visible size, 6 px), depth-tested so the front point wins. Only a 33 × 33 CSS px window around
 * the cursor is rendered (the camera's view offset selects the sub-rectangle of the full image, so sizes stay in
 * CSS px), and the central 9 × 9 px are read back asynchronously (PBO + fence) at most 30 times a second; the
 * non-zero id nearest the centre wins.
 *
 * PICK-CLEAR-PROBE: three's clear() writes the renderer's clear colour truncated to uint into integer targets, so a
 * white or Paper stage would clear the pick target to id 1 (every empty pixel would pick ordinal 0): the pick pass
 * sets the clear colour to (0,0,0,0) before clearing and restores it after (`withPickClear`). The readback always
 * uses RGBA_INTEGER / UNSIGNED_INT, the combination GLES 3.0 guarantees for unsigned integer colour buffers
 * whatever IMPLEMENTATION_COLOR_READ_FORMAT reports (tests/smoke/gl-worker-probe.html checks both on the target
 * GPU). Without a renderable R32UI target ids are encoded in RGBA8 (encodeIdRgba8 / decodeIdRgba8).
 */
import {
  Color,
  NearestFilter,
  PerspectiveCamera,
  RedIntegerFormat,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  UnsignedIntType,
  WebGLRenderTarget,
  type Object3D,
  type WebGLRenderer,
} from "three";
import { RENDER_TUNING } from "./tuning";

export const PICK_HZ = RENDER_TUNING.pointer.pickHz;
export const PICK_WINDOW_PX = RENDER_TUNING.pointer.pickWindowPx;
/** Side of the rendered pick window (CSS px); larger than the read window so big sprites centred nearby count. */
export const PICK_RENDER_PX = RENDER_TUNING.pointer.pickRenderPx;

/** Nearest non-zero id to the centre of a square window of ids (row-major, size×size). */
export function nearestId(ids: Uint32Array, size: number): number {
  const c = (size - 1) / 2;
  let best = 0;
  let bestD = Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const id = ids[y * size + x] as number;
      if (id === 0) continue;
      const d = (x - c) * (x - c) + (y - c) * (y - c);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
  }
  return best;
}

/** Minimal surface of a renderer whose clear colour can be swapped around the pick pass. */
export interface ClearColourTarget {
  getClearColor(target: { r: number; g: number; b: number }): unknown;
  getClearAlpha(): number;
  setClearColor(color: { r: number; g: number; b: number } | number, alpha?: number): void;
}

/**
 * Run `fn` with the clear colour set to transparent black, restoring the previous one afterwards. `prev` receives
 * the saved colour (pass a THREE.Color for a three renderer: its setClearColor only accepts colour instances).
 */
export function withPickClear<T>(r: ClearColourTarget, fn: () => T, prev: { r: number; g: number; b: number } = { r: 0, g: 0, b: 0 }): T {
  r.getClearColor(prev);
  const alpha = r.getClearAlpha();
  r.setClearColor(0x000000, 0);
  try {
    return fn();
  } finally {
    r.setClearColor(prev, alpha);
  }
}

/** RGBA8 fallback encoding of id = ordinal + 1 (24 bits in rgb, alpha 255). */
export function encodeIdRgba8(id: number): [number, number, number, number] {
  return [id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, 255];
}

export function decodeIdRgba8(r: number, g: number, b: number, a: number): number {
  return a === 0 ? 0 : r | (g << 8) | (b << 16);
}

/**
 * Turn raw readback data into ids. Integer targets read as RGBA_INTEGER (4 uints per pixel, the id in R); RGBA8
 * targets as RGBA bytes.
 */
export function idsFromReadback(data: Uint32Array | Uint8Array, size: number, integer: boolean): Uint32Array {
  const ids = new Uint32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    if (integer) ids[i] = (data as Uint32Array)[i * 4] as number;
    else {
      const d = data as Uint8Array;
      ids[i] = decodeIdRgba8(d[i * 4] as number, d[i * 4 + 1] as number, d[i * 4 + 2] as number, d[i * 4 + 3] as number);
    }
  }
  return ids;
}

/** The pieces of WebGL2 the async readback needs (a fake implements it in tests). */
export interface ReadbackGl {
  readonly PIXEL_PACK_BUFFER: number;
  readonly STREAM_READ: number;
  readonly SYNC_GPU_COMMANDS_COMPLETE: number;
  readonly TIMEOUT_EXPIRED: number;
  readonly WAIT_FAILED: number;
  readonly RGBA_INTEGER: number;
  readonly RGBA: number;
  readonly UNSIGNED_INT: number;
  readonly UNSIGNED_BYTE: number;
  createBuffer(): WebGLBuffer | null;
  deleteBuffer(b: WebGLBuffer | null): void;
  bindBuffer(target: number, b: WebGLBuffer | null): void;
  bufferData(target: number, size: number, usage: number): void;
  readPixels(x: number, y: number, w: number, h: number, format: number, type: number, offset: number): void;
  fenceSync(condition: number, flags: number): WebGLSync | null;
  clientWaitSync(sync: WebGLSync, flags: number, timeout: number): number;
  deleteSync(sync: WebGLSync | null): void;
  flush(): void;
  getBufferSubData(target: number, offset: number, dst: ArrayBufferView): void;
  isContextLost(): boolean;
}

/**
 * Asynchronous readback of a `size`² window at (x, y) of the bound read framebuffer: readPixels into a pixel-pack
 * buffer, a fence, then polling with `wait` until the GPU is done. Resolves null when the context is lost or the
 * fence fails.
 */
export async function readWindowAsync(gl: ReadbackGl, x: number, y: number, size: number, integer: boolean, wait: () => Promise<void>): Promise<Uint32Array | Uint8Array | null> {
  const bytes = size * size * 4 * (integer ? 4 : 1);
  const buf = gl.createBuffer();
  if (!buf) return null;
  try {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
    gl.readPixels(x, y, size, size, integer ? gl.RGBA_INTEGER : gl.RGBA, integer ? gl.UNSIGNED_INT : gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return null;
    gl.flush();
    try {
      for (let i = 0; i < 120; i++) {
        if (gl.isContextLost()) return null;
        const r = gl.clientWaitSync(sync, 0, 0);
        if (r === gl.WAIT_FAILED) return null;
        if (r !== gl.TIMEOUT_EXPIRED) break;
        await wait();
      }
    } finally {
      gl.deleteSync(sync);
    }
    if (gl.isContextLost()) return null;
    const out = integer ? new Uint32Array(size * size * 4) : new Uint8Array(size * size * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return out;
  } finally {
    gl.deleteBuffer(buf);
  }
}

export interface PickRequest {
  /** The object drawn into the pick target (PointsLayer.pickObject). */
  object: Object3D;
  /** The leaf's camera (its view offset is honoured). */
  camera: PerspectiveCamera;
  /** Pointer in canvas CSS px and the canvas size. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Yields to the browser between fence polls (the leaf window's timer). */
  wait: () => Promise<void>;
}

/** GPU picker for one renderer; picks are serialised (a newer request supersedes a waiting one). */
export class Picker {
  private target: WebGLRenderTarget;
  private readonly scene = new Scene();
  private readonly pickCamera = new PerspectiveCamera();
  private readonly prevClear = new Color();
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    readonly integerIds: boolean,
  ) {
    const s = PICK_RENDER_PX;
    this.target = integerIds
      ? new WebGLRenderTarget(s, s, { type: UnsignedIntType, format: RedIntegerFormat, internalFormat: "R32UI", minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true, generateMipmaps: false })
      : new WebGLRenderTarget(s, s, { type: UnsignedByteType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true, generateMipmaps: false });
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** Ordinal under the pointer, or -1 (also when superseded, lost or outside the canvas). */
  async pick(req: PickRequest): Promise<number> {
    if (this.disposed) return -1;
    if (req.x < 0 || req.y < 0 || req.x >= req.width || req.y >= req.height) return -1;
    const gen = ++this.generation;
    const r = this.renderer;
    const gl = r.getContext() as WebGL2RenderingContext;
    if (gl.isContextLost()) return -1;
    const s = PICK_RENDER_PX;
    const half = (s - 1) / 2;
    const cam = this.pickCamera;
    const main = req.camera;
    cam.fov = main.fov;
    cam.aspect = main.aspect;
    cam.near = main.near;
    cam.far = main.far;
    cam.position.copy(main.position);
    cam.quaternion.copy(main.quaternion);
    cam.updateMatrixWorld(true);
    const v = main.view;
    const ox = v && v.enabled ? v.offsetX : 0;
    const oy = v && v.enabled ? v.offsetY : 0;
    cam.setViewOffset(req.width, req.height, ox + Math.round(req.x) - half, oy + Math.round(req.y) - half, s, s);
    cam.updateProjectionMatrix();

    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const parent = req.object.parent;
    this.scene.add(req.object);
    let data: Uint32Array | Uint8Array | null = null;
    try {
      r.autoClear = false;
      r.setRenderTarget(this.target);
      withPickClear(r as unknown as ClearColourTarget, () => r.clear(true, true, false), this.prevClear);
      r.render(this.scene, cam);
      const w = PICK_WINDOW_PX;
      const x0 = Math.floor((s - w) / 2);
      r.setRenderTarget(this.target);
      const pending = readWindowAsync(gl as unknown as ReadbackGl, x0, x0, w, this.integerIds, req.wait);
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAutoClear;
      this.scene.remove(req.object);
      if (parent) parent.add(req.object);
      data = await pending;
    } catch {
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAutoClear;
      if (req.object.parent === this.scene) this.scene.remove(req.object);
      if (parent && req.object.parent !== parent) parent.add(req.object);
      return -1;
    }
    if (gen !== this.generation || this.disposed || !data) return -1;
    const id = nearestId(idsFromReadback(data, PICK_WINDOW_PX, this.integerIds), PICK_WINDOW_PX);
    return id === 0 ? -1 : id - 1;
  }

  /** Drop the target (context restored or renderer released). */
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.target.dispose();
  }
}
