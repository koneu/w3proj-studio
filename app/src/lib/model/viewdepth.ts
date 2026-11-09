// A depth picture of some models from the camera, at the view's size: what HD water reads to see how much water lies in
// front of a model under its surface (the terrain renderer's water pass). Only the models are drawn into it, not the
// ground: the lake bed keeps the water's depth as the ground under it gives it.

/** The eye-space distance (along the view direction) of a depth picture's value `d` (0–1, the default depth range)
 *  for a perspective projection from `near` to `far`. The water shader does the same. */
export function eyeDistance(d: number, near: number, far: number): number {
  const ndc = 2 * d - 1;
  return (2 * near * far) / (far + near - ndc * (far - near));
}

/**
 * How deep the water a pixel of the surface shows is (world units): the bed's depth there, or less where a model under
 * the surface is nearer than the bed, by how far the model's point seen lies below the surface. `surfaceZ`: the
 * surface's height at the pixel; `seenZ`: the height of the model's point behind it, or null where the depth picture
 * has nothing behind the surface (no model, or one in front of the water). The water shader does the same.
 */
export function waterSeenDepth(bedDepth: number, surfaceZ: number, seenZ: number | null): number {
  return seenZ === null ? bedDepth : Math.min(bedDepth, Math.max(0, surfaceZ - seenZ));
}

/**
 * The depth picture's GPU side: a depth texture of the view's size and the framebuffer drawing into it, made on first
 * use and again when the view's size changes. A lost context takes both (made again once it's back; `begin` says false
 * meanwhile, and the water is drawn by the bed alone), and a framebuffer the GPU won't take turns it off for good.
 */
export class ViewDepth {
  private texture: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private width = 0;
  private height = 0;
  /** The framebuffer couldn't be made complete: no depth picture on this GPU. */
  private failed = false;
  private stale = false;
  private readonly onLost = () => { this.stale = true; };

  constructor(readonly gl: WebGL2RenderingContext) {
    gl.canvas.addEventListener?.("webglcontextlost", this.onLost);
  }

  /** Binds the framebuffer for a picture of `width` × `height` (viewport, cleared depth); false when there's none. */
  begin(width: number, height: number): boolean {
    const gl = this.gl;
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (this.failed || gl.isContextLost()) return false;
    if (this.stale) { this.texture = null; this.fbo = null; this.stale = false; }
    if (this.fbo && (this.width !== width || this.height !== height)) this.free();
    if (!this.fbo) {
      const tex = gl.createTexture(), fbo = gl.createFramebuffer();
      if (!tex || !fbo) {
        if (tex) gl.deleteTexture(tex);
        if (fbo) gl.deleteFramebuffer(fbo);
        return false;
      }
      this.texture = tex;
      this.fbo = fbo;
      this.width = width;
      this.height = height;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.free();
        // A lost context reports incomplete too: that isn't this GPU refusing.
        if (!gl.isContextLost()) this.failed = true;
        return false;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, width, height);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    return true;
  }

  /** Back to the picture's framebuffer; the depth texture to read. */
  end(): WebGLTexture | null {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    return this.texture;
  }

  private free() {
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.texture) gl.deleteTexture(this.texture);
    this.fbo = this.texture = null;
    this.width = this.height = 0;
  }

  dispose() {
    this.free();
    this.gl.canvas.removeEventListener?.("webglcontextlost", this.onLost);
  }
}
