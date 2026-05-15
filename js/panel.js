/* ──────────────────────────────────────────────────────────────────────────
 * panel.js — one viewer panel.
 *
 * A panel owns:
 *   * one <canvas> + WebGPU context (configured rgba16float / srgb / extended),
 *   * one render pipeline (keyed by its method's tone mapper),
 *   * one uniform buffer (its own copy, even if it currently shares values
 *     with other panels — this is what lets the per-method tone-mapper
 *     extension work without architectural rework),
 *   * an array of `frameCount` rgba16float textures (one per frame),
 *   * a sampler.
 *
 * It does NOT own playback state; the SyncController drives that.
 *
 * Lifecycle:
 *   panel = new Panel({ device, container, method });
 *   await panel.loadSequence(url, fps, frameCount, onProgress);
 *   panel.setUniforms({ exposure: 1, ... });
 *   panel.drawFrame(0);
 *   panel.unloadSequence();   // before loading a new scene
 *   panel.dispose();          // on tear-down
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.panel = (function () {
  'use strict';

  const { getToneMapperForMethod, packUniforms } = window.App.toneMappers;
  const {
    configureCanvas, getOrCreatePipeline, buildBindGroup, drawFullscreen,
  } = window.App.renderer;
  const { decodeVideoToTextures, destroyTextures } = window.App.videoLoader;

  class Panel {
    constructor(args) {
      const { device, container, method, toneMode } = args;
      this.device = device;
      this.method = method;
      this.toneMapper = getToneMapperForMethod(method);
      this.toneMode = toneMode || 'standard';

      // ── DOM ──────────────────────────────────────────────────────────
      this.root = document.createElement('div');
      this.root.className = 'panel panel-loading';
      this.root.dataset.method = method;

      this.canvas = document.createElement('canvas');
      this.root.appendChild(this.canvas);

      this.label = document.createElement('div');
      this.label.className = 'panel-overlay';
      this.label.textContent = method;
      this.root.appendChild(this.label);

      this.cornerLabel = document.createElement('div');
      this.cornerLabel.className = 'panel-overlay-corner';
      this.root.appendChild(this.cornerLabel);

      container.appendChild(this.root);

      // ── GPU resources ────────────────────────────────────────────────
      this.ctx = this.canvas.getContext('webgpu');
      if (!this.ctx) throw new Error('Failed to get webgpu context for panel');
      configureCanvas(this.ctx, device, this.toneMode);

      this.pipeline = getOrCreatePipeline(device, this.toneMapper);
      this.sampler  = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

      // Uniform buffer: 4 floats = 16 bytes (matches gmVideoExp_cc.html `Uni`).
      // Each panel keeps its own copy. Today they're written with the same
      // values; this isolation is what enables the future per-method extension.
      const uniformByteSize = this.toneMapper.uniformSchema.length * 4;
      this.uniformBuffer = device.createBuffer({
        size: Math.max(16, uniformByteSize),     // WebGPU minimum
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.setUniforms(/* defaults */);

      // ── Sequence state (filled by loadSequence) ──────────────────────
      this.textures = null;     // GPUTexture[] | null
      this.bindGroups = null;   // GPUBindGroup[] | null (one per frame)
      this.width = 0;
      this.height = 0;
      this.currentFrame = 0;

      // Resize observer keeps canvas pixel size in sync with DOM size + DPR.
      this._resizeObserver = new ResizeObserver(() => this._syncCanvasSize());
      this._resizeObserver.observe(this.root);
    }

    /**
     * Load and decode a video into per-frame textures.
     *
     * @param source { url: string, dispose: () => void } — opaque source from
     *   config.videoSource(); the dispose() releases blob URLs once we're
     *   done with the video element.
     */
    async loadSequence(source, fps, frameCount, onProgress) {
      this.unloadSequence();
      this.root.classList.add('panel-loading');
      this.root.classList.remove('panel-error');
      delete this.root.dataset.error;

      if (!source || !source.url) {
        this.root.classList.remove('panel-loading');
        this.root.classList.add('panel-error');
        this.root.dataset.error = (source && source.error) || 'No video source';
        throw new Error(this.root.dataset.error);
      }

      try {
        const { textures, width, height } = await decodeVideoToTextures({
          device: this.device, url: source.url, fps, frameCount, onProgress,
        });

        this.textures = textures;
        this.width = width;
        this.height = height;

        // Pre-build a bind group per frame (textures don't change after load).
        this.bindGroups = textures.map(tex => buildBindGroup(
          this.device, this.pipeline, this.sampler, tex.createView(), this.uniformBuffer,
        ));

        // Resolution badge was previously written here as `${w}x${h}`. We
        // now keep the DOM node (other code paths still call setCornerInfo)
        // but leave it empty so the published view has nothing overlaid in
        // the bottom-right corner of each panel.
        this.cornerLabel.textContent = '';
        this._syncCanvasSize();

        this.root.classList.remove('panel-loading');
        this.drawFrame(0);
      } catch (err) {
        this.root.classList.remove('panel-loading');
        this.root.classList.add('panel-error');
        this.root.dataset.error = err.message ? err.message : String(err);
        throw err;
      } finally {
        // Release the blob URL (if any) — the video element has finished
        // with it, and decoded frames live in GPU textures from here on.
        if (source.dispose) source.dispose();
      }
    }

    unloadSequence() {
      if (this.bindGroups) this.bindGroups = null;
      if (this.textures) {
        destroyTextures(this.textures);
        this.textures = null;
      }
      this.cornerLabel.textContent = '';
    }

    /** Write a uniform value object into this panel's uniform buffer.
        Note: this DOES NOT redraw — call redraw() after if you need it. */
    setUniforms(values) {
      this._lastUniforms = Object.assign({}, this._lastUniforms || {}, values || {});
      const arr = packUniforms(this.toneMapper, this._lastUniforms);
      this.device.queue.writeBuffer(
        this.uniformBuffer, 0, arr.buffer, arr.byteOffset, arr.byteLength,
      );
    }

    /** Draw frame `idx` into the panel's canvas. No-op if not loaded. */
    drawFrame(idx) {
      if (!this.bindGroups || idx < 0 || idx >= this.bindGroups.length) return;
      this.currentFrame = idx;
      drawFullscreen(this.device, this.ctx, this.pipeline, this.bindGroups[idx]);
    }

    /** Re-render the current frame (after a uniform change, resize, etc.) */
    redraw() { this.drawFrame(this.currentFrame); }

    /**
     * Swap the active tone mapper. Rebuilds the render pipeline and bind
     * groups; reuses the uniform buffer if the new mapper has the same
     * uniform schema (otherwise reallocates). Triggers a redraw.
     */
    swapToneMapper(mapper) {
      if (!mapper) throw new Error('swapToneMapper: null mapper');
      if (mapper === this.toneMapper) return;

      const oldSize = this.toneMapper.uniformSchema.length * 4;
      const newSize = mapper.uniformSchema.length * 4;
      if (newSize !== oldSize) {
        if (this.uniformBuffer.destroy) this.uniformBuffer.destroy();
        this.uniformBuffer = this.device.createBuffer({
          size: Math.max(16, newSize),
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }

      this.toneMapper = mapper;
      this.pipeline = getOrCreatePipeline(this.device, mapper);
      this.setUniforms(this._lastUniforms || {});

      // Bind groups are tied to the pipeline's bind-group layout, so rebuild.
      if (this.textures) {
        this.bindGroups = this.textures.map(tex => buildBindGroup(
          this.device, this.pipeline, this.sampler, tex.createView(), this.uniformBuffer,
        ));
        this.redraw();
      }
    }

    /**
     * Rebuild the render pipeline and bind groups for the current tone
     * mapper at the current linearize mode. Call this after globally
     * changing the linearize mode (window.App.toneMappers.setLinearizeMode).
     *
     * The cache key in getOrCreatePipeline includes the linearize mode,
     * so this either fetches a previously-built pipeline for the new
     * mode or compiles a fresh shader. Bind groups need to be rebuilt
     * because they're tied to the pipeline's bind-group layout (which
     * may differ even if the layout: 'auto' result looks the same).
     */
    refreshPipeline() {
      this.pipeline = getOrCreatePipeline(this.device, this.toneMapper);
      if (this.textures) {
        this.bindGroups = this.textures.map(tex => buildBindGroup(
          this.device, this.pipeline, this.sampler, tex.createView(), this.uniformBuffer,
        ));
        this.redraw();
      }
    }

    /**
     * Switch the canvas's WebGPU tone-mapping mode. This is what flips
     * the panel between SDR-clamped output ('standard') and HDR-headroom
     * pass-through ('extended'). Re-configuring the canvas does NOT
     * invalidate pipelines or bind groups, so we just reconfigure and
     * redraw.
     *
     * We deliberately reconfigure UNCONDITIONALLY (no early-return on
     * mode-match): WebGPU canvas state could conceivably drift out of
     * sync with this.toneMode after a context-loss recovery or after
     * the user re-picks the videos folder, and reconfiguring is cheap
     * and idempotent. Skipping the redraw is what was masking earlier
     * "stuck HDR" reports.
     */
    setToneMode(mode) {
      configureCanvas(this.ctx, this.device, mode);
      this.toneMode = mode;
      this.redraw();
    }

    setCornerInfo(text) { 
      if (this.cornerLabel) this.cornerLabel.textContent = text; 
    }

    /** Update the panel's method label overlay. Called when the method select changes. */
    setLabel(text) { 
      if (this.label) this.label.textContent = text; 
    }

    setLabelVisible(visible) {
      if (this.label) this.label.style.display = visible ? '' : 'none';
    }

    // ── internals ────────────────────────────────────────────────────────

    /** Match canvas pixel size to its CSS box, preserving aspect ratio of source. */
    _syncCanvasSize() {
      if (!this.root || !this.canvas) return;  // Safety: elements not found
      if (!this.width || !this.height) {
        const rect = this.root.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width  = Math.max(1, Math.floor(rect.width * dpr));
        this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        return;
      }

      const aspect = this.width / this.height;
      const rect = this.root.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);   // cap at 2x to spare GPU

      // Width-driven sizing. The panel.root has height:auto and grows to
      // contain the canvas; the CSS `max-height: 70vh` on .panel canvas
      // caps runaway sizes for portrait clips. We deliberately do NOT
      // clamp by rect.height here — that clamp produced a too-small
      // initial size because the panel started at its min-height before
      // the canvas pushed it taller. Width-driven sizing matches what
      // the user sees after toggling Slider → Side.
      let cssW = rect.width;
      let cssH = rect.width / aspect;
      this.canvas.style.width  = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
      this.canvas.width  = Math.max(1, Math.floor(cssW * dpr));
      this.canvas.height = Math.max(1, Math.floor(cssH * dpr));

      if (this.bindGroups) this.redraw();
    }

    dispose() {
      this._resizeObserver.disconnect();
      this.unloadSequence();
      if (this.uniformBuffer.destroy) this.uniformBuffer.destroy();
      this.root.remove();
    }
  }

  return { Panel };
})();
