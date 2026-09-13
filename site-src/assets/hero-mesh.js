(() => {
  const canvas = document.querySelector('canvas[data-hero-mesh]');
  if (!canvas) return;

  // "Mesh drift" — supplied by the user from the 21st.dev Shader Builder.
  // The fragment shader below is unchanged apart from normalizing the pasted
  // Markdown escapes. Only the palette uniforms differ from the supplied recipe.
  const fragmentSource = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec3 u_colors[8];
// Seven packed vectors + eight colour vectors = 15 fragment uniform vectors,
// one below WebGL1's guaranteed minimum. Macros preserve the public u_* API.
uniform vec4 u_scene;      // resolution.xy, time, colour count
uniform vec4 u_shape;      // scale, intensity, paramA, warp
uniform vec4 u_surface;    // detail, contrast, brightness, saturation
uniform vec4 u_finish;     // hue, vignette, blur, grain
uniform vec4 u_transform;  // seed, rotation, drift, OKLab toggle
uniform vec4 u_space;      // offset.xy, pointer.xy
uniform vec4 u_cursor;

#define u_resolution u_scene.xy
#define u_time u_scene.z
#define u_colorCount u_scene.w
#define u_scale u_shape.x
#define u_intensity u_shape.y
#define u_paramA u_shape.z
#define u_warp u_shape.w
#define u_detail u_surface.x
#define u_contrast u_surface.y
#define u_brightness u_surface.z
#define u_saturation u_surface.w
#define u_hue u_finish.x
#define u_vignette u_finish.y
#define u_blur u_finish.z
#define u_grain u_finish.w
#ifdef GL_FRAGMENT_PRECISION_HIGH
#define u_seed u_transform.x
#else
// Keep hash inputs inside mediump's guaranteed ±2^14 range.
#define u_seed mod(u_transform.x, 31.0)
#endif
#define u_rotate u_transform.y
#define u_drift u_transform.z
#define u_oklab u_transform.w
#define u_offset u_space.xy
#define u_mouse u_space.zw
#define u_cursorPresence u_cursor.x
#define u_cursorEffect u_cursor.y
#define u_cursorStrength u_cursor.z
#define u_cursorRadius u_cursor.w

float hash21(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

// Even, un-structured white noise for film grain (Dave Hoskins hash12). The
// multiply hash above is fine for value noise but shows a faint axis-aligned
// mesh at integer fragment coords, which reads as a net over flat areas.
float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  float n = sin(dot(p, vec2(41.0, 289.0)));
  return fract(vec2(15731.743, 7892.321) * n);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.0, 9.2);
    a *= 0.5;
  }
  return v;
}

