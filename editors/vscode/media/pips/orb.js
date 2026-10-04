/* DGC orb refinement, requested 2026-10-01.
 * Dependency-free adapter of characters/orb-study. Paper-derived WebGL mesh colours
 * and MIT AIMO-derived eye path construction (see AIMO-LICENSE); selected color families and silhouettes retained.
 * No DOM work on import. Keep copies in consumers byte-for-byte identical.
 */
(() => {
  'use strict';
const PRESETS = {
  blue: {
    gradient:"radial-gradient(circle at 50% 45%, #0d4d9a 0%, #3d7dd8 40%, #6fb3ff 68%, #e0eeff 100%)",
    boxShadow:"0 0 4px 0px rgba(20,102,216,.35), 0 0 16px 6px rgba(20,102,216,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #d4ecff 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  orange: {
    gradient:"radial-gradient(circle at 50% 45%, #a63e10 0%, #e27a2a 40%, #ffb46a 68%, #ffe8cc 100%)",
    boxShadow:"0 0 4px 0px rgba(232,100,0,.35), 0 0 16px 6px rgba(232,100,0,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #ffd9b8 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  red: {
    gradient:"radial-gradient(circle at 50% 45%, #a60033 0%, #e74668 40%, #ff8aaa 68%, #ffd6e8 100%)",
    boxShadow:"0 0 4px 0px rgba(223,24,92,.35), 0 0 16px 6px rgba(223,24,92,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #ffcde4 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  green: {
    gradient:"radial-gradient(circle at 50% 45%, #0d6632 0%, #2a9d5f 40%, #6dd187 68%, #d1fadd 100%)",
    boxShadow:"0 0 4px 0px rgba(12,168,82,.35), 0 0 16px 6px rgba(12,168,82,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #c5f5d8 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  purple: {
    gradient:"radial-gradient(circle at 50% 45%, #4a0080 0%, #8b3fd1 40%, #c896ff 68%, #e8d4ff 100%)",
    boxShadow:"0 0 4px 0px rgba(110,46,224,.35), 0 0 16px 6px rgba(110,46,224,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #e0c9ff 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  yellow: {
    gradient:"radial-gradient(circle at 50% 45%, #8a5500 0%, #d4a000 40%, #ffc93a 68%, #fff5cc 100%)",
    boxShadow:"0 0 4px 0px rgba(214,142,0,.35), 0 0 16px 6px rgba(214,142,0,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #fff0a8 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  cyan: {
    gradient:"radial-gradient(circle at 50% 45%, #003d66 0%, #0a8fb5 40%, #5dd4ff 68%, #cdf5ff 100%)",
    boxShadow:"0 0 4px 0px rgba(10,143,181,.35), 0 0 16px 6px rgba(10,143,181,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #d0f0ff 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  pink: {
    gradient:"radial-gradient(circle at 50% 45%, #7a0055 0%, #d63384 40%, #ff6bb3 68%, #ffe5f5 100%)",
    boxShadow:"0 0 4px 0px rgba(214,51,132,.35), 0 0 16px 6px rgba(214,51,132,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #ffd6ed 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  indigo: {
    gradient:"radial-gradient(circle at 50% 45%, #2d157a 0%, #4f46e5 40%, #8b7eff 68%, #ddd6ff 100%)",
    boxShadow:"0 0 4px 0px rgba(79,70,229,.35), 0 0 16px 6px rgba(79,70,229,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #e0d9ff 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  lime: {
    gradient:"radial-gradient(circle at 50% 45%, #4a5910 0%, #84cc16 40%, #bef264 68%, #ecfccf 100%)",
    boxShadow:"0 0 4px 0px rgba(132,204,22,.35), 0 0 16px 6px rgba(132,204,22,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #f7fee8 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  turquoise: {
    gradient:"radial-gradient(circle at 50% 45%, #1a5555 0%, #0d9488 40%, #2dd4bf 68%, #ccfbf1 100%)",
    boxShadow:"0 0 4px 0px rgba(13,148,136,.35), 0 0 16px 6px rgba(13,148,136,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #c0fdf5 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
  violet: {
    gradient:"radial-gradient(circle at 50% 45%, #4a2a7a 0%, #a855f7 40%, #d8b4fe 68%, #f3e8ff 100%)",
    boxShadow:"0 0 4px 0px rgba(168,85,247,.35), 0 0 16px 6px rgba(168,85,247,.18), inset 0 0 0 1px rgba(255,255,255,.05)",
    iris:"linear-gradient(135deg, #ffffff 0%, #ede9fe 100%)",
    shine:"radial-gradient(ellipse at 30% 24%, rgba(255,255,255,.75) 0%, rgba(255,255,255,.1) 50%, transparent 70%)",
  },
};

const shapeRadius={core:'50%',scout:'46% 49% 48% 47%',lens:'43% 44% 45% 44%',patch:'42% 44% 42% 44%',rook:'44%',pulse:'50%',lock:'40% 42% 43% 41%',quill:'48% 43% 49% 44%'};
// Original silhouettes drawn for this study; no AIMO shape paths are reused.
const silhouettes={
 scout:'M .5 .025 C .63 .23 .95 .31 .95 .57 C .95 .83 .75 .97 .5 .97 C .25 .97 .05 .82 .05 .57 C .05 .32 .38 .22 .5 .025 Z',
 lens:'M .5 .02 C .75 .02 .89 .22 .89 .5 C .89 .78 .75 .98 .5 .98 C .25 .98 .11 .78 .11 .5 C .11 .22 .25 .02 .5 .02 Z',
 patch:'M .28 .04 H .72 Q .96 .04 .96 .28 V .72 Q .96 .96 .72 .96 H .28 Q .04 .96 .04 .72 V .28 Q .04 .04 .28 .04 Z',
 rook:'M .39 .09 Q .5 -.015 .61 .09 L .91 .39 Q 1.015 .5 .91 .61 L .61 .91 Q .5 1.015 .39 .91 L .09 .61 Q -.015 .5 .09 .39 Z',
 pulse:'M .5 .11 C .75 -.035 1.035 .25 .89 .5 C 1.035 .75 .75 1.035 .5 .89 C .25 1.035 -.035 .75 .11 .5 C -.035 .25 .25 -.035 .5 .11 Z',
 lock:'M .4 .055 Q .5 0 .6 .055 L .85 .195 Q .945 .25 .945 .36 V .64 Q .945 .75 .85 .805 L .6 .945 Q .5 1 .4 .945 L .15 .805 Q .055 .75 .055 .64 V .36 Q .055 .25 .15 .195 Z',
 quill:'M .5 .95 C .42 .9 .025 .63 .055 .30 C .08 .035 .365 .015 .5 .22 C .635 .015 .92 .035 .945 .30 C .975 .63 .58 .9 .5 .95 Z'
};

// Eye path construction adapted from AIMO's MIT-licensed free renderer.
// Copyright (c) 2026 Nazar Melnyk (nrmk.dev). See AIMO-LICENSE.
// Source commit: b1bcc9bb17a2bcfcffeebd67f8e3d216cea182ad.
// Expression poses are DGC originals, not AIMO Pro poses. Upright eyes have
// exactly zero curve; expression/rotation never bends a straight capsule.
const eyePath = (e) => `M0 ${(-e.len).toFixed(1)} Q${e.curve.toFixed(1)} 0 0 ${e.len.toFixed(1)}`;
const eye = (x,y=47,len=11,w=11,rot=0,curve=0) => ({x,y,len,w,rot,curve});
function faceFor(pip, state) {
  const index=Math.max(0,['core','scout','lens','patch','rook','pulse','lock','quill'].indexOf(pip.id));
  // Small changes in length supply identity without the rejected bent strokes.
  const lengths=[11,12,10.5,11.5,10.5,12,10.5,11.5];
  let left=eye(34,47,lengths[index]),right=eye(66,47,lengths[index]);
  switch(state){
    case 'listening': left=eye(34,46,14,12);right=eye(66,46,14,12);break;
    case 'thinking': left=eye(34,49,5,11);right=eye(66,44,12,11,7);break;
    case 'working': left=eye(36,47,8,11);right=eye(67,47,8,11);break;
    case 'waiting_approval': left=eye(34,44,12,12,-6);right=eye(66,49,7,12);break;
    case 'success': left=eye(34,47,8.5,6.5,90,-14);right=eye(66,47,8.5,6.5,90,-14);break;
    case 'failure': left=eye(34,48,7,10,-13);right=eye(66,48,7,10,13);break;
    case 'offline': left=eye(34,49,7,5,90);right=eye(66,49,7,5,90);break;
  }
  return {left:{...left,path:eyePath(left)},right:{...right,path:eyePath(right)}};
}

/* Static Mesh Gradient — user-supplied 21st.dev Shader Builder recipe.
 * Adapted from Paper Shaders, https://shaders.paper.design/static-mesh-gradient
 * Apache-2.0, https://github.com/paper-design/shaders (see PAPER-SHADERS-LICENSE).
 * DGC modifications: lighter Pip palettes, slow uniform-driven field translation,
 * and a shared WebGL1 renderer with visibility / motion / disposal handling.
 * Fragment algorithm retained; no Paper runtime or graphics library is required.
 */
const MESH_FRAGMENT = String.raw`
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 u_colors[8];
uniform vec4 u_scene;
uniform vec4 u_shape;
uniform vec4 u_surface;
uniform vec4 u_finish;
uniform vec4 u_transform;
uniform vec4 u_space;
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
return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
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
vec3 srgbToLinear(vec3 c) {
return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 linToOklab(vec3 c) {
float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
l = pow(max(l, 0.0), 1.0 / 3.0);
m = pow(max(m, 0.0), 1.0 / 3.0);
s = pow(max(s, 0.0), 1.0 / 3.0);
return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 oklabToLin(vec3 c) {
float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
l = l * l * l; m = m * m * m; s = s * s * s;
return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
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
vec3 palette(float x) {
float n = max(u_colorCount - 1.0, 1.0);
float f = clamp(x, 0.0, 1.0) * n;
vec3 col = u_colors[0];
for (int i = 0; i < 7; i++) {
if (float(i) < n)
col = mixColour(col, u_colors[i + 1], smoothstep(0.0, 1.0, clamp(f - float(i), 0.0, 1.0)));
}
return col;
}
vec3 hueRotate(vec3 col, float a) {
const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
vec3 yiq = toYIQ * col;
float ca = cos(a), sa = sin(a);
yiq = vec3(yiq.x, yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca);
return toRGB * yiq;
}
vec3 shade(vec2 uv, vec2 p, float t) {
vec3 color = u_colors[0] * 0.2;
float weight = 0.2;
for (int i = 0; i < 8; i++) {
if (float(i) >= u_colorCount) break;
float fi = float(i);
vec2 center = (hash22(vec2(fi, u_seed)) - 0.5) * (0.7 + u_intensity * 1.4);
float influence = exp(-dot(p - center, p - center) * mix(13.0, 2.0, u_paramA));
color += u_colors[i] * influence;
weight += influence;
}
return color / weight;
}
void main() {
vec2 uv = gl_FragCoord.xy / u_resolution.xy;
vec2 screenUv = uv;
vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
float cursorMask = 0.0;
if (u_cursorPresence > 0.001) {
vec2 cursor = (0.5 * u_mouse * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
vec2 cursorDelta = p - cursor;
if (u_cursorEffect < 0.5) {
p += cursor * u_cursorPresence * u_cursorStrength * 0.55;
} else {
float cursorDistance = length(cursorDelta);
vec2 cursorDirection = cursorDelta / max(cursorDistance, 0.0001);
cursorMask = u_cursorPresence * (1.0 - smoothstep(0.0, u_cursorRadius, cursorDistance));
if (u_cursorEffect < 1.5) {
p -= cursorDirection * cursorMask * u_cursorStrength * 0.24;
} else if (u_cursorEffect < 2.5) {
float cursorAngle = cursorMask * u_cursorStrength * 2.2;
float cc = cos(cursorAngle), cs = sin(cursorAngle);
p = cursor + mat2(cc, -cs, cs, cc) * cursorDelta;
} else if (u_cursorEffect < 3.5) {
float ripple = sin(cursorDistance / max(u_cursorRadius, 0.001) * 18.0 - u_time * 5.0);
p -= cursorDirection * ripple * cursorMask * u_cursorStrength * 0.07;
}
}
}
uv = p * min(u_resolution.x, u_resolution.y) / u_resolution.xy + 0.5;
p *= u_scale;
if (abs(u_rotate) > 0.0001) {
float cr = cos(u_rotate), sr = sin(u_rotate);
p = mat2(cr, -sr, sr, cr) * p;
}
p += u_offset;
if (u_drift > 0.0001) p += u_drift * vec2(sin(u_time * 0.31), cos(u_time * 0.23));
if (u_warp > 0.0) {
p += u_warp * (vec2(fbm(p * u_detail + u_seed), fbm(p * u_detail + vec2(5.2, 1.3))) - 0.5);
}
vec3 col;
if (u_blur > 0.0) {
float e = u_blur;
float pe = e * u_scale;
vec2 uvE = vec2(e) * min(u_resolution.x, u_resolution.y) / u_resolution.xy;
col = shade(uv, p, u_time) * 0.36;
col += shade(uv + vec2(uvE.x, 0.0), p + vec2(pe, 0.0), u_time) * 0.16;
col += shade(uv - vec2(uvE.x, 0.0), p - vec2(pe, 0.0), u_time) * 0.16;
col += shade(uv + vec2(0.0, uvE.y), p + vec2(0.0, pe), u_time) * 0.16;
col += shade(uv - vec2(0.0, uvE.y), p - vec2(0.0, pe), u_time) * 0.16;
} else {
col = shade(uv, p, u_time);
}
if (abs(u_contrast - 1.0) > 0.0001) col = (col - 0.5) * u_contrast + 0.5;
if (abs(u_saturation - 1.0) > 0.0001) {
float luma = dot(col, vec3(0.299, 0.587, 0.114));
col = mix(vec3(luma), col, u_saturation);
}
if (abs(u_hue) > 0.0001) col = hueRotate(col, u_hue);
if (abs(u_brightness) > 0.0001) col += u_brightness;
if (u_vignette > 0.0001) {
float vd = length(screenUv - 0.5) * 1.41421356;
col *= 1.0 - u_vignette * smoothstep(0.35, 1.0, vd);
}
if (u_cursorPresence > 0.001 && u_cursorEffect > 3.5) col += (vec3(0.18) + col * 0.12) * cursorMask * u_cursorStrength;
if (u_grain > 0.0001) col += (grainHash(gl_FragCoord.xy + vec2(u_seed * 17.0, u_seed * 31.0)) - 0.5) * u_grain;
gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
const MESH_COLORS = Object.freeze({
 purple:['#6d5597','#866ab2','#b697db','#b39ace'],
 green:['#416e60','#689786','#a0c8b1','#b4d5bb'],
 blue:['#486b99','#7095c2','#9bbfe6','#b2cbe6'],
 orange:['#a16d50','#c4926e','#e2b894','#ebcbaa'],
 indigo:['#626595','#8388b8','#abb0d9','#c1c3e2'],
 yellow:['#9a824c','#bca56f','#dec992','#e9d9ae'],
 turquoise:['#477e80','#70a5a7','#9cccc9','#b6d9d4'],
 pink:['#956480','#b78aa4','#dbb4ca','#e6c6d8'],
});
const meshDocuments=new WeakMap();
function createMeshRenderer(doc){
 const win=doc.defaultView, canvas=doc.createElement('canvas');
 canvas.width=640;canvas.height=640;
 if(!win||typeof win.matchMedia!=='function'||typeof win.requestAnimationFrame!=='function'||typeof win.WebGLRenderingContext!=='function')return null;
 let gl,program,buffer,vertex,fragment;
 const items=new Map();let raf=0,last=0,disposed=false,frameAt=-1,contextLost=false;
 const reduced=win.matchMedia('(prefers-reduced-motion: reduce)');
 const stop=()=>{if(raf)win.cancelAnimationFrame(raf);raf=0;last=0;};
 function compile(kind,source){const s=gl.createShader(kind);if(!s)throw Error('WebGL shader allocation failed');gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(s);gl.deleteShader(s);throw Error(message||'Pip shader failed');}return s;}
 let uniforms;
 try{
  gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
  if(!gl)return null;
  vertex=compile(gl.VERTEX_SHADER,'attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}');
  fragment=compile(gl.FRAGMENT_SHADER,MESH_FRAGMENT);
  program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const pos=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
  uniforms=Object.fromEntries(['colors[0]','scene','shape','surface','finish','transform','space','cursor'].map(name=>[name,gl.getUniformLocation(program,'u_'+name)]));
 }catch(error){if(program)gl.deleteProgram(program);if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);if(buffer)gl.deleteBuffer(buffer);gl?.getExtension('WEBGL_lose_context')?.loseContext();return null;}
 const paused=item=>reduced.matches||!!item.el.closest('[data-paused="true"],[data-motion-paused="true"],[data-pip-motion="paused"],.motion-paused,.motion-offscreen')||item.el.closest('[data-state]')?.dataset.state==='offline';
 function draw(item){
  const width=item.el.clientWidth,height=item.el.clientHeight;if(!width||!height)return;
  const dpr=Math.min(win.devicePixelRatio||1,2),w=Math.max(1,Math.min(640,Math.round(width*dpr))),h=Math.max(1,Math.min(640,Math.round(height*dpr)));
  if(item.el.width!==w||item.el.height!==h){item.el.width=w;item.el.height=h;}
  gl.viewport(0,0,w,h);gl.uniform3fv(uniforms['colors[0]'],item.colors);
  gl.uniform4f(uniforms.scene,w,h,item.time*.27,4);
  gl.uniform4f(uniforms.shape,1.26,.35,.28,0);gl.uniform4f(uniforms.surface,1.82,1,0,1);
  // Clear-glass refinement: keep only a trace of grain rather than a frosted texture.
  gl.uniform4f(uniforms.finish,0,0,0,.012);
  // The supplied shade() ignores time. .16 drift moves the field slowly.
  // Other deliberate changes are the light Pip palettes and reduced glass grain.
  gl.uniform4f(uniforms.transform,1,0,.16,1);
  gl.uniform4f(uniforms.space,0,0,item.pointer[0],item.pointer[1]);
  gl.uniform4f(uniforms.cursor,paused(item)?0:item.presence,2,.27,.73);
  gl.drawArrays(gl.TRIANGLES,0,3);item.ctx.drawImage(canvas,0,canvas.height-h,w,h,0,0,w,h);
  item.el.dataset.mesh='ready';item.dirty=false;
 }
 function tick(now){
  raf=0;if(disposed||contextLost||doc.hidden){last=0;return;}
  const dt=last?Math.min((now-last)/1000,.1):0;last=now;
  const shouldDraw=frameAt<0||now-frameAt>=1000/24;if(shouldDraw)frameAt=now;
  let animate=false;
  for(const item of items.values()){
   if(!item.el.isConnected){remove(item.el);continue;}
   if(!item.visible)continue;
   const frozen=paused(item);if(!frozen){item.time+=dt;animate=true;}
   if(item.dirty||(!frozen&&shouldDraw))draw(item);
  }
  if(animate)raf=win.requestAnimationFrame(tick);else last=0;
 }
 function wake(){if(!raf&&!disposed&&!contextLost&&!doc.hidden)raf=win.requestAnimationFrame(tick);}
 const intersection=typeof win.IntersectionObserver==='function'?new win.IntersectionObserver(entries=>{for(const e of entries){const item=items.get(e.target);if(item){item.visible=e.isIntersecting;item.dirty=true;}}wake();}):null;
 const resize=typeof win.ResizeObserver==='function'?new win.ResizeObserver(entries=>{for(const e of entries){const item=items.get(e.target);if(item)item.dirty=true;}wake();}):null;
 const mutation=new win.MutationObserver(()=>{for(const item of items.values())item.dirty=true;wake();});
 function add(el){
  if(items.has(el))return;const palette=MESH_COLORS[el.dataset.meshPalette];if(!palette)return;
  let ctx;try{ctx=el.getContext('2d',{alpha:false});}catch{return;}if(!ctx)return;
  const colors=new Float32Array(24);palette.forEach((hex,i)=>{for(let c=0;c<3;c++)colors[i*3+c]=parseInt(hex.slice(1+c*2,3+c*2),16)/255;});
  const item={el,ctx,colors,time:0,pointer:[0,0],presence:0,dirty:true,visible:!intersection};
  const target=el.parentElement;
  item.move=e=>{const r=el.getBoundingClientRect();item.pointer=[2*(e.clientX-r.left)/r.width-1,1-2*(e.clientY-r.top)/r.height];item.presence=1;item.dirty=true;wake();};
  item.leave=()=>{item.presence=0;item.dirty=true;wake();};item.target=target;
  target.addEventListener('pointermove',item.move);target.addEventListener('pointerleave',item.leave);
  items.set(el,item);intersection?.observe(el);resize?.observe(el);
  // Each root is observed once. Includes ancestor pause flags inside webviews.
  const root=el.getRootNode();mutation.observe(root,{subtree:true,attributes:true,attributeFilter:['data-paused','data-motion-paused','data-pip-motion','data-state','class']});
  wake();
 }
 function remove(el){const item=items.get(el);if(!item)return;intersection?.unobserve(el);resize?.unobserve(el);item.target.removeEventListener('pointermove',item.move);item.target.removeEventListener('pointerleave',item.leave);items.delete(el);}
 function visibility(){if(doc.hidden)stop();else wake();}
 function motion(){for(const item of items.values())item.dirty=true;wake();}
 function lose(e){e.preventDefault();contextLost=true;stop();for(const item of items.values()){item.el.dataset.mesh='fallback';item.ctx.clearRect(0,0,item.el.width,item.el.height);}}
 canvas.addEventListener('webglcontextlost',lose);
 doc.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',motion);
 function dispose(){if(disposed)return;disposed=true;stop();for(const el of items.keys())remove(el);intersection?.disconnect();resize?.disconnect();mutation.disconnect();doc.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',motion);win.removeEventListener('pagehide',dispose);canvas.removeEventListener('webglcontextlost',lose);gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);gl.getExtension('WEBGL_lose_context')?.loseContext();meshDocuments.delete(doc);}
 win.addEventListener('pagehide',dispose,{once:true});
 return {add,remove,wake,prune(){for(const el of items.keys())if(!el.isConnected)remove(el);},empty(){return items.size===0;},dispose};
}
function mountMesh(root){
 const doc=root?.ownerDocument||root;if(!doc?.defaultView)return ()=>{};
 let manager=meshDocuments.get(doc);if(!manager){manager=createMeshRenderer(doc);if(!manager)return ()=>{};meshDocuments.set(doc,manager);}
 manager.prune();const nodes=[...(root.matches?.('canvas[data-mesh-palette]')?[root]:root.querySelectorAll('canvas[data-mesh-palette]'))];
 for(const node of nodes)manager.add(node);manager.wake();
 return ()=>{for(const node of nodes)manager.remove(node);if(manager.empty())manager.dispose();};
}


// CSS fallback stays visible before the WebGL first frame or without WebGL.
function surfaceFor(preset, palette) {
  const [dark, mid, light, high] = MESH_COLORS[palette] || MESH_COLORS.purple;
  return {dark,mid,light,
    background:`radial-gradient(ellipse at 80% 14%, ${light}, transparent 68%), radial-gradient(ellipse at 20% 90%, ${high}, transparent 76%), linear-gradient(135deg, ${dark}, ${mid})`,
    shadow:'none'};
}

const styles=".dgc-orb{position:relative;flex:none;display:block;width:100%;aspect-ratio:1;isolation:isolate}.dgc-orb>.dgc-orb-shape-defs{width:0;height:0}.dgc-orb-body{display:block;width:100%;height:100%;position:relative;overflow:hidden;border-radius:var(--dgc-orb-radius,50%);}.dgc-orb-grain{position:absolute;inset:0;opacity:.045;mix-blend-mode:overlay;pointer-events:none}.dgc-orb-shine{position:absolute;inset:0;pointer-events:none;opacity:.32}.dgc-orb-depth{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 47%,rgba(0,0,0,.18) 0%,transparent 62%)}.dgc-orb-face{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.dgc-orb-blink{transform-box:fill-box;transform-origin:center;animation:dgc-orb-blink 5.2s ease-in-out var(--dgc-orb-delay,0s) infinite}.dgc-orb-gaze{transform-origin:50% 50%;animation:dgc-orb-gaze 9s ease-in-out var(--dgc-orb-delay,0s) infinite}.dgc-orb-original-eyes{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:var(--eye-gap,21.875%);transform:translateY(var(--eye-y,-6.25%))}.dgc-orb-original-eyes>div{width:12.5%;height:var(--eye-height,18.75%);border-radius:100px;animation:dgc-orb-blink 3.6s ease-in-out infinite}.dgc-orb-original-eyes>div+div{animation-delay:60ms}.dgc-orb[data-state=success] .dgc-orb-blink,.dgc-orb[data-state=offline] .dgc-orb-blink{animation:none}.dgc-orb[data-state=working] .dgc-orb-gaze{animation-name:dgc-orb-read;animation-duration:3.2s}.dgc-orb[data-state=offline] .dgc-orb-gaze{animation:none}.dgc-orb[data-paused=true] *{animation-play-state:paused!important}.dgc-orb[data-paused=true] .dgc-orb-body{will-change:auto}\n@keyframes dgc-orb-blink{0%,87%,96%,100%{transform:scaleY(1)}90%,93%{transform:scaleY(.08)}}@keyframes dgc-orb-gaze{0%,36%,100%{transform:translate(0,0)}45%,58%{transform:translate(2px,-1px)}68%,78%{transform:translate(-1px,0)}}@keyframes dgc-orb-read{0%,100%{transform:translate(-1px,0)}50%{transform:translate(2px,1px)}}\n\n.dgc-orb-shape-defs{position:absolute;inset:0;pointer-events:none}\n\n.dgc-orb-mesh{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0}.dgc-orb-mesh[data-mesh=ready]{opacity:1}\n.dgc-orb-face{filter:drop-shadow(0 .4px .5px #30264230)}\n\n/* Whole-character rig: the body, face and silhouette halo drift together.\n   Keep the original eyes/shapes, with a softer colour-matched bloom. */\n.dgc-orb{transform-origin:50% 58%;filter:drop-shadow(0 0 calc(.65 * var(--dgc-orb-halo-unit,1px)) var(--dgc-orb-edge,transparent)) drop-shadow(0 0 calc(1.8 * var(--dgc-orb-halo-unit,1px)) var(--dgc-orb-glow,transparent)) drop-shadow(0 0 calc(4 * var(--dgc-orb-halo-unit,1px)) var(--dgc-orb-aura,transparent));animation:dgc-orb-float var(--dgc-orb-period,5.6s) ease-in-out var(--dgc-orb-delay,0s) infinite,dgc-orb-halo 6.4s ease-in-out var(--dgc-orb-delay,0s) infinite}\n@keyframes dgc-orb-float{0%,100%{transform:translate(-.5%,.4%) rotate(-1.4deg)}25%{transform:translate(.6%,-1.3%) rotate(.25deg)}50%{transform:translate(.8%,-2.8%) rotate(1.4deg)}75%{transform:translate(-.3%,-1.2%) rotate(-.15deg)}}\n@keyframes dgc-orb-halo{0%,100%{filter:drop-shadow(0 0 calc(.65 * var(--dgc-orb-halo-unit,1px)) var(--dgc-orb-edge,transparent)) drop-shadow(0 0 calc(1.8 * var(--dgc-orb-halo-unit,1px)) var(--dgc-orb-glow,transparent)) drop-shadow(0 0 calc(4 * var(--dgc-orb-halo-unit,1px)) var(--dgc-orb-aura,transparent))}50%{filter:drop-shadow(0 0 calc(.9 * var(--dgc-orb-halo-unit,1px)) var(--dgc-orb-edge,transparent)) drop-shadow(0 0 calc(2.6 * var(--dgc-orb-halo-unit,1px)) var(--dgc-orb-glow,transparent)) drop-shadow(0 0 calc(5.8 * var(--dgc-orb-halo-unit,1px)) var(--dgc-orb-aura,transparent))}}\n.dgc-orb[data-state=listening]{animation-name:dgc-orb-listen,dgc-orb-halo}\n.dgc-orb[data-state=thinking]{animation-name:dgc-orb-think,dgc-orb-halo;animation-duration:6.2s,6.4s}\n.dgc-orb[data-state=working]{animation-name:dgc-orb-work,dgc-orb-halo;animation-duration:3.5s,6.4s}\n.dgc-orb[data-state=waiting_approval]{animation-name:dgc-orb-ask,dgc-orb-halo;animation-duration:5.8s,6.4s}\n.dgc-orb[data-state=success]{animation-name:dgc-orb-happy,dgc-orb-halo;animation-duration:3.2s,6.4s}\n.dgc-orb[data-state=failure]{animation-name:dgc-orb-worry,dgc-orb-halo;animation-duration:6.4s,6.4s}\n.dgc-orb[data-state=offline]{animation:none}\n@keyframes dgc-orb-listen{0%,100%{transform:translateY(0) rotate(-1deg)}45%,60%{transform:translateY(-2.6%) rotate(-4deg)}}\n@keyframes dgc-orb-think{0%,100%{transform:translate(-.6%,0) rotate(-2.5deg)}50%{transform:translate(.6%,-2.8%) rotate(2.5deg)}}\n@keyframes dgc-orb-work{0%,100%{transform:translateY(0) rotate(-.6deg)}50%{transform:translateY(-1.8%) rotate(.6deg)}}\n@keyframes dgc-orb-ask{0%,100%{transform:translateY(0) rotate(-1.5deg)}45%,60%{transform:translateY(-2%) rotate(2deg)}}\n@keyframes dgc-orb-happy{0%,100%{transform:translateY(0) rotate(-1deg)}20%{transform:translateY(.6%) rotate(0)}45%{transform:translateY(-4.5%) rotate(1.8deg)}70%{transform:translateY(-.5%) rotate(.3deg)}}\n@keyframes dgc-orb-worry{0%,100%{transform:translateY(0) rotate(0)}20%{transform:translateY(-.7%) rotate(-2deg)}32%{transform:translateY(-.8%) rotate(2deg)}44%{transform:translateY(-.6%) rotate(-.7deg)}60%{transform:translateY(-.8%) rotate(0)}}\n.dgc-orb[data-paused=true],[data-pip-motion=\"paused\"] .dgc-orb,[data-motion-paused=\"true\"] .dgc-orb,.motion-paused .dgc-orb,.motion-offscreen .dgc-orb{animation-play-state:paused!important}\n@media(prefers-reduced-motion:reduce){.dgc-orb{animation:none!important;transition:none!important}}\n\n/* Clear glass over our mesh: broad refraction, a slim silhouette rim, no flare. */\n.dgc-orb-glass{position:absolute;inset:0;pointer-events:none;border-radius:inherit;background:radial-gradient(ellipse at 50% 50%,transparent 44%,#ffffff18 72%,#ffffff45 100%),radial-gradient(ellipse at 27% 14%,#ffffff64 0%,#ffffff19 24%,transparent 46%),radial-gradient(ellipse at 79% 87%,#ffffff45 0%,transparent 41%),linear-gradient(148deg,#ffffff0d 8%,transparent 44%,#38244819 72%,#ffffff12 100%)}\n.dgc-orb-glass-rim{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden}\n.dgc-orb-face{z-index:2;pointer-events:none;filter:drop-shadow(0 .45px .3px #271e4233)}\n.dgc-orb-face [data-eye]{transform-box:view-box;transform-origin:0 0}\n.dgc-orb-original-eyes{z-index:2;pointer-events:none}.dgc-orb-original-eyes>div{background:#fff}\n/* Blink each local eye around its own centre. The whole rig moves together;\n   local eye translation adds a small gaze without changing the silhouette. */\n.dgc-orb-blink{transform-box:fill-box;transform-origin:center;animation-duration:4.9s}\n@keyframes dgc-orb-blink{0%,91%,97%,100%{transform:scaleY(1)}93.5%,94.5%{transform:scaleY(.055)}}\n\n@media(prefers-reduced-motion:reduce){.dgc-orb *{animation:none!important;transition:none!important}}\n\n[data-pip-motion=\"paused\"] .dgc-orb *,.motion-paused .dgc-orb *,.motion-offscreen .dgc-orb *{animation-play-state:paused!important}.dgc-orb[data-paused=\"true\"] *{animation-play-state:paused!important}@media(prefers-reduced-motion:reduce){.dgc-orb *{animation:none!important;transition:none!important}}";

const ids=['core','scout','lens','patch','rook','pulse','lock','quill'];
const names=['Core','Scout','Lens','Patch','Rook','Pulse','Lock','Quill'];
const colors=['purple','green','blue','orange','indigo','yellow','turquoise','pink'];
const states=new Set(['idle','listening','thinking','working','waiting_approval','success','failure','offline']);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function markup(pip,state='idle',uid='orb',options={}){
 if(!pip||!Number.isInteger(pip.index)||pip.index<0||pip.index>=ids.length)throw new TypeError('Orb character index must be an integer from 0 to 7.');
 if(typeof uid!=='string'||! /^[A-Za-z][A-Za-z0-9_-]{0,120}$/.test(uid))throw new TypeError('Orb SVG identifier must be a unique ASCII letter-prefixed token.');
 if(!states.has(state))throw new TypeError('Unknown orb state.');
 const i=pip.index,id=ids[i],preset=PRESETS[colors[i]],face=faceFor({id},state),surface=surfaceFor(preset,colors[i]),shape=silhouettes[id],iris='#fff';
 const eye=(e,side)=>`<g data-eye="${side}" transform="translate(${e.x} ${e.y}) rotate(${e.rot})"><g class="dgc-orb-blink"><path data-face="${side}" d="${e.path}" stroke-width="${e.w}"/></g></g>`;
 const rim=`<svg class="dgc-orb-glass-rim" aria-hidden="true" viewBox="0 0 1 1"><defs><linearGradient id="${uid}-rim" x1="0" y1="0" x2=".8" y2="1" gradientUnits="userSpaceOnUse"><stop stop-color="#fff" stop-opacity=".65"/><stop offset=".38" stop-color="#fff" stop-opacity=".04"/><stop offset=".65" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#fff" stop-opacity=".42"/></linearGradient></defs>${shape?`<path d="${shape}" fill="none" stroke="url(#${uid}-rim)" stroke-width=".025"/>`:`<circle cx=".5" cy=".5" r=".496" fill="none" stroke="url(#${uid}-rim)" stroke-width=".018"/>`}</svg>`;
 return `${options.includeStyles===false?'':`<style>${styles}</style>`}<span class="dgc-orb" data-state="${state}" data-character="${id}" data-name="${escape(pip.name||names[i])}" data-paused="${options.paused===true}" aria-hidden="true" style="--dgc-orb-radius:${shapeRadius[id]};--dgc-orb-period:${5.6+i*.21}s;--dgc-orb-delay:${i*-.37}s;--dgc-orb-flow-delay:${i*-1.7}s;--dgc-orb-edge:${surface.light}d9;--dgc-orb-glow:${surface.mid}99;--dgc-orb-aura:${surface.mid}59">${shape?`<svg class="dgc-orb-shape-defs" aria-hidden="true" width="0" height="0"><defs><clipPath id="${uid}-shape" clipPathUnits="objectBoundingBox"><path d="${shape}"/></clipPath></defs></svg>`:''}<span class="dgc-orb-body" style="background:${surface.background};box-shadow:${surface.shadow};${shape?`clip-path:url(#${uid}-shape);border-radius:0;`:''}"><canvas class="dgc-orb-mesh" data-mesh-palette="${colors[i]}" width="1" height="1" aria-hidden="true"></canvas><span class="dgc-orb-glass" aria-hidden="true"></span>${rim}</span><svg class="dgc-orb-face" aria-hidden="true" viewBox="0 0 100 100"><g class="dgc-orb-gaze" fill="none" stroke="#fff" stroke-linecap="round">${eye(face.left,'left')}${eye(face.right,'right')}</g></svg></span>`;
}
const api=Object.freeze({version:4,styles,markup,mount:mountMesh});
globalThis.PipConcepts=globalThis.PipConcepts||{};
globalThis.PipConcepts.orb=api;
})();
