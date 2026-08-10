/**
 * The dashboard's backdrop: hand-written GLSL on a bare WebGL context.
 *
 * **Why not a shader library.** shaders.com cannot ship in this repository.
 * Its agreement makes integration code derivative and still subject to that
 * agreement, and forbids providing source access to third parties outside your
 * organization — both of which a public Apache-2.0 repository does. It is also
 * WebGPU-only (zero `getContext("webgl"` matches in its dist tree, 29
 * `navigator.gpu`), so on a judge's browser without WebGPU it would render
 * nothing, silently, with no fallback — the exact failure mode obsel exists to
 * argue against. Sixty lines of GLSL costs nothing and works everywhere.
 *
 * **Motion is off on the judged path.** A drifting field is invisible to a
 * viewer after H.264 and fully visible to the encoder, which would spend bits
 * on it on precisely the frames three cards flip amber. `speed: 0` is a real
 * state, not a slow one: it draws a single frame and cancels the loop, so there
 * is no rAF and no repaint at all.
 *
 * **It is a bezel, not a wash.** The vignette multiplies rather than offsets,
 * so the middle of the panel — where every node, fingerprint and edge is drawn
 * — goes to exactly zero and the graph is read against flat ink. Anything that
 * lifts the center competes with the data, which this layer may never do.
 *
 * **The composite is premultiplied.** The canvas keeps WebGL's default
 * `premultipliedAlpha`, the blend func is `ONE / ONE_MINUS_SRC_ALPHA`, and the
 * shader emits `vec4(tint * alpha, alpha)`. Getting that trio out of step fails
 * silently: the page still renders, just at a fraction of the intended level,
 * which reads as "too subtle" rather than as a bug. It cost an hour once.
 */

