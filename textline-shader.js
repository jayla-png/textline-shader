/*!
 * Textline Shader — the Core Brand aurora background as a lightweight WebGL2 module.
 * No dependencies. ~7 KB gzipped.
 *
 *   import { TextlineShader } from './textline-shader.js'
 *   const bg = new TextlineShader(document.querySelector('.hero'), { tone: 'lime' })
 *   bg.setTone('azure'); bg.set({ background: '#001EFF' }); bg.destroy()
 *
 * or as a custom element:  <textline-shader tone="hazard"></textline-shader>
 *
 * Pipeline: aurora scene → blinds + ripple distortion → separable blur → dither + tint.
 */

// ─── Tones ──────────────────────────────────────────────────────────────────

const BASE = {
  background: '#001EFF',
  speed: 1,
  auroras: [
    {
      enabled: true, x: 0.5, y: 0.1141, angle: 0.5022, lines: 26,
      frequency: 0.5, amplitude: 0.5, spacing: 0.35,
      palette: '#FFB341', tint: '#FFFFFF', solid: 0, hueScale: 0.92, hueOffset: 0.82, glow: 0.75,
      blend: 'glow', mix: 1, speed: 0.25,
    },
    {
      enabled: true, x: 0.5028, y: 0.3462, angle: 0.5022, lines: 26,
      frequency: 0.5, amplitude: 0.5, spacing: 0.35,
      palette: '#B6F200', tint: '#FFFFFF', solid: 0, hueScale: 0.83, hueOffset: 0.1, glow: 0.75,
      blend: 'pin-light', mix: 1, speed: 0.25,
    },
  ],
  ripple: { strength: 1, frequency: 1, radius: 1, mouse: 0.2, speed: 0.32 },
  blinds: { amount: 1, divisions: 0.08, distortion: 0.24, aberration: 1, speed: 0.28 },
  blur: 0.28,
  dither: { threshold: 0.4, mix: 0.5, scale: 1 },
  tint: { color: '#151515', amount: 0 },
  // The composition is laid out on a 16:9 frame fitted to the element. Elements 16:9 or wider
  // fill the height. On narrower ones (phones, portrait tablets) crop picks the frame size:
  // 0 shows the whole width scaled down, 1 fills the height and crops the sides, 0.5 sits between.
  // anchorX / anchorY place the frame when it is smaller than the element (0 = left / bottom).
  layout: { crop: 0.5, zoom: 1, anchorX: 0.5, anchorY: 0 },
}

// Each tone is a partial override of BASE; aurora overrides are matched by index.
// Azure is the original Unicorn Studio scene. The others are matched by eye to the
// Figma Cover set (Core Brand, node 335:110), which is softer than the live scene.
const SOFT = 0.6
const WARM = { blend: 'glow', glow: 3, y: 0.06, spacing: 0.6, hueOffset: 0.5 }
const WARM_UNDERTOW = { blend: 'difference', y: -0.02, mix: 0.7 }

export const TONES = {
  azure: {},
  lime: {
    background: '#C8FF00',
    blur: SOFT,
    auroras: [{ blend: 'normal', tint: '#12202E', solid: 0.75, y: 0.07 }, { mix: 0 }],
  },
  grey: {
    background: '#CFD0D4',
    blur: SOFT,
    auroras: [{ blend: 'normal', tint: '#001EFF', solid: 0.85, y: 0.07 }, { mix: 0.5 }],
  },
  hazard: {
    background: '#EF770C',
    blur: SOFT,
    auroras: [WARM, WARM_UNDERTOW],
  },
  red: {
    background: '#EF3803',
    blur: SOFT,
    auroras: [WARM, WARM_UNDERTOW],
  },
  dark: { tint: { color: '#151515', amount: 0.5 } },
}

export const BLEND_MODES = ['glow', 'pin-light', 'screen', 'multiply', 'difference', 'normal']

