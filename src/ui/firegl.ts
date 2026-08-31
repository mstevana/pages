// The fire, shaded per pixel on the GPU.
//
// Everything else in SYND draws through one 2D canvas, and the flame flipbook
// in sprites/flame.ts exists precisely because a 2D canvas cannot run a shader.
// Three things a fire really does are impossible to fake with blits, though:
// the air above it bends what you see through it, it lights the ground and the
// wreck it is sitting on, and its own smoke shadows itself.
//
// So this is a post-process, not a second renderer. At the particle pass the
// scene drawn so far is copied into a texture, the fire is shaded over it in
// GLSL, and the result is blitted back into the same 2D canvas. Draw order,
// the camera, input and the DOM are all untouched, and if the browser has no
// WebGL the flipbook path runs exactly as before.
//
// Four passes over the fire's bounding box:
//
//   aux        every flame writes a heat envelope (taller than the flame - hot
//              air keeps rising after it stops glowing), its own emission, and
//              a wide pool of spill light around its root, additively into an
//              offscreen buffer. Three scalars come out - haze, the flame's own
//              emission, and the pool - kept apart because the scene should be
//              lit by all of it while smoke may only catch what the flame
//              directly throws at it, or a plume turns into fog. It is
//              a smooth field, so it is rendered at a quarter resolution and
//              sampled back bilinear - which is where most of the cost of the
//              whole layer would otherwise sit.
//   composite  the scene texture, sampled with the UV pushed around by a
//              scrolling noise field scaled by haze - that is the refraction -
//              then lit by the light channel, so geometry near a fire really
//              does brighten and flicker with it.
//   smoke      each puff shaded from its own noise density, lit from below by
//              the same light buffer and shadowed by the density between this
//              pixel and the fire under it.
//   flame      the flame field itself, additively, now evaluated per pixel per
//              frame from continuous time instead of stepping a 24-frame loop.