// --- OKLab colour mixing (perceptual), gated by u_oklab -----------------------
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)),
    step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  // max() guards the sRGB branch: out-of-gamut OKLab interpolations can send a
  // channel negative, and pow(negative, …) is NaN which mix()/step() would
  // then propagate. The linear branch clips such channels to 0 downstream.
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(0.0031308, c));
}
vec3 linToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0);
  m = pow(max(m, 0.0), 1.0 / 3.0);
  s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 oklabToLin(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 mixColour(vec3 a, vec3 b, float t) {
  if (u_oklab > 0.5) {
    vec3 la = linToOklab(srgbToLinear(a));
    vec3 lb = linToOklab(srgbToLinear(b));
    return clamp(linearToSrgb(oklabToLin(mix(la, lb, t))), 0.0, 1.0);
  }
  return mix(a, b, t);
}

// Mix through the recipe colours; x is clamped to 0..1. WebGL1 forbids
// dynamic uniform indexing in fragment shaders, hence the constant loop.
vec3 palette(float x) {
  float n = max(u_colorCount - 1.0, 1.0);
  float f = clamp(x, 0.0, 1.0) * n;
  vec3 col = u_colors[0];
  for (int i = 0; i < 7; i++) {
    if (float(i) < n)
      col = mixColour(col, u_colors[i + 1],
        smoothstep(0.0, 1.0, clamp(f - float(i), 0.0, 1.0)));
  }
  return col;
}

vec3 hueRotate(vec3 col, float a) {
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211,
                        0.587, -0.274, -0.523,
                        0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0,
                        0.956, -0.272, -1.106,
                        0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * col;
  float ca = cos(a), sa = sin(a);
  yiq = vec3(yiq.x, yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca);
  return toRGB * yiq;
}

vec3 shade(vec2 uv, vec2 p, float t) {
  vec3 acc = u_colors[0] * 0.15;
  float total = 0.15;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= u_colorCount) break;
    float fi = float(i);
    vec2 c = vec2(
      sin(t * (0.21 + fi * 0.071) + fi * 2.4 + u_seed),
      cos(t * (0.17 + fi * 0.093) + fi * 1.7)) * (0.45 + u_intensity * 0.35);
    float w = exp(-dot(p - c, p - c) * 6.0);
    acc += u_colors[i] * w;
    total += w;
  }
  return acc / total;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 screenUv = uv;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
    / min(u_resolution.x, u_resolution.y);
  float cursorMask = 0.0;

  // Cursor modes 1–3 are local distortions. Push shifts the same screen-space
  // coordinates before field transforms, so Zoom/Rotate don't change its feel.
  if (u_cursorPresence > 0.001) {
    // u_mouse is normalized to -1..1 in canvas space. Convert it to the same
    // aspect-corrected screen space as p so effects stay under the cursor.
    vec2 cursor = (0.5 * u_mouse * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
    vec2 cursorDelta = p - cursor;
    if (u_cursorEffect < 0.5) {
      p += cursor * u_cursorPresence * u_cursorStrength * 0.55;
    } else {
      float cursorDistance = length(cursorDelta);
      vec2 cursorDirection = cursorDelta / max(cursorDistance, 0.0001);
      cursorMask = u_cursorPresence
        * (1.0 - smoothstep(0.0, u_cursorRadius, cursorDistance));
      if (u_cursorEffect < 1.5) {
        p -= cursorDirection * cursorMask * u_cursorStrength * 0.24;
      } else if (u_cursorEffect < 2.5) {
        float cursorAngle = cursorMask * u_cursorStrength * 2.2;
        float cc = cos(cursorAngle), cs = sin(cursorAngle);
        p = cursor + mat2(cc, -cs, cs, cc) * cursorDelta;
      } else if (u_cursorEffect < 3.5) {
        float ripple = sin(
          cursorDistance / max(u_cursorRadius, 0.001) * 18.0 - u_time * 5.0);
        p -= cursorDirection * ripple * cursorMask * u_cursorStrength * 0.07;
      }
    }
  }

  // Keep presets that read uv (rather than p) in the same warped space.
  uv = p * min(u_resolution.x, u_resolution.y) / u_resolution.xy + 0.5;
  p *= u_scale;
  // Field transform: rotate, pan, pointer push, slow drift.
  if (abs(u_rotate) > 0.0001) {
    float cr = cos(u_rotate), sr = sin(u_rotate);
    p = mat2(cr, -sr, sr, cr) * p;
  }
  p += u_offset;
  if (u_drift > 0.0001)
    p += u_drift * vec2(sin(u_time * 0.31), cos(u_time * 0.23));
  // Organic domain warp.
  if (u_warp > 0.0) {
    p += u_warp * (vec2(
      fbm(p * u_detail + u_seed),
      fbm(p * u_detail + vec2(5.2, 1.3))) - 0.5);
  }
  // Shade, with an optional soft 5-tap blur.
  vec3 col;
  if (u_blur > 0.0) {
    float e = u_blur;
    float pe = e * u_scale;
    vec2 uvE = vec2(e) * min(u_resolution.x, u_resolution.y) / u_resolution.xy;
    col  = shade(uv, p, u_time) * 0.36;
    col += shade(uv + vec2(uvE.x, 0.0), p + vec2(pe, 0.0), u_time) * 0.16;
    col += shade(uv - vec2(uvE.x, 0.0), p - vec2(pe, 0.0), u_time) * 0.16;
    col += shade(uv + vec2(0.0, uvE.y), p + vec2(0.0, pe), u_time) * 0.16;
    col += shade(uv - vec2(0.0, uvE.y), p - vec2(0.0, pe), u_time) * 0.16;
  } else {
    col = shade(uv, p, u_time);
  }
  // Post: contrast, saturation, hue, brightness, vignette, grain.
  if (abs(u_contrast - 1.0) > 0.0001)
    col = (col - 0.5) * u_contrast + 0.5;
  if (abs(u_saturation - 1.0) > 0.0001) {
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, u_saturation);
  }
  if (abs(u_hue) > 0.0001)
    col = hueRotate(col, u_hue);
  if (abs(u_brightness) > 0.0001)
    col += u_brightness;
  if (u_vignette > 0.0001) {
    float vd = length(screenUv - 0.5) * 1.41421356;
    col *= 1.0 - u_vignette * smoothstep(0.35, 1.0, vd);
  }
  if (u_cursorPresence > 0.001 && u_cursorEffect > 3.5)
    col += (vec3(0.18) + col * 0.12) * cursorMask * u_cursorStrength;
  if (u_grain > 0.0001)
    col += (grainHash(
      gl_FragCoord.xy + vec2(u_seed * 17.0, u_seed * 31.0)) - 0.5) * u_grain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

  const vertexSource = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const hero = canvas.closest('.hero') || canvas;
  const interval = 1000 / 30;
  let gl, program, buffer, scene;
  let frame = 0, elapsed = 0, clock = null, lastDraw = -Infinity;
  let lost = false, failed = false, pageActive = true;
  const inViewport = () => {
    const rect = hero.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  };
  let visible = inViewport();
  canvas.dataset.meshState = 'paused';

  const advance = now => {
    if (clock !== null) elapsed += Math.max(0, now - clock) / 1000;
    clock = now;
  };
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (clock !== null) advance(performance.now());
    clock = null;
  };
  const release = () => {
    if (gl && !gl.isContextLost()) {
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
    }
    buffer = program = scene = null;
  };
  const fallback = () => {
    stop();
    failed = true;
    release();
    canvas.dataset.meshState = 'fallback';
  };
  const resize = () => {
    if (!gl || lost || failed) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  const initialize = () => {
    const shaders = [];
    try {
      gl = gl || canvas.getContext('webgl', {
        alpha: false, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, powerPreference: 'low-power',
      });
      if (!gl || gl.isContextLost()) throw new Error('WebGL unavailable');
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Shader unavailable');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader failed');
        return shader;
      };
      program = gl.createProgram();
      if (!program) throw new Error('Program unavailable');
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program failed');
      gl.useProgram(program);
      buffer = gl.createBuffer();
      if (!buffer) throw new Error('Buffer unavailable');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      // One triangle covers the entire drawing buffer, with no shared edge.
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'a_position');
      if (position < 0) throw new Error('Position unavailable');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const colors = ['DED2FA', 'E8DDFB', 'F5EFFF', 'FFFFFF', 'FFFFFF', 'FFFFFF', 'FFFFFF', 'FFFFFF'];
      gl.uniform3fv(gl.getUniformLocation(program, 'u_colors[0]'), new Float32Array(colors.flatMap(color =>
        [0, 2, 4].map(index => parseInt(color.slice(index, index + 2), 16) / 255))));
      scene = gl.getUniformLocation(program, 'u_scene');
      const recipe = {
        u_shape: [1.16, .34, .50, 0],
        u_surface: [2.40, 1.16, 0, 1],
        u_finish: [0, 0, 0, .09],
        u_transform: [1453, 0, 0, 0],
        u_space: [0, 0, 0, 0],
        u_cursor: [0, 2, .65, .46],
      };
      Object.entries(recipe).forEach(([name, values]) =>
        gl.uniform4fv(gl.getUniformLocation(program, name), values));
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      resize();
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL initialization failed');
      return true;
    } catch {
      fallback();
      return false;
    } finally {
      if (gl && !gl.isContextLost()) shaders.forEach(shader => gl.deleteShader(shader));
    }
  };
  const draw = seconds => {
    if (!program || lost || failed) return false;
    try {
      resize();
      gl.uniform4f(scene, canvas.width, canvas.height, seconds * .73, 4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    } catch {
      fallback();
      return false;
    }
  };
  const available = () => pageActive && !document.hidden && visible && !lost && !failed;
  const tick = now => {
    frame = 0;
    if (!available() || motion.matches) { synchronize(); return; }
    advance(now);
    if (now - lastDraw >= interval) {
      if (!draw(elapsed)) return;
      lastDraw = now;
      canvas.dataset.meshState = 'running';
    }
    frame = requestAnimationFrame(tick);
  };
  const synchronize = () => {
    if (lost || failed || !available() || motion.matches) {
      stop();
      if (lost) canvas.dataset.meshState = 'lost';
      else if (failed) canvas.dataset.meshState = 'fallback';
      else if (!available()) canvas.dataset.meshState = 'paused';
      else if (draw(0)) canvas.dataset.meshState = 'static';
      return;
    }
    if (!frame) {
      // Time advances only while the hero is visible and motion is allowed.
      clock = performance.now();
      lastDraw = -Infinity;
      frame = requestAnimationFrame(tick);
    }
  };

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    lost = true;
    stop();
    release();
    canvas.dataset.meshState = 'lost';
  });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = failed = false;
    if (initialize()) synchronize();
  });
  document.addEventListener('visibilitychange', synchronize);
  motion.addEventListener('change', synchronize);
  addEventListener('pagehide', () => { pageActive = false; synchronize(); });
  addEventListener('pageshow', () => {
    pageActive = true;
    visible = inViewport();
    synchronize();
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      synchronize();
    }).observe(hero);
  } else {
    addEventListener('scroll', () => { visible = inViewport(); synchronize(); }, {passive: true});
  }
  if ('ResizeObserver' in window) {
    new ResizeObserver(synchronize).observe(canvas);
  }
  addEventListener('resize', () => { visible = inViewport(); synchronize(); }, {passive: true});
  if (initialize()) synchronize();
})();
