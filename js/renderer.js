/* ──────────────────────────────────────────────────────────────────────────
 * renderer.js — build a per-mapper WebGPU render pipeline.
 *
 * One pipeline per (device, mapper) pair is enough; we don't need to rebuild
 * per frame. Bind groups DO need rebuilding when the input texture changes
 * (i.e., once per frame), so we expose a helper for that.
 *
 * Canvas configuration:
 *     format:      rgba16float
 *     colorSpace:  srgb
 *     toneMapping: { mode: 'standard' | 'extended' }   ← caller-controlled
 *
 * Tone-mapping mode is what differentiates SDR-look from HDR-look:
 *
 *   'standard'  – the canvas itself clamps each channel to [0,1] before
 *                 present. Same look on every display. Matches what an
 *                 SDR canvas would do.
 *
 *   'extended'  – values >1 are passed through to the compositor. On an
 *                 HDR display the OS routes them to display headroom; on
 *                 SDR the OS still clips. So this mode is the SDR/HDR
 *                 toggle, NOT something the shader does.
 *
 * The tone-mapper shaders themselves NEVER clamp the output — they emit
 * whatever the curve produces. See toneMappers.js for why.
 *
 * `configureCanvas` is safe to call multiple times on the same context,
 * which is how panel.setToneMode() switches modes at runtime.
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.renderer = (function () {
  'use strict';

  const CANVAS_FORMAT = 'rgba16float';
  const VALID_TONE_MODES = new Set(['standard', 'extended']);

  function configureCanvas(ctx, device, toneMode) {
    toneMode = toneMode || 'standard';
    if (!VALID_TONE_MODES.has(toneMode)) {
      throw new Error(`configureCanvas: unknown toneMode '${toneMode}'`);
    }
    // Configure call structured to match gmVideoExp_cc.html line 1709 exactly.
    // (No alphaMode; 'opaque' is the WebGPU default for rgba16float.)
    ctx.configure({
      device,
      format: CANVAS_FORMAT,
      colorSpace: 'srgb',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      toneMapping: { mode: toneMode },
    });
  }

  // device -> Map<"mapperName::linearizeMode", pipeline>
  // The linearize mode is part of the cache key because changing it changes
  // the WGSL source (different linearize_video_input body) and requires a
  // freshly-compiled shader module + pipeline.
  const pipelineCache = new WeakMap();

  function getOrCreatePipeline(device, mapper) {
    let perDevice = pipelineCache.get(device);
    if (!perDevice) {
      perDevice = new Map();
      pipelineCache.set(device, perDevice);
    }
    const linearizeMode = window.App.toneMappers.getCurrentLinearizeMode();
    const cacheKey = `${mapper.name}::${linearizeMode}`;
    const cached = perDevice.get(cacheKey);
    if (cached) return cached;

    const wgsl = window.App.toneMappers.buildShaderFor(mapper, linearizeMode);
    const module = device.createShaderModule({ code: wgsl });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: CANVAS_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    perDevice.set(cacheKey, pipeline);
    return pipeline;
  }

  function buildBindGroup(device, pipeline, sampler, textureView, uniformBuffer) {
    return device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: textureView },
        { binding: 2, resource: { buffer: uniformBuffer } },
      ],
    });
  }

  function drawFullscreen(device, ctx, pipeline, bindGroup) {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  return {
    CANVAS_FORMAT,
    VALID_TONE_MODES,
    configureCanvas,
    getOrCreatePipeline,
    buildBindGroup,
    drawFullscreen,
  };
})();
