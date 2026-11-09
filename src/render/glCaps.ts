/**
 * WebGL2 capability probe. Owner: E10.
 * Verified 2026-11-09 on a desktop GPU (Chromium + ANGLE/D3D11): WebGL2, EXT_color_buffer_float,
 * EXT_float_blend, RGBA16F and R32UI framebuffers complete, fenceSync, point size 1–1024, max texture 16384.
 * The vault survey measured the same inside Obsidian 1.15 (Chromium 142).
 */

export interface GlCaps {
  webgl2: boolean;
  floatTargets: boolean;
  floatBlend: boolean;
  r32uiTarget: boolean;
  maxPointSize: number;
  maxTextureSize: number;
  renderer: string;
}

export function probeGl(gl: WebGL2RenderingContext): GlCaps {
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const floatTargets = gl.getExtension("EXT_color_buffer_float") !== null;
  const floatBlend = gl.getExtension("EXT_float_blend") !== null;
  const complete = (internal: number, format: number, type: number): boolean => {
    const tex = gl.createTexture();
    const fb = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    return ok;
  };
  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
  return {
    webgl2: true,
    floatTargets: floatTargets && complete(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT),
    floatBlend,
    r32uiTarget: complete(gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT),
    maxPointSize: range ? (range[1] ?? 1) : 1,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
  };
}