// ─── Shaders ────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
const float PI = 3.14159265359;
const float TAU = 6.28318530718;
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
`

// Two flowing line fields composited over a flat background.
const SCENE = HEAD + `
uniform vec2 uRes;      // frame size in px
uniform vec4 uFrame;    // frame offset, frame scale (element uv)
uniform vec3 uBg;
uniform vec4 uPlace[2];   // x, y, angle (turns), line count
uniform vec4 uFlow[2];    // frequency 0-1, amplitude, spacing 0-1, phase
uniform vec4 uHue[2];     // hue scale 0-1, hue offset, glow, mix
uniform vec3 uPalette[2];
uniform vec4 uTint[2];    // tint colour, solid 0-1 (tint replaces the palette)
uniform int uBlend[2];

vec3 squash(vec3 x) { x *= 4.0; return x / (1.0 + x); }

vec2 flow(vec2 p, float seed, float freq, float amp, float phase) {
  mat2 turn = mat2(0.6, -0.8, 0.8, 0.6);
  mat2 m = turn;
  for (int octave = 0; octave < 4; octave++) {
    vec2 wave = sin(freq * (p * m) + float(octave) * phase + seed);
    p += amp * m[0] * wave / freq;
    m *= turn;
    freq *= 1.4;
  }
  return p;
}

float toSegment(vec2 p) { p.x -= clamp(p.x, -2.0, 2.0); return length(p); }

vec4 aurora(int k) {
  vec4 place = uPlace[k], fl = uFlow[k], hue = uHue[k];
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 fuv = (vUv - uFrame.xy) / uFrame.zw;
  vec2 p = rot(-place.z * TAU) * ((fuv - place.xy) * aspect);

  float count = place.w;
  float freq = mix(2.0, 15.0, fl.x);
  float spacing = mix(1.0, TAU, fl.z);
  float hueScale = mix(0.1, 1.9, hue.x);

  vec2 prev = flow(p, -1.0 / count, freq, fl.y, fl.w);
  vec3 lines = vec3(0.0), glow = vec3(0.0);
  float lineMass = 0.0, glowMass = 0.0;

  for (int i = 1; i <= 40; i++) {
    float t = float(i) / count;
    if (t > 1.0001) break;
    vec2 w = flow(p, t * spacing, freq, fl.y, fl.w);
    float d = toSegment(w);
    float smear = exp(2.0 * distance(w, prev)) - 1.0;
    prev = w;
    float line = 1.0 - smoothstep(0.0, 0.0125 + max(smear, 0.001), d);
    vec3 col = 0.5 + 0.5 * cos(TAU * (t * hueScale + hue.y + uPalette[k]));
    col = mix(col * uTint[k].rgb, uTint[k].rgb, uTint[k].a);
    float g = min(1.0 / max(d + smear, 0.001), 250.0);
    lines += line * col;
    lineMass += line;
    glow += g * col;
    glowMass += g;
  }

  lines *= 2.0 / count;
  lineMass *= 2.0 / count;
  glow /= glow + 2e4;
  glowMass /= glowMass + 2e4;

  vec3 col = squash((lines + glow * 3.0 * hue.z) * 1.2);
  float alpha = clamp(squash(vec3((lineMass + glowMass * 3.0 * hue.z) * 1.2)).r, 0.0, 1.0);
  return vec4(col, alpha);
}

vec3 composite(int mode, vec3 base, vec4 a) {
  if (mode == 0) return a.rgb + base * (1.0 - a.a);
  if (mode == 1) return mix(min(a.rgb, 2.0 * base), max(a.rgb, 2.0 * base - 1.0), step(0.5, base));
  if (mode == 2) return 1.0 - (1.0 - base) * (1.0 - a.rgb);
  if (mode == 3) return base * mix(vec3(1.0), a.rgb, a.a);
  if (mode == 4) return mix(base, abs(base - a.rgb), a.a);
  return mix(base, a.rgb, a.a);
}

