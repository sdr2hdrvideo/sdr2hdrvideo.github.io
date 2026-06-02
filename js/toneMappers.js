/* ──────────────────────────────────────────────────────────────────────────
 * toneMappers.js — registry of tone-mapper shaders.
 *
 * DESIGN
 * ──────
 * A "tone mapper" is { name, label, wgsl, uniformSchema }. Each panel can be
 * assigned a different mapper by name. The default mapping for every panel
 * is 'drago' EXCEPT when the panel's method is 'Input'; that pseudo-method
 * is locked to the 'input' mapper (a passthrough that skips the PQ linearize
 * step because the underlying mp4 is plain SDR libx264).
 *
 * IMPORTANT — SDR vs HDR canvas behavior
 * ─────────────────────────────────────
 * The shader emits whatever value the curve produces. The canvas's WebGPU
 * tone-mapping mode (`'standard'` clamps, `'extended'` lets values >1 spill
 * into HDR headroom) is what differentiates SDR-look from HDR-look. None of
 * these shaders contain a `clamp(..., 1.0)` step.
 *
 * Crucially the canvas tone-mapping mode is owned by the comparison section
 * (not by the global toggle). Panels hosting the 'Input' method ALWAYS run
 * with `toneMapping: { mode: 'standard' }` regardless of the global toggle —
 * SDR libx264 content fed through an extended canvas would be incorrectly
 * routed to the OS HDR pipeline. See ComparisonSection.setToneMode().
 *
 * Slider semantics:
 *   exposure  — applied per-panel (linear multiplier; EV-encoded in the UI).
 *   pivot     — used by Drago/Reinhard-Mantiuk for their internal curves.
 *   contrast  — interpreted as a gamma-style strength factor by every mapper.
 *               Default 1.0 means neutral / no contrast boost; >1 deepens
 *               shadows; <1 lifts shadows.
 *   saturation — Mantiuk-style chroma exponent (1.0 = neutral).
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.toneMappers = (function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════════════════
   * Browser-specific HDR brightness correction.
   *
   * The PQ linearize variants below divide by 1000 instead of the strict
   * 10000 nits → 1.0 normalisation, which is the existing "10× boost" that
   * makes HDR methods line up with the SDR Input on Chrome / Edge.
   *
   * Emperically I saw, that Safari (Mac + iOS, all WebKit) renders the same HDR textures roughly
   * 5× dimmer than Chrome which could be matched via EV adjustment of +5 EV of HDR methods to match the SDR Input. We compensate at the linearize stage with an additional multiplier so the slider default
   * (EV 0 = 1.0×) lands at the same perceived brightness on both engines.
   * ════════════════════════════════════════════════════════════════════════ */
  // Chrome on iOS identifies as "CriOS" — NOT "Chrome" — so it passes the
  // standard Safari negative-lookahead and would otherwise be misdetected as
  // Safari. Detect it first so it can get its own boost level.
  const IS_CHROME_IOS = (() => {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    return /crios/i.test(ua);
  })();
  const IS_SAFARI = !IS_CHROME_IOS && (() => {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    // Safari UA contains "Safari" but Chrome / Chromium / Android Chrome
    // do too; the negative lookahead rejects those. Edge (Chromium) is
    // also caught by the `chrome` token in its UA.
    return /^((?!chrome|chromium|android).)*safari/i.test(ua);
  })();
  // Multipliers applied on top of the existing /1000 PQ normalisation.
  // Chrome iOS needs 10× to match; true Safari (Mac + iOS) needs 40×
  // (an additional +2 EV = 4× on top of Chrome iOS's 10×, observed empirically).
  const SAFARI_HDR_BOOST = IS_SAFARI ? '40.0' : IS_CHROME_IOS ? '10.0' : '1.0';

  /* ════════════════════════════════════════════════════════════════════════
   * Shared bits used by every WGSL block below.
   *
   * INPUT-TRANSFORM ARCHITECTURE
   * ───────────────────────────
   * The shader prelude is built at pipeline-creation time from a fixed
   * BASE (vertex shader, bindings, helpers) plus a swappable LINEARIZE
   * function. The default for every HDR mapper is 'pq' (decode the PQ
   * EOTF that the browser delivered). The 'input' mapper bypasses this
   * by reading the texture directly, since SDR videos arrive as ordinary
   * linear sRGB after the browser's sRGB-decode.
   * ════════════════════════════════════════════════════════════════════════ */

  const SHADER_BASE = `
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var t: texture_2d<f32>;
struct Uni { exposure:f32, pivot:f32, contrast:f32, sat:f32 };
@group(0) @binding(2) var<uniform> u: Uni;

struct VSO { @builtin(position) pos:vec4<f32>, @location(0) uv:vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi:u32) -> VSO {
  var p = array<vec2<f32>,6>(vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(-1.,1.),vec2(1.,-1.),vec2(1.,1.));
  var uv = array<vec2<f32>,6>(vec2(0.,0.),vec2(1.,0.),vec2(0.,1.),vec2(0.,1.),vec2(1.,0.),vec2(1.,1.));
  var o:VSO; o.pos=vec4(p[vi],0.,1.); o.uv=uv[vi]; return o;
}
fn rec709_lum(c:vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}
fn mantiuk_color(c:vec3<f32>, L_in:f32, L_out:f32, sat:f32) -> vec3<f32> {
  let L_in_safe = max(L_in, 1e-6);
  let ratio = c / vec3<f32>(L_in_safe);
  return pow(max(ratio, vec3<f32>(0.0)), vec3<f32>(sat)) * L_out;
}

// Apply contrast as a gamma-style transform anchored at the user's pivot.
// k=1.0 is neutral. k>1 darkens shadows + brightens highlights relative to
// the pivot (more contrast). k<1 compresses around the pivot. The pivot
// anchor keeps mid-grey roughly stable as the user drags the slider.
fn apply_contrast(L: f32, pv: f32, k: f32) -> f32 {
  let pv_s = clamp(pv, 1e-3, 4.0);
  let k_s  = max(k, 1e-3);
  let L_s  = max(L, 1e-6);
  return pv_s * pow(L_s / pv_s, k_s);
}

// SMPTE ST 2084 (PQ) inverse OETF. Maps PQ codes [0,1] to absolute nits [0,10000].
// Constants match those in encode.py exactly.
fn pq_eotf(E: vec3<f32>) -> vec3<f32> {
  let M1: f32 = 0.1593017578125;       // 2610/16384
  let M2: f32 = 78.84375;              // 2523/4096 * 128
  let C1: f32 = 0.8359375;             // 3424/4096
  let C2: f32 = 18.8515625;            // 2413/4096 * 32
  let C3: f32 = 18.6875;               // 2392/4096 * 32
  let Ec = max(E, vec3<f32>(0.0));
  let Ep = pow(Ec, vec3<f32>(1.0 / M2));
  let num = max(Ep - vec3<f32>(C1), vec3<f32>(0.0));
  let den = max(C2 - C3 * Ep, vec3<f32>(1e-10));
  return 10000.0 * pow(num / den, vec3<f32>(1.0 / M1));
}

// BT.2020 → BT.709 primary matrix (linear).
fn bt2020_to_bt709(c: vec3<f32>) -> vec3<f32> {
  let M = mat3x3<f32>(
    vec3<f32>( 1.6605, -0.1246, -0.0182),
    vec3<f32>(-0.5876,  1.1329, -0.1006),
    vec3<f32>(-0.0728, -0.0083,  1.1187),
  );
  return M * c;
}
`;

  // The four swappable linearize functions for HDR pipelines.
  const LINEARIZE_VARIANTS = {
    'auto': {
      label: 'Auto — trust browser',
      code: `
fn linearize_video_input(c: vec4<f32>) -> vec4<f32> { return c; }
`,
    },
    'pq': {
      label: 'PQ EOTF — undo PQ encoding (default)',
      code: `
fn linearize_video_input(c: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(pq_eotf(c.rgb) / 1000.0 * ${SAFARI_HDR_BOOST}, c.a);
}
`,
    },
    'matrix': {
      label: 'BT.2020 → BT.709 — undo primary matrix',
      code: `
fn linearize_video_input(c: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(bt2020_to_bt709(c.rgb), c.a);
}
`,
    },
    'both': {
      label: 'PQ EOTF + BT.2020 → BT.709',
      code: `
fn linearize_video_input(c: vec4<f32>) -> vec4<f32> {
  let lin = pq_eotf(c.rgb) / 1000.0 * ${SAFARI_HDR_BOOST};
  return vec4<f32>(bt2020_to_bt709(lin), c.a);
}
`,
    },
  };

  let _currentLinearizeMode = 'pq';

  function setLinearizeMode(mode) {
    if (!LINEARIZE_VARIANTS[mode]) throw new Error(`unknown linearize mode: ${mode}`);
    _currentLinearizeMode = mode;
  }
  function getCurrentLinearizeMode() { return _currentLinearizeMode; }
  function listLinearizeModes() {
    return Object.keys(LINEARIZE_VARIANTS).map(k => ({
      name: k, label: LINEARIZE_VARIANTS[k].label,
    }));
  }

  function buildShaderFor(mapper, mode) {
    if (mapper.name === 'input') {
      return SHADER_BASE + LINEARIZE_VARIANTS['auto'].code + mapper.body;
    }
    const variant = LINEARIZE_VARIANTS[mode || _currentLinearizeMode];
    if (!variant) throw new Error(`unknown linearize mode: ${mode}`);
    return SHADER_BASE + variant.code + mapper.body;
  }

  // Standard 4-float schema. Default contrast is 1.0 (neutral) so that the
  // global slider sweeps symmetrically around no-op.
  const STANDARD_SCHEMA = [
    { name: 'exposure',   type: 'f32', default: 1.0, min: 0,    max: 5,   step: 0.01 },
    { name: 'pivot',      type: 'f32', default: 0.5, min: 0.01, max: 1,   step: 0.01 },
    { name: 'contrast',   type: 'f32', default: 1.0, min: 0.01, max: 2,   step: 0.01 },
    { name: 'saturation', type: 'f32', default: 1.0, min: 0,    max: 2,   step: 0.01 },
  ];

  /* ════════════════════════════════════════════════════════════════════════
   * 1. Reinhard-Mantiuk
   * Uses contrast as the Lk exponent. k=1.0 is the classic Reinhard form.
   * ════════════════════════════════════════════════════════════════════════ */
  const REINHARD_MANTIUK = Object.freeze({
    name: 'reinhard-mantiuk',
    label: 'Reinhard–Mantiuk',
    body: `
@fragment fn fs(in:VSO) -> @location(0) vec4<f32> {
  let c = linearize_video_input(textureSample(t, s, in.uv));
  let e  = u.exposure;
  let pv = u.pivot;
  let k  = u.contrast;
  let ss = u.sat;

  let L_in = dot(c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  let L_in_safe = max(L_in, 1e-6);
  let Lk  = pow(L_in_safe, k);
  let pvk = pow(pv, k);
  let L_out = e * Lk / (Lk + pvk);

  let ratio = c.rgb / vec3<f32>(L_in_safe);
  let C_out = pow(max(ratio, vec3<f32>(0.0)), vec3<f32>(ss)) * L_out;

  return vec4<f32>(C_out, 1.0);
}
`,
    uniformSchema: STANDARD_SCHEMA,
  });

  /* ════════════════════════════════════════════════════════════════════════
   * 2. Linear / None — identity (modulo exposure, contrast, saturation)
   * ════════════════════════════════════════════════════════════════════════ */
  const LINEAR = Object.freeze({
    name: 'linear',
    label: 'Linear (no curve)',
    body: `
@fragment fn fs(in:VSO) -> @location(0) vec4<f32> {
  let c = linearize_video_input(textureSample(t, s, in.uv));
  let e  = u.exposure;
  let pv = u.pivot;
  let k  = u.contrast;
  let ss = u.sat;

  let L_in = rec709_lum(c.rgb);
  let L_exp  = e * L_in;
  let L_out  = apply_contrast(L_exp, pv, k);
  let C_out = mantiuk_color(c.rgb, L_in, L_out, ss);

  return vec4<f32>(C_out, 1.0);
}
`,
    uniformSchema: STANDARD_SCHEMA,
  });

  /* ════════════════════════════════════════════════════════════════════════
   * 2b. Input passthrough (locked mapper for the 'Input' method)
   *
   * Skips PQ linearize. The SDR Input MP4s are libx264 / yuv420p / bt709;
   * the browser's sRGB-decode at copyExternalImageToTexture-time already
   * delivers a *linear* sRGB texture. Calling pq_eotf on those values
   * would crush the data and look horribly wrong.
   *
   * Label is "SDR — No Tone Mapping" so reviewers understand this method
   * is showing the raw SDR input, not an HDR reconstruction.
   *
   * Slider semantics:
   *   exposure (e)   — pre-multiplier (true ±EV scaling)
   *   pivot, contrast — unused (panel UI greys out the mapper anyway).
   *   saturation (s) — Mantiuk chroma bend.
   * ════════════════════════════════════════════════════════════════════════ */
  const INPUT_PASSTHROUGH = Object.freeze({
    name: 'input',
    label: 'SDR — No Tone Mapping',
    body: `
@fragment fn fs(in:VSO) -> @location(0) vec4<f32> {
  // NO linearize_video_input — SDR input is already linear-sRGB.
  let c = textureSample(t, s, in.uv);
  let e  = u.exposure;
  let ss = u.sat;

  let scaled = vec3<f32>(e) * max(c.rgb, vec3<f32>(0.0));

  let L_in  = rec709_lum(c.rgb);
  let L_out = rec709_lum(scaled);
  let C_out = mantiuk_color(c.rgb, L_in, L_out, ss);

  return vec4<f32>(C_out, 1.0);
}
`,
    uniformSchema: STANDARD_SCHEMA,
  });

  /* ════════════════════════════════════════════════════════════════════════
   * 3. Drago Logarithmic (DEFAULT for HDR methods)
   *
   * Contrast: the original Drago paper doesn't include a contrast
   * parameter. We post-multiply Drago's output by a pivot-anchored gamma
   * (apply_contrast). Default contrast=1.0 leaves the original curve
   * unchanged, so the on-load look matches "vanilla Drago".
   * ════════════════════════════════════════════════════════════════════════ */
  const DRAGO = Object.freeze({
    name: 'drago',
    label: 'Drago logarithmic (default)',
    body: `
@fragment fn fs(in:VSO) -> @location(0) vec4<f32> {
  let c = linearize_video_input(textureSample(t, s, in.uv));
  let e  = u.exposure;
  let b  = clamp(u.pivot, 0.5, 0.99);
  let k  = u.contrast;
  let ss = u.sat;

  let L_in_raw = max(rec709_lum(c.rgb), 0.0);
  let L_in = L_in_raw * e;

  let L_w_max = 10.0;
  let log05_over_logB = log(0.5) / log(b);
  let ratio_w = clamp(L_in / L_w_max, 0.0, 1.0);
  let bias_term = pow(ratio_w, log05_over_logB);

  let denom = log(2.0 + 8.0 * bias_term);
  let numer = log(L_in + 1.0);
  let L_norm = numer / log(L_w_max + 1.0);
  var L_out  = L_norm * log(10.0) / max(denom, 1e-6);

  // Post-Drago contrast: pivot-anchored gamma. Neutral at k=1.0.
  L_out = apply_contrast(max(L_out, 0.0), 0.5, k);

  let C_out = mantiuk_color(c.rgb * e, L_in, L_out, ss);
  return vec4<f32>(C_out, 1.0);
}
`,
    uniformSchema: STANDARD_SCHEMA,
  });

  /* ════════════════════════════════════════════════════════════════════════
   * 4. Mantiuk 2008
   * ════════════════════════════════════════════════════════════════════════ */
  const MANTIUK = Object.freeze({
    name: 'mantiuk',
    label: 'Mantiuk 2008',
    body: `
@fragment fn fs(in:VSO) -> @location(0) vec4<f32> {
  let c = linearize_video_input(textureSample(t, s, in.uv));
  let e  = u.exposure;
  let pv = max(u.pivot, 1e-3);
  let k  = u.contrast;
  let ss = u.sat;

  let L_in = rec709_lum(c.rgb);
  let L_in_safe = max(L_in, 0.0);

  let a = e;
  let b = max(a - 1.0, 0.0) / pv;
  var L_out = (a * L_in_safe) / (1.0 + b * L_in_safe);

  L_out = pow(max(L_out, 1e-6), 1.0 / max(k, 1e-3));

  let C_out = mantiuk_color(c.rgb, L_in, L_out, ss);
  return vec4<f32>(C_out, 1.0);
}
`,
    uniformSchema: STANDARD_SCHEMA,
  });

  /* ════════════════════════════════════════════════════════════════════════
   * 5. Hable Filmic (Uncharted 2)
   * ════════════════════════════════════════════════════════════════════════ */
  const HABLE = Object.freeze({
    name: 'hable',
    label: 'Hable filmic (Uncharted 2)',
    body: `
fn hable_curve(x: f32) -> f32 {
  let A = 0.15; let B = 0.50; let C = 0.10;
  let D = 0.20; let E = 0.02; let F = 0.30;
  return ((x * (A*x + C*B) + D*E) / (x * (A*x + B) + D*F)) - E/F;
}
@fragment fn fs(in:VSO) -> @location(0) vec4<f32> {
  let c = linearize_video_input(textureSample(t, s, in.uv));
  let e  = u.exposure;
  let pv = u.pivot;
  let k  = u.contrast;
  let ss = u.sat;

  let L_in = rec709_lum(c.rgb);
  let L_scaled = e * L_in;

  let W = 11.2;
  let denom = max(hable_curve(W), 1e-6);
  var L_out = hable_curve(L_scaled) / denom;
  L_out = apply_contrast(max(L_out, 0.0), pv, k);

  let C_out = mantiuk_color(c.rgb, L_in, L_out, ss);
  return vec4<f32>(C_out, 1.0);
}
`,
    uniformSchema: STANDARD_SCHEMA,
  });

  /* ════════════════════════════════════════════════════════════════════════
   * 6. ACES Filmic
   * ════════════════════════════════════════════════════════════════════════ */
  const ACES = Object.freeze({
    name: 'aces',
    label: 'ACES filmic',
    body: `
fn aces_rrt(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = vec3<f32>(0.03);
  let c2 = 2.43;
  let d = vec3<f32>(0.59);
  let e2 = vec3<f32>(0.14);
  return (x * (a * x + b)) / (x * (c2 * x + d) + e2);
}
@fragment fn fs(in:VSO) -> @location(0) vec4<f32> {
  let c = linearize_video_input(textureSample(t, s, in.uv));
  let e  = u.exposure;
  let pv = u.pivot;
  let k  = u.contrast;
  let ss = u.sat;

  let scaled = max(e * c.rgb, vec3<f32>(0.0));
  let mapped = aces_rrt(scaled);

  let L_in  = rec709_lum(c.rgb);
  var L_out = rec709_lum(mapped);
  L_out = apply_contrast(max(L_out, 0.0), pv, k);
  let C_out = mantiuk_color(c.rgb, L_in, L_out, ss);

  return vec4<f32>(C_out, 1.0);
}
`,
    uniformSchema: STANDARD_SCHEMA,
  });

  /* ════════════════════════════════════════════════════════════════════════
   * Registry
   * ════════════════════════════════════════════════════════════════════════ */

  const registry = new Map();
  function _register(def) { registry.set(def.name, def); }
  _register(REINHARD_MANTIUK);
  _register(LINEAR);
  _register(INPUT_PASSTHROUGH);
  _register(DRAGO);
  _register(MANTIUK);
  _register(HABLE);
  _register(ACES);

  // method (e.g. 'Ours') -> mapper name. Default is drago.
  const methodToMapperName = new Map();

  // Methods that LOCK their tone mapper (UI greys out the select). The
  // 'Input' method is locked to 'input' because the underlying mp4 is SDR
  // and the other mappers would mishandle the colors.
  const LOCKED_METHODS = new Set(['Input']);
  methodToMapperName.set('Input', 'input');

  /* ════════════════════════════════════════════════════════════════════════
   * Exposure brackets — used by per-panel bracket button rows.
   * Range: −4 EV (×0.0625) … +4 EV (×16). 0 EV is the centered default.
   * ════════════════════════════════════════════════════════════════════════ */
  const EXPOSURE_BRACKETS = [
    { name: 'ev-4', label: '−4 EV', exposure: 0.0625 },
    { name: 'ev-3', label: '−3 EV', exposure: 0.125  },
    { name: 'ev-2', label: '−2 EV', exposure: 0.25   },
    { name: 'ev-1', label: '−1 EV', exposure: 0.5    },
    { name: 'ev0',  label: '0 EV',  exposure: 1.0    },
    { name: 'ev+1', label: '+1 EV', exposure: 2.0    },
    { name: 'ev+2', label: '+2 EV', exposure: 4.0    },
    { name: 'ev+3', label: '+3 EV', exposure: 8.0    },
    { name: 'ev+4', label: '+4 EV', exposure: 16.0   },
  ];

  /* ════════════════════════════════════════════════════════════════════════
   * Public API
   * ════════════════════════════════════════════════════════════════════════ */

  function registerToneMapper(def) {
    if (!def?.name) throw new Error('registerToneMapper: def.name required');
    if (!def?.body) throw new Error('registerToneMapper: def.body required');
    if (!Array.isArray(def?.uniformSchema)) {
      throw new Error('registerToneMapper: def.uniformSchema must be an array');
    }
    registry.set(def.name, Object.freeze({ label: def.name, ...def }));
  }

  function setMethodToneMapper(methodName, mapperName) {
    if (!registry.has(mapperName)) {
      throw new Error(`setMethodToneMapper: unknown mapper '${mapperName}'`);
    }
    methodToMapperName.set(methodName, mapperName);
  }

  function getToneMapperForMethod(methodName) {
    const name = methodToMapperName.get(methodName) ?? DRAGO.name;
    return registry.get(name);
  }

  function isMethodLocked(methodName) {
    return LOCKED_METHODS.has(methodName);
  }

  function listToneMappers() {
    return [
      'drago', 'linear', 'reinhard-mantiuk', 'mantiuk', 'hable', 'aces',
    ].map(n => registry.get(n)).filter(Boolean);
  }

  function listToneMapperNames() { return listToneMappers().map(m => m.name); }
  function getToneMapper(name)   { return registry.get(name);   }

  function packUniforms(mapper, values) {
    const arr = new Float32Array(mapper.uniformSchema.length);
    for (let i = 0; i < mapper.uniformSchema.length; i++) {
      const sch = mapper.uniformSchema[i];
      arr[i] = values?.[sch.name] ?? sch.default;
    }
    return arr;
  }

  function methodsShareMapper(methods) {
    if (!methods.length) return true;
    const first = methodToMapperName.get(methods[0]) ?? DRAGO.name;
    return methods.every(m => (methodToMapperName.get(m) ?? DRAGO.name) === first);
  }

  return {
    DEFAULT_TONE_MAPPER_NAME: DRAGO.name,
    EXPOSURE_BRACKETS,
    registerToneMapper,
    setMethodToneMapper,
    getToneMapperForMethod,
    isMethodLocked,
    listToneMappers,
    listToneMapperNames,
    getToneMapper,
    packUniforms,
    methodsShareMapper,
    setLinearizeMode,
    getCurrentLinearizeMode,
    listLinearizeModes,
    buildShaderFor,
  };
})();
