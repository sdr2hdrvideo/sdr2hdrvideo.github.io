/* ──────────────────────────────────────────────────────────────────────────
 * syncController.js — drives playback and broadcasts the current frame
 * index to all panels.
 *
 * Owns: currentFrame, isPlaying, fps
 * Notifies: registered listeners ({ onFrame, onPlayState })
 *
 * NOTE: Per-panel uniforms used to live here and broadcast through
 * `onUniforms`. The viewer now keeps uniforms per panel (exposure is
 * per-panel; pivot/contrast/saturation are global but the global wiring
 * pushes directly to panels). This controller is now purely playback.
 *
 * Frame advancement is driven by requestAnimationFrame; we accumulate real
 * elapsed milliseconds and emit a new frame index when (now - last) ≥ 1000/fps.
 * This keeps playback at exactly the requested fps regardless of monitor
 * refresh rate, and avoids dropped/repeated frames as long as the panels
 * can render in <1/fps seconds (they should — we're just blitting cached
 * textures).
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.syncController = (function () {
  'use strict';

  class SyncController {
    constructor(args) {
      this.frameCount = args.frameCount;
      this.fps = args.fps;
      this.currentFrame = 0;
      this.isPlaying = false;

      this._listeners = new Set();
      this._rafId = null;
      this._lastTickMs = 0;
      this._accum = 0;
      this._tick = this._tick.bind(this);
    }

    setFrameCount(n) {
      this.frameCount = n;
      if (this.currentFrame >= n) this.currentFrame = 0;
      this._emitFrame();
    }

    setFps(fps) {
      this.fps = Math.max(1, Math.min(60, fps | 0));
    }

    setFrame(idx) {
      const wrapped = ((idx % this.frameCount) + this.frameCount) % this.frameCount;
      if (wrapped === this.currentFrame) return;
      this.currentFrame = wrapped;
      this._emitFrame();
    }

    stepFrame(delta) { this.setFrame(this.currentFrame + delta); }

    play() {
      if (this.isPlaying) return;
      this.isPlaying = true;
      this._lastTickMs = performance.now();
      this._accum = 0;
      this._scheduleTick();
      for (const l of this._listeners) if (l.onPlayState) l.onPlayState(true);
    }

    pause() {
      if (!this.isPlaying) return;
      this.isPlaying = false;
      if (this._rafId !== null) cancelAnimationFrame(this._rafId);
      this._rafId = null;
      for (const l of this._listeners) if (l.onPlayState) l.onPlayState(false);
    }

    toggle() { this.isPlaying ? this.pause() : this.play(); }

    addListener(listener) {
      this._listeners.add(listener);
      // Send current state on subscription so new listeners are in sync.
      if (listener.onPlayState) listener.onPlayState(this.isPlaying);
      if (listener.onFrame)     listener.onFrame(this.currentFrame);
      return () => this._listeners.delete(listener);
    }

    _emitFrame() {
      for (const l of this._listeners) if (l.onFrame) l.onFrame(this.currentFrame);
    }

    _scheduleTick() {
      this._rafId = requestAnimationFrame(this._tick);
    }

    _tick(nowMs) {
      if (!this.isPlaying) return;
      const dt = Math.min(nowMs - this._lastTickMs, 250);
      this._lastTickMs = nowMs;
      this._accum += dt;

      const period = 1000 / this.fps;
      if (this._accum >= period) {
        const advance = Math.floor(this._accum / period);
        this._accum -= advance * period;
        this.setFrame(this.currentFrame + advance);
      }
      this._scheduleTick();
    }
  }

  return { SyncController };
})();