const VERTEX_SHADER = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec2  u_res;
uniform float u_time;
uniform vec3  u_tint;
uniform float u_alert;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / max(u_res.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  // fine grain, not cloud: texture the eye reads as a noise floor, and the
  // spatial frequency H.264 discards first, so it costs nothing on camera
  float n = fbm(p * 9.0 + vec2(u_time * 0.05, u_time * -0.03));
  n = smoothstep(0.34, 0.92, n);

  // one slow sweep, the way a bar crosses an instrument face
  float sweep = fract(u_time * 0.030) * 1.6 - 0.30;
  float bar = smoothstep(0.26, 0.0, abs(uv.x - sweep));

  // hairline scan rows, locked to device pixels so they never shimmer
  float rows = 0.70 + 0.30 * (0.5 + 0.5 * sin(gl_FragCoord.y * 1.55));

  // MULTIPLIES. at the center this is 0 and the panel is flat ink.
  float edge = smoothstep(0.36, 1.04, length((uv - 0.5) * vec2(1.0, 1.32)));

  float amt = (n * 0.42 + bar * 0.58) * rows * edge;
  float alpha = clamp(amt, 0.0, 1.0) * (0.30 + u_alert * 0.18);
  gl_FragColor = vec4(u_tint * alpha, alpha);
}
`;

/**
 * mmux rose and obsel amber as the shader wants them: 0–1 triples.
 *
 * These are the only two color literals in the whole dashboard that a `var()`
 * cannot reach — a GL uniform takes numbers, not a computed style. They are
 * pinned to their tokens by a test that parses `app/globals.css`, rather than
 * by a linter rule that cannot see inside an array.
 */
export const ROSE: readonly [number, number, number] = [0.91, 0.365, 0.573]; // #e85d92 --mm-rose
export const AMBER: readonly [number, number, number] = [1.0, 0.69, 0.125]; // #ffb020 --obsel-stale

export interface BackdropSettings {
  tint: readonly [number, number, number];
  /** 0–1. Raises the level and is the only uniform that changes in a cascade. */
  alert: number;
  /** 0 freezes it completely — see the note above. */
  speed: number;
}

export interface BackdropHandle {
  set: (next: Partial<BackdropSettings>) => void;
  /** For tests: proves a frame was actually drawn, and that it then stopped. */
  stats: () => { frames: number; animating: boolean; speed: number; alert: number };
  destroy: () => void;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed to compile");
  }
  return shader;
}

/**
 * Mount the backdrop on a canvas.
 *
 * Returns null when WebGL is unavailable or the program will not link. That is
 * not an error path to recover from: the dashboard is completely legible with no
 * backdrop at all, which is the only reason a backdrop is allowed to exist.
 */
export function mountBackdrop(
  canvas: HTMLCanvasElement,
  initial: BackdropSettings,
): BackdropHandle | null {
  const attributes: WebGLContextAttributes = {
    alpha: true,
    antialias: false,
    /* Kept so a test can assert the backdrop actually painted. Without it the
       drawing buffer is cleared the moment the frame is composited, and both
       readPixels and drawImage come back fully transparent — indistinguishable
       from a shader that silently rendered nothing. The cost is one buffer that
       is not recycled; the backdrop draws once and stops, so it is in no hot
       path. */
    preserveDrawingBuffer: true,
  };

  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", attributes);
  } catch {
    return null;
  }
  if (gl === null) return null;
  const ctx = gl;

  const program = ctx.createProgram();
  if (program === null) return null;
  try {
    ctx.attachShader(program, compile(ctx, ctx.VERTEX_SHADER, VERTEX_SHADER));
    ctx.attachShader(program, compile(ctx, ctx.FRAGMENT_SHADER, FRAGMENT_SHADER));
    ctx.linkProgram(program);
    if (ctx.getProgramParameter(program, ctx.LINK_STATUS) !== true) {
      throw new Error(ctx.getProgramInfoLog(program) ?? "link failed");
    }
  } catch (cause) {
    console.warn("obsel backdrop disabled:", cause instanceof Error ? cause.message : cause);
    return null;
  }
  ctx.useProgram(program);

  const buffer = ctx.createBuffer();
  ctx.bindBuffer(ctx.ARRAY_BUFFER, buffer);
  ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
  const position = ctx.getAttribLocation(program, "a_pos");
  ctx.enableVertexAttribArray(position);
  ctx.vertexAttribPointer(position, 2, ctx.FLOAT, false, 0, 0);

  const uRes = ctx.getUniformLocation(program, "u_res");
  const uTime = ctx.getUniformLocation(program, "u_time");
  const uTint = ctx.getUniformLocation(program, "u_tint");
  const uAlert = ctx.getUniformLocation(program, "u_alert");

  // premultiplied source — must stay in step with the shader's gl_FragColor
  ctx.enable(ctx.BLEND);
  ctx.blendFunc(ctx.ONE, ctx.ONE_MINUS_SRC_ALPHA);

  /*
   * The frozen frame's phase, and not zero.
   *
   * At t = 0 the sweep sits at x = -0.30, entirely off the left edge, and the
   * value-noise hash is degenerate near the origin — so the one frame the
   * judged path ever renders had a mean alpha of 0.3% with a single hot spot in
   * one corner. This phase puts the sweep across the middle of the panel and
   * the noise field somewhere representative. It is a constant rather than a
   * clock so the frame is identical on every machine and in every take.
   */
  const state: BackdropSettings & { t: number } = { ...initial, t: 16.667 };
  let raf = 0;
  let last = 0;
  let frames = 0;
  let dead = false;

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw(): void {
    if (dead) return;
    resize();
    ctx.uniform2f(uRes, canvas.width, canvas.height);
    ctx.uniform1f(uTime, state.t);
    ctx.uniform3f(uTint, state.tint[0], state.tint[1], state.tint[2]);
    ctx.uniform1f(uAlert, state.alert);
    ctx.clearColor(0, 0, 0, 0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);
    ctx.drawArrays(ctx.TRIANGLES, 0, 3);
    frames += 1;
  }

  function stop(): void {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
  }

  function loop(now: number): void {
    if (dead) return;
    const dt = last === 0 ? 0 : Math.min((now - last) / 1000, 0.05);
    last = now;
    state.t += dt * state.speed;
    draw();
    raf = requestAnimationFrame(loop);
  }

  function run(): void {
    stop();
    last = 0;
    if (state.speed <= 0) draw();
    else raf = requestAnimationFrame(loop);
  }

  /*
   * A ResizeObserver on the canvas, not just a window listener.
   *
   * The graph panel is the one region that absorbs slack, so its height changes
   * whenever anything else in the column changes height — which is exactly what
   * happens when three tasks go stale and the ledger rows grow to hold their
   * reasons. No window resize fires for that. The canvas kept its old drawing
   * buffer, the browser stretched it to the new box, and the backdrop visibly
   * snapped on the one frame the whole demo is built around.
   */
  const onResize = (): void => draw();
  window.addEventListener("resize", onResize);

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => draw());
  observer?.observe(canvas);

  run();

  return {
    set(next) {
      const wasStill = state.speed <= 0;
      if (next.tint !== undefined) state.tint = next.tint;
      if (next.alert !== undefined) state.alert = next.alert;
      if (next.speed !== undefined) state.speed = next.speed;
      if (wasStill !== state.speed <= 0) run();
      else draw();
    },
    stats: () => ({ frames, animating: raf !== 0, speed: state.speed, alert: state.alert }),
    destroy() {
      dead = true;
      stop();
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      /*
       * Deliberately does NOT call WEBGL_lose_context.loseContext().
       *
       * That looks like good hygiene and is a trap here. Losing the context
       * poisons the <canvas> ELEMENT, not just this handle: a later
       * getContext("webgl") on the same element returns the same lost context,
       * which accepts every call and draws nothing. React StrictMode
       * double-invokes effects in development — mount, clean up, mount again on
       * the very same node — so the backdrop came back permanently blank with no
       * error anywhere. It was found by reading pixels back, not by looking,
       * because "very subtle shader" and "no shader at all" look identical.
       *
       * The context is released with the canvas when React drops the node.
       */
    },
  };
}