void main() {
  vec3 c = uBg;
  for (int k = 0; k < 2; k++) {
    if (uHue[k].w <= 0.0) continue;
    c = mix(c, composite(uBlend[k], c, aurora(k)), uHue[k].w);
  }
  outColor = vec4(c, 1.0);
}`

// Radial ripple, then two crossed diagonal "blinds" bands that shove each
// colour channel a different distance (chromatic split).
const DISTORT = HEAD + `
uniform sampler2D uTex;
uniform vec2 uRes;      // frame size in px
uniform vec4 uFrame;    // frame offset, frame scale (element uv)
uniform vec2 uMouse;    // frame uv
uniform vec4 uRipple;   // strength, frequency, phase, mouse follow
uniform float uRadius;
uniform vec4 uBlinds;   // amount, divisions 0-1, distortion 0-1, phase
uniform float uAberration;

vec2 ripple(vec2 uv, vec2 aspect) {
  vec2 centre = 0.5 + (uMouse - 0.5) * uRipple.w;
  vec2 v = (uv - centre) * aspect;
  float d = length(v);
  vec2 dir = d > 1e-4 ? v / d : vec2(0.0, 1.0);
  float falloff = max(0.0, uRadius - d);
  float freq = 50.0 * uRipple.y * mix(1.0, 1.0 - d, 0.42);
  return uv + dir * sin(d * freq - uRipple.z) * 0.2 * uRipple.x * falloff;
}

float bandShape(float s) { return mix(s, smoothstep(0.0, 0.5, s) - smoothstep(0.5, 1.0, s), 0.51); }

vec3 bandChannels(float s) {
  return s < 0.5 ? mix(vec3(1, 0, 0), vec3(0, 1, 0), s * 2.0)
                 : mix(vec3(0, 1, 0), vec3(0, 0, 1), s * 2.0 - 1.0);
}

vec2 blinds(vec2 st, vec2 centre, float divisions, float power, float amount, float phase, out vec3 weight) {
  vec2 shift = vec2(0.0);
  weight = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    float a = (k == 0 ? 1.0 : -1.0) * PI / 6.0;
    vec2 q = rot(a) * (st - centre) + centre;
    vec3 ch = bandChannels(bandShape(fract((q.y - centre.y + phase) * divisions)));
    shift += rot(-a) * vec2(0.0, (pow(ch.b, power) - pow(ch.r, power)) * 0.1 * amount);
    weight += ch;
  }
  weight *= 0.5;
  return st + shift * 0.5;
}

void main() {
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 uv = ripple((vUv - uFrame.xy) / uFrame.zw, aspect);

  float divisions = 2.0 + uBlinds.y * 30.0;
  float power = uBlinds.z * 4.0 + 1.0;
  vec3 w;
  uv = blinds(uv * aspect, 0.5 * aspect, divisions, power, uBlinds.x, uBlinds.w, w) / aspect;

  uv = uv * uFrame.zw + uFrame.xy;
  vec2 split = vec2(pow(w.r, power), pow(w.b, power)) * 0.1 * uBlinds.x * uAberration * uFrame.zw;
  vec3 col = vec3(0.0);
  for (int i = 1; i <= 8; i++) {
    vec2 o = split * float(i) / 8.0;
    col.r += texture(uTex, uv - o).r;
    col.g += 0.5 * (texture(uTex, uv - o * 0.5).g + texture(uTex, uv + o * 0.5).g);
    col.b += texture(uTex, uv + o).b;
  }
  outColor = vec4(col / 8.0, 1.0);
}`

const BLUR = HEAD + `
uniform sampler2D uTex;
uniform vec2 uStep;   // one sigma, in uv
void main() {
  vec3 c = vec3(0.0);
  float total = 0.0;
  for (int i = -6; i <= 6; i++) {
    float x = float(i) / 2.0;
    float w = exp(-0.5 * x * x);
    c += texture(uTex, vUv + uStep * x).rgb * w;
    total += w;
  }
  outColor = vec4(c / total, 1.0);
}`

const FINISH = HEAD + `
uniform sampler2D uTex;
uniform vec3 uDither;  // threshold, mix, cell size (device px)
uniform vec4 uTint;    // colour, amount (luminosity blend)