const VERT = `
attribute vec2 aPos;      // clip space
attribute vec2 aUV;       // local to the quad
attribute vec2 aParam;    // seed, life fraction
varying vec2 vUV;
varying vec2 vScreen;
varying float vSeed;
varying float vT;
void main() {
  vUV = aUV;
  vScreen = aPos * 0.5 + 0.5;
  vSeed = aParam.x;
  vT = aParam.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// value noise + fBm + the domain warp, the same field the CPU bake uses
const NOISE = `
precision mediump float;
float hash(vec2 p) {
  p = floor(p);
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); n += a; a *= 0.5; p *= 2.0; }
  return s / n;
}
float fbm4(vec2 p) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); n += a; a *= 0.5; p *= 2.0; }
  return s / n;
}`;

// The flame field, shared by the aux and flame passes so the light a fire
// throws can never disagree with the flame you can see.
//   u in [-1,1] across, v in [0,1] from root to tip.
const FIELD = `
float flameHeat(vec2 uv, float seed, float time) {
  float u = uv.x, v = uv.y;
  if (v < 0.0 || v > 1.0) return 0.0;
  float scroll = time * 0.85 + seed * 41.0;
  float q1 = fbm3(vec2(u * 2.3, v * 3.2 - scroll)) - 0.5;
  float q2 = fbm3(vec2(u * 2.3 + 4.7, v * 3.2 - scroll + 2.1)) - 0.5;
  float wu = u + q1 * 0.85 * (0.2 + v);   // curls harder toward the tip
  float wv = v + q2 * 0.30 * v;
  float halfW = pow(max(1.0 - v, 0.0), 0.5) * 0.92;
  float m = clamp(1.0 - abs(wu) / max(halfW, 0.02), 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  m *= smoothstep(0.0, 0.05, v);
  float n = fbm4(vec2(wu * 3.1, wv * 4.4 - scroll));
  return pow(clamp((0.35 + n * 1.5) * m - v * 0.62, 0.0, 1.0), 0.8);
}
vec3 blackbody(float h) {
  h = clamp(h, 0.0, 1.0);
  vec3 c = mix(vec3(0.0), vec3(0.306, 0.031, 0.008), smoothstep(0.0, 0.10, h));
  c = mix(c, vec3(0.690, 0.133, 0.020), smoothstep(0.10, 0.26, h));
  c = mix(c, vec3(0.941, 0.361, 0.055), smoothstep(0.26, 0.44, h));
  c = mix(c, vec3(1.000, 0.580, 0.149), smoothstep(0.44, 0.60, h));
  c = mix(c, vec3(1.000, 0.769, 0.345), smoothstep(0.60, 0.75, h));
  c = mix(c, vec3(1.000, 0.910, 0.627), smoothstep(0.75, 0.88, h));
  c = mix(c, vec3(1.000, 0.980, 0.910), smoothstep(0.88, 1.00, h));
  return c;
}`;

// ---- aux: heat envelope + emission -------------------------------------
// The quad is AUX_TALL times the flame's height; the flame lives in the bottom
// slice of it and the rest is the plume of hot, invisible air above it.
const FRAG_AUX = NOISE + FIELD + `
varying vec2 vUV;
varying float vSeed;
varying float vT;
uniform float uTime;
uniform float uTall;
uniform float uWide;
void main() {
  float v = vUV.y;
  float u = vUV.x;
  float heat = flameHeat(vec2(u * uWide, v * uTall), vSeed, uTime);
  // hot air keeps its shape well past the last glowing pixel, spreading and
  // thinning as it climbs
  float envW = (0.55 + 1.05 * v) * 0.95;
  float m = clamp(1.0 - abs(u) / envW, 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  float wob = fbm3(vec2(u * 2.4, v * 3.0 - uTime * 1.1 + vSeed * 23.0));
  // Hot air is invisible until it distorts something, and inside the flame
  // there is nothing to distort - so the envelope is weakest at the root and
  // carries most of its strength through the column above the tip.
  float haze = m * smoothstep(0.02, 0.30, v) * (1.0 - smoothstep(0.78, 1.0, v))
             * (0.35 + 0.9 * wob) * vT;
  gl_FragColor = vec4(haze * 0.62, heat * vT * 0.9, 0.0, 0.0);
}`;

// ---- spill: the pool of light a flame throws around its root -----------
// No noise, no plume - just a falloff that flickers, drawn wide and flat so it
// sits on the iso ground plane and up the side of whatever is burning.
const FRAG_SPILL = `
precision mediump float;
varying vec2 vUV;
varying float vSeed;
varying float vT;
uniform float uTime;
void main() {
  float d = length(vUV);
  if (d >= 1.0) discard;
  float fall = pow(1.0 - d, 2.7);
  float fl = 0.78 + 0.22 * sin(uTime * 9.3 + vSeed * 31.0)
                  * sin(uTime * 3.7 + vSeed * 12.0);
  gl_FragColor = vec4(0.0, 0.0, fall * fl * vT * 0.055, 0.0);
}`;

// ---- composite: refract and light the scene ----------------------------
const FRAG_COMP = NOISE + `
varying vec2 vScreen;
uniform sampler2D uBg;
uniform sampler2D uAux;
uniform float uTime;
uniform vec2 uTexel;
void main() {
  vec2 uv = vScreen;
  vec4 aux = texture2D(uAux, uv);
  float haze = aux.r, light = aux.g + aux.b;
  // Most of the box is ordinary scene with nothing happening in it; skip
  // straight to the copy there rather than paying for noise per pixel.
  if (haze + light < 0.004) { gl_FragColor = vec4(texture2D(uBg, uv).rgb, 1.0); return; }
  // Shimmer: a fine field scrolling upward, so the distortion crawls the way
  // rising air does rather than boiling in place.
  vec2 sp = uv / max(uTexel.y * 90.0, 0.0001);
  float n1 = fbm3(sp + vec2(0.0, -uTime * 2.2)) - 0.5;
  float n2 = fbm3(sp + vec2(5.7, -uTime * 2.2 + 3.1)) - 0.5;
  vec2 off = vec2(n1, n2 * 0.6) * haze * uTexel * 30.0;
  vec3 col = texture2D(uBg, clamp(uv + off, vec2(0.001), vec2(0.999))).rgb;
  // The fire as a light: geometry responds with its own colour (so tarmac
  // stays tarmac, only hotter) plus a little raw glow in the air between.
  vec3 fireCol = vec3(1.0, 0.55, 0.20);
  // A dozen flames on one wreck all write here, so this saturates easily; keep
  // the pool falling off rather than flooding the block with a flat wash.
  float l = min(light, 1.0);
  col += col * fireCol * l * 2.6 + fireCol * l * 0.05;
  gl_FragColor = vec4(col, 1.0);
}`;

// ---- smoke: density, lit from below, self-shadowed ---------------------
const FRAG_SMOKE = NOISE + `
varying vec2 vUV;
varying vec2 vScreen;
varying float vSeed;
varying float vT;
uniform sampler2D uAux;
uniform float uTime;
uniform float uTone;
float density(vec2 p, float seed, float time) {
  float r = length(p);
  float body = 1.0 - smoothstep(0.20, 0.98, r);
  float d = fbm3(p * 1.7 + vec2(seed * 19.0, -time * 0.30 + seed * 7.0));
  return clamp(body * (0.35 + 1.35 * d) - 0.08, 0.0, 1.0);
}
void main() {
  float age = 1.0 - vT;
  float dc = density(vUV, vSeed, uTime);
  if (dc <= 0.002) discard;
  // Self-shadowing: how much smoke lies between this pixel and the fire below
  // it. One tap down the column, weighted by how deep into the puff it lands,
  // is enough to give the plume interior depth instead of a flat wash.
  float occ = density(vUV + vec2(0.0, 0.42), vSeed, uTime);
  float trans = clamp(1.0 - occ * 1.45, 0.0, 1.0);
  float light = texture2D(uAux, vScreen).g;
  vec3 soot = mix(vec3(0.050, 0.050, 0.064), vec3(0.160, 0.160, 0.184), uTone);
  // Only what the fire can actually reach glows: light that got through the
  // smoke below this pixel. The bulk of a plume stays soot black.
  // Only fresh smoke is still down among the flames; by the time a puff has
  // climbed there is nothing lighting it, and it has to go black or the plume
  // reads as a pale haze instead of smoke.
  float near = vT * vT;
  vec3 col = soot + vec3(1.0, 0.50, 0.16) * min(light, 1.0) * trans * trans * near * 0.44;
  // a thin rim of scattered light where the puff thins out
  col += vec3(1.0, 0.60, 0.26) * min(light, 1.0) * pow(1.0 - dc, 4.0) * near * 0.12;
  float a = min(1.0, dc * 1.25) * min(1.0, vT * 2.6);
  gl_FragColor = vec4(col * a, a);
}`;

// ---- flame ------------------------------------------------------------
const FRAG_FLAME = NOISE + FIELD + `
varying vec2 vUV;
varying float vSeed;
varying float vT;
uniform float uTime;
void main() {
  float heat = flameHeat(vUV, vSeed, uTime);
  if (heat <= 0.004) discard;
  vec3 c = blackbody(heat);
  // the blue root of a clean flame, only where it burns hot and low
  float blue = (1.0 - smoothstep(0.0, 0.22, vUV.y)) * smoothstep(0.35, 0.7, heat);
  c = mix(c, vec3(mix(c.r, 0.43, 0.55), mix(c.g, 0.67, 0.35), mix(c.b, 1.0, 0.8)), blue);
  float a = clamp(pow(heat, 1.35) * 1.25, 0.0, 1.0) * min(1.0, vT * 1.9);
  gl_FragColor = vec4(c * a, a);
}`;

export interface FlameQuad {
  x: number; y: number;      // base centre, device px within the box
  w: number; h: number;      // device px
  seed: number; t: number;
}
export interface SmokeQuad {
  x: number; y: number; r: number;   // centre and radius, device px
  seed: number; t: number; tone: number;
}

const AUX_DIV = 4;           // the light field is smooth, so a quarter is plenty
const AUX_TALL = 2.3;        // aux quad height, in flame heights
const AUX_WIDE = 1.25;       // aux quad width, in flame widths
const FLOATS = 6;            // per vertex: pos.xy uv.xy param.xy

function compile(gl: WebGLRenderingContext, src: string, type: number): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
  return s;
}

function link(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram | null {
  const v = compile(gl, vs, gl.VERTEX_SHADER), f = compile(gl, fs, gl.FRAGMENT_SHADER);
  if (!v || !f) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.bindAttribLocation(p, 0, "aPos");
  gl.bindAttribLocation(p, 1, "aUV");
  gl.bindAttribLocation(p, 2, "aParam");
  gl.linkProgram(p);
  gl.deleteShader(v); gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { gl.deleteProgram(p); return null; }
  return p;
}

export class FireGL {
  readonly ok: boolean = false;
  private canvas!: HTMLCanvasElement;
  private gl!: WebGLRenderingContext;
  private scratch!: HTMLCanvasElement;      // the scene box, on its way to a texture
  private sg!: CanvasRenderingContext2D;
  private pAux!: WebGLProgram;
  private pSpill!: WebGLProgram;
  private pComp!: WebGLProgram;
  private pSmoke!: WebGLProgram;
  private pFlame!: WebGLProgram;
  private vbo!: WebGLBuffer;
  private bgTex!: WebGLTexture;
  private auxTex!: WebGLTexture;
  private auxFbo!: WebGLFramebuffer;
  private auxW = 0; private auxH = 0;
  private verts = new Float32Array(0);
  private lost = false;

  constructor() {
    let cv: HTMLCanvasElement;
    let gl: WebGLRenderingContext | null = null;
    try {
      cv = document.createElement("canvas");
      cv.width = 64; cv.height = 64;
      const opts = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, powerPreference: "low-power" };
      gl = (cv.getContext("webgl", opts) || cv.getContext("experimental-webgl", opts)) as WebGLRenderingContext | null;
    } catch { return; }
    if (!gl) return;
    const aux = link(gl, VERT, FRAG_AUX);
    const spill = link(gl, VERT, FRAG_SPILL);
    const comp = link(gl, VERT, FRAG_COMP);
    const smoke = link(gl, VERT, FRAG_SMOKE);
    const flame = link(gl, VERT, FRAG_FLAME);
    const vbo = gl.createBuffer();
    const bgTex = gl.createTexture();
    const auxTex = gl.createTexture();
    const auxFbo = gl.createFramebuffer();
    if (!aux || !spill || !comp || !smoke || !flame || !vbo || !bgTex || !auxTex || !auxFbo) return;
    this.canvas = cv!; this.gl = gl;
    this.pAux = aux; this.pSpill = spill; this.pComp = comp; this.pSmoke = smoke; this.pFlame = flame;
    this.vbo = vbo; this.bgTex = bgTex; this.auxTex = auxTex; this.auxFbo = auxFbo;
    for (const t of [bgTex, auxTex]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // the scene goes up as-is: a colour-managed upload would come back a shade
    // off and the box would show as a rectangle against the rest of the canvas
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.scratch = document.createElement("canvas");
    this.sg = this.scratch.getContext("2d") as CanvasRenderingContext2D;
    cv!.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; });
    cv!.addEventListener("webglcontextrestored", () => { this.lost = false; });
    this.ok = true;
  }

  private resize(w: number, h: number): void {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w; this.canvas.height = h;
  }

  private ensureAux(w: number, h: number): void {
    if (this.auxW === w && this.auxH === h) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.auxTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.auxFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.auxTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.auxW = w; this.auxH = h;
  }

  private need(quads: number): Float32Array {
    const n = quads * 6 * FLOATS;
    if (this.verts.length < n) this.verts = new Float32Array(Math.max(n, 512));
    return this.verts;
  }

  // one quad, in device px within the box, with a local UV frame
  private push(a: Float32Array, o: number, w: number, h: number,
               x0: number, y0: number, x1: number, y1: number,
               u0: number, v0: number, u1: number, v1: number,
               seed: number, t: number): number {
    const cx0 = (x0 / w) * 2 - 1, cx1 = (x1 / w) * 2 - 1;
    // device y runs down, clip y runs up
    const cy0 = 1 - (y0 / h) * 2, cy1 = 1 - (y1 / h) * 2;
    const put = (px: number, py: number, uu: number, vv: number): void => {
      a[o++] = px; a[o++] = py; a[o++] = uu; a[o++] = vv; a[o++] = seed; a[o++] = t;
    };
    put(cx0, cy0, u0, v0); put(cx1, cy0, u1, v0); put(cx0, cy1, u0, v1);
    put(cx1, cy0, u1, v0); put(cx1, cy1, u1, v1); put(cx0, cy1, u0, v1);
    return o;
  }

  private bind(prog: WebGLProgram, data: Float32Array, count: number): void {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * 6 * FLOATS), gl.DYNAMIC_DRAW);
    const st = FLOATS * 4;
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 2, gl.FLOAT, false, st, i * 8);
    }
  }

  // Shade the fire over the scene box and hand back the canvas holding it, or
  // null if this frame could not be done on the GPU (caller falls back).
  render(scene: HTMLCanvasElement, bx: number, by: number, bw: number, bh: number,
         flames: FlameQuad[], smokes: SmokeQuad[], time: number): HTMLCanvasElement | null {
    if (!this.ok || this.lost || bw < 2 || bh < 2) return null;
    const gl = this.gl;
    this.resize(bw, bh);
    const aw = Math.max(1, Math.round(bw / AUX_DIV)), ah = Math.max(1, Math.round(bh / AUX_DIV));
    this.ensureAux(aw, ah);
    if (this.scratch.width !== bw || this.scratch.height !== bh) {
      this.scratch.width = bw; this.scratch.height = bh;
    }
    this.sg.clearRect(0, 0, bw, bh);
    this.sg.drawImage(scene, bx, by, bw, bh, 0, 0, bw, bh);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    // GL counts rows from the bottom and the canvas counts them from the top;
    // without this the box comes back vertically mirrored.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.scratch);

    const tm = time % 600;
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);

    // ---- aux: haze envelope + emission, additive into the offscreen buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.auxFbo);
    gl.viewport(0, 0, aw, ah);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (flames.length > 0) {
      const a = this.need(flames.length);
      let o = 0;
      for (const f of flames) {
        const th = f.h * AUX_TALL, hw = f.w * 0.5 * AUX_WIDE;
        o = this.push(a, o, bw, bh, f.x - hw, f.y - th, f.x + hw, f.y, -1, 1, 1, 0, f.seed, f.t);
      }
      this.bind(this.pAux, a, flames.length);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(gl.getUniformLocation(this.pAux, "uTime"), tm);
      gl.uniform1f(gl.getUniformLocation(this.pAux, "uTall"), AUX_TALL);
      gl.uniform1f(gl.getUniformLocation(this.pAux, "uWide"), AUX_WIDE);
      gl.drawArrays(gl.TRIANGLES, 0, flames.length * 6);

      // the pool of light around each root, wide and flat on the ground
      let o2 = 0;
      const b = this.need(flames.length);
      for (const f of flames) {
        const rw = f.w * 2.2, rh = f.h * 0.95 + f.w * 0.9;
        const cyy = f.y - f.h * 0.22;
        o2 = this.push(b, o2, bw, bh, f.x - rw, cyy - rh, f.x + rw, cyy + rh, -1, -1, 1, 1, f.seed, f.t);
      }
      this.bind(this.pSpill, b, flames.length);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(gl.getUniformLocation(this.pSpill, "uTime"), tm);
      gl.drawArrays(gl.TRIANGLES, 0, flames.length * 6);
    }

    // ---- composite: refracted, fire-lit scene
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, bw, bh);
    {
      const a = this.need(1);
      this.push(a, 0, bw, bh, 0, 0, bw, bh, 0, 0, 1, 1, 0, 1);
      this.bind(this.pComp, a, 1);
      gl.blendFunc(gl.ONE, gl.ZERO);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.auxTex);
      gl.uniform1i(gl.getUniformLocation(this.pComp, "uBg"), 0);
      gl.uniform1i(gl.getUniformLocation(this.pComp, "uAux"), 1);
      gl.uniform1f(gl.getUniformLocation(this.pComp, "uTime"), tm);
      gl.uniform2f(gl.getUniformLocation(this.pComp, "uTexel"), 1 / bw, 1 / bh);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.activeTexture(gl.TEXTURE0);
    }

    // ---- smoke, over the scene, lit and shadowed by the aux buffer
    for (const tone of [0, 1]) {
      const list = smokes.filter((s) => s.tone === tone);
      if (list.length === 0) continue;
      const a = this.need(list.length);
      let o = 0;
      for (const s of list) {
        o = this.push(a, o, bw, bh, s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r, -1, -1, 1, 1, s.seed, s.t);
      }
      this.bind(this.pSmoke, a, list.length);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.auxTex);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(gl.getUniformLocation(this.pSmoke, "uAux"), 1);
      gl.uniform1f(gl.getUniformLocation(this.pSmoke, "uTime"), tm);
      gl.uniform1f(gl.getUniformLocation(this.pSmoke, "uTone"), tone);
      gl.drawArrays(gl.TRIANGLES, 0, list.length * 6);
    }

    // ---- the flames themselves
    if (flames.length > 0) {
      const a = this.need(flames.length);
      let o = 0;
      for (const f of flames) {
        const hw = f.w * 0.5;
        o = this.push(a, o, bw, bh, f.x - hw, f.y - f.h, f.x + hw, f.y, -1, 1, 1, 0, f.seed, f.t);
      }
      this.bind(this.pFlame, a, flames.length);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(gl.getUniformLocation(this.pFlame, "uTime"), tm);
      gl.drawArrays(gl.TRIANGLES, 0, flames.length * 6);
    }
    return this.canvas;
  }
}