float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer16(vec2 a) {
  return bayer2(0.125 * a) * 0.015625 + bayer2(0.25 * a) * 0.0625
       + bayer2(0.5 * a) * 0.25 + bayer2(a);
}
float luma(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 withLuma(vec3 c, float l) {
  c += l - luma(c);
  float y = luma(c), lo = min(min(c.r, c.g), c.b), hi = max(max(c.r, c.g), c.b);
  if (lo < 0.0) c = y + (c - y) * y / (y - lo);
  if (hi > 1.0) c = y + (c - y) * (1.0 - y) / (hi - y);
  return c;
}

void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float levels = 1.0 / max(uDither.x, 1e-4);
  float n = bayer16(gl_FragCoord.xy / uDither.z);
  c = mix(c, floor(c * levels + n) / levels, uDither.y);
  if (uTint.a > 0.0) c = mix(uTint.rgb, withLuma(uTint.rgb, luma(c)), uTint.a);
  outColor = vec4(c, 1.0);
}`

// ─── Helpers ────────────────────────────────────────────────────────────────

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function merge(base, patch) {
  if (Array.isArray(base)) return base.map((b, i) => (patch && patch[i] ? merge(b, patch[i]) : merge(b)))
  if (!isObj(base)) return patch === undefined ? base : patch
  const out = {}
  for (const k of Object.keys(base)) out[k] = merge(base[k], patch ? patch[k] : undefined)
  return out
}

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Full config for a tone, with optional overrides layered on top. */
export function resolveTone(tone = 'azure', overrides) {
  return merge(merge(BASE, TONES[tone] || {}), overrides)
}

// ─── Renderer ───────────────────────────────────────────────────────────────

export class TextlineShader {
  /**
   * @param {HTMLElement} el  container (a canvas is appended) or a <canvas>
   * @param {object} [opts]
   * @param {string} [opts.tone='azure']
   * @param {object} [opts.config]   overrides on top of the tone
   * @param {number} [opts.dpr=1.5]  max device pixel ratio
   * @param {number} [opts.quality=0.75]  resolution of the aurora pass
   * @param {number} [opts.fps=60]
   * @param {number} [opts.time]  start time in seconds (useful for stills)
   * @param {boolean} [opts.paused]
   */
  constructor(el, opts = {}) {
    this.opts = { dpr: 1.5, quality: 0.75, fps: 60, ...opts }
    this.tone = opts.tone || 'azure'
    this.config = resolveTone(this.tone, opts.config)
    this.time = opts.time || 0
    this.mouse = [0.5, 0.5]
    this.mouseTarget = [0.5, 0.5]

    if (el instanceof HTMLCanvasElement) {
      this.canvas = el
    } else {
      this.canvas = document.createElement('canvas')
      Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' })
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
      el.prepend(this.canvas)
    }
    this.host = el
    this.host.style.backgroundColor = this.config.background

    const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer })
    if (!gl) return // the background colour stands in
    this.gl = gl

    this.programs = {
      scene: this.program(SCENE),
      distort: this.program(DISTORT),
      blur: this.program(BLUR),
      finish: this.program(FINISH),
    }
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.targets = {}

    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    this.visible = true
    this.paused = !!opts.paused

    this.onPointer = (e) => {
      const r = this.canvas.getBoundingClientRect()
      this.mouseTarget = [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]
    }
    addEventListener('pointermove', this.onPointer, { passive: true })
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.canvas)
    this.intersectionObserver = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting
      if (this.visible) this.start()
    })
    this.intersectionObserver.observe(this.canvas)

    this.resize()
    this.start()
  }

  // ── public API ──

  /** Switch to a named tone, optionally with overrides. */
  setTone(tone, overrides) {
    this.tone = tone
    this.config = resolveTone(tone, overrides)
    this.host.style.backgroundColor = this.config.background
    this.requestFrame()
  }

  /** Deep-merge overrides into the current config. */
  set(patch) {
    this.config = merge(this.config, patch)
    this.host.style.backgroundColor = this.config.background
    this.requestFrame()
  }

  pause() { this.paused = true }
  play() { this.paused = false; this.start() }

  destroy() {
    cancelAnimationFrame(this.raf)
    removeEventListener('pointermove', this.onPointer)
    this.resizeObserver?.disconnect()
    this.intersectionObserver?.disconnect()
    if (this.canvas !== this.host) this.canvas.remove()
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext()
  }

  // ── internals ──

  program(fs) {
    const gl = this.gl
    const compile = (type, src) => {
      const s = gl.createShader(type)
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
      return s
    }
    const p = gl.createProgram()
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs))
    gl.bindAttribLocation(p, 0, 'aPos')
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    const loc = {}
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace('[0]', '')
      loc[name] = gl.getUniformLocation(p, name)
    }
    return { p, loc }
  }

  target(name, w, h) {
    const gl = this.gl
    let t = this.targets[name]
    if (t && t.w === w && t.h === h) return t
    if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb) }
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    return (this.targets[name] = { tex, fb, w, h })
  }

  resize() {
    if (!this.gl) return
    const r = this.canvas.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, this.opts.dpr)
    this.canvas.width = Math.max(1, Math.round(r.width * dpr))
    this.canvas.height = Math.max(1, Math.round(r.height * dpr))
    this.requestFrame()
  }

  start() {
    if (!this.gl || this.running) return
    this.running = true
    this.last = performance.now()
    const tick = (now) => {
      const animate = !this.paused && this.visible && !this.reducedMotion
      if (!animate && !this.dirty) { this.running = false; return }
      this.raf = requestAnimationFrame(tick)
      const dt = now - this.last
      if (animate && dt < 1000 / this.opts.fps - 2) return
      this.last = now
      if (animate) this.time += Math.min(dt, 100) / 1000
      this.render()
    }
    this.raf = requestAnimationFrame(tick)
  }

  requestFrame() {
    this.dirty = true
    this.start()
  }

  pass(prog, out, bindTex) {
    const gl = this.gl
    gl.useProgram(prog.p)
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null)
    gl.viewport(0, 0, out ? out.w : this.canvas.width, out ? out.h : this.canvas.height)
    if (bindTex) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, bindTex.tex)
      gl.uniform1i(prog.loc.uTex, 0)
    }
    return prog.loc
  }

  /** The 16:9 layout frame in element pixels: size, plus offset/scale in element uv. */
  frame(W, H) {
    const { crop, zoom, anchorX, anchorY } = this.config.layout
    const ratio = 16 / 9
    let fw = H * ratio
    if (W < fw) fw = W ** (1 - crop) * fw ** crop
    fw *= zoom
    const fh = fw / ratio
    const ox = (W - fw) * anchorX, oy = (H - fh) * anchorY
    return { fw, fh, frame: [ox / W, oy / H, fw / W, fh / H] }
  }

  render() {
    const gl = this.gl
    const c = this.config
    const W = this.canvas.width, H = this.canvas.height
    const { fw, fh, frame } = this.frame(W, H)
    const q = this.opts.quality
    const t = this.time * c.speed
    const TAU = Math.PI * 2
    this.dirty = false

    this.mouse[0] += (this.mouseTarget[0] - this.mouse[0]) * 0.06
    this.mouse[1] += (this.mouseTarget[1] - this.mouse[1]) * 0.06

    const scene = this.target('scene', Math.ceil(W * q), Math.ceil(H * q))
    const distorted = this.target('distorted', scene.w, scene.h)
    const bw = Math.ceil(W / 2), bh = Math.ceil(H / 2)
    const blurA = this.target('blurA', bw, bh)
    const blurB = this.target('blurB', bw, bh)

    // 1 · aurora scene
    let u = this.pass(this.programs.scene, scene)
    gl.uniform2f(u.uRes, fw, fh)
    gl.uniform4fv(u.uFrame, frame)
    gl.uniform3fv(u.uBg, hexToRgb(c.background))
    const a = c.auroras
    const on = (x) => (x.enabled ? x.mix : 0)
    gl.uniform4fv(u.uPlace, a.flatMap((x) => [x.x, x.y, x.angle, Math.round(x.lines)]))
    gl.uniform4fv(u.uFlow, a.flatMap((x) => [x.frequency, x.amplitude, x.spacing, (t * x.speed * 3) % TAU]))
    gl.uniform4fv(u.uHue, a.flatMap((x) => [x.hueScale, x.hueOffset, x.glow, on(x)]))
    gl.uniform3fv(u.uPalette, a.flatMap((x) => hexToRgb(x.palette)))
    gl.uniform4fv(u.uTint, a.flatMap((x) => [...hexToRgb(x.tint), x.solid]))
    gl.uniform1iv(u.uBlend, a.map((x) => Math.max(0, BLEND_MODES.indexOf(x.blend))))
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 2 · ripple + blinds
    u = this.pass(this.programs.distort, distorted, scene)
    const r = c.ripple, b = c.blinds
    gl.uniform2f(u.uRes, fw, fh)
    gl.uniform4fv(u.uFrame, frame)
    gl.uniform2f(u.uMouse, (this.mouse[0] - frame[0]) / frame[2], (this.mouse[1] - frame[1]) / frame[3])
    gl.uniform4f(u.uRipple, r.strength, r.frequency, (t * r.speed * 3) % TAU, r.mouse)
    gl.uniform1f(u.uRadius, r.radius)
    gl.uniform4f(u.uBlinds, b.amount, b.divisions, b.distortion, t * b.speed * 0.6)
    gl.uniform1f(u.uAberration, b.aberration)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 3 · blur (horizontal into A, vertical into B); sigma is a fraction of the frame width
    const sigma = c.blur * 0.014 * fw
    u = this.pass(this.programs.blur, blurA, distorted)
    gl.uniform2f(u.uStep, sigma / W, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    u = this.pass(this.programs.blur, blurB, blurA)
    gl.uniform2f(u.uStep, 0, sigma / H)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 4 · dither + tint to screen
    u = this.pass(this.programs.finish, null, blurB)
    const d = c.dither
    gl.uniform3f(u.uDither, d.threshold, d.mix, Math.max(0.25, d.scale))
    gl.uniform4f(u.uTint, ...hexToRgb(c.tint.color), c.tint.amount)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}

// ─── <textline-shader tone="lime"> ──────────────────────────────────────────

if (typeof customElements !== 'undefined' && !customElements.get('textline-shader')) {
  customElements.define('textline-shader', class extends HTMLElement {
    static observedAttributes = ['tone', 'config']
    connectedCallback() {
      if (!this.style.display) this.style.display = 'block'
      // Lighter defaults on phones; fps / quality / dpr attributes override either way.
      const mobile = matchMedia('(max-width: 767px)').matches
      this.shader = new TextlineShader(this, {
        tone: this.getAttribute('tone') || 'azure',
        config: this.parseConfig(),
        paused: this.hasAttribute('paused'),
        fps: this.num('fps', mobile ? 30 : 60),
        quality: this.num('quality', mobile ? 0.5 : 0.75),
        dpr: this.num('dpr', mobile ? 1 : 1.5),
      })
    }
    num(name, fallback) {
      const v = parseFloat(this.getAttribute(name))
      return Number.isFinite(v) ? v : fallback
    }
    disconnectedCallback() { this.shader?.destroy(); this.shader = null }
    attributeChangedCallback() { this.shader?.setTone(this.getAttribute('tone') || 'azure', this.parseConfig()) }
    parseConfig() {
      try { return JSON.parse(this.getAttribute('config') || 'null') || undefined } catch { return undefined }
    }
  })
}
