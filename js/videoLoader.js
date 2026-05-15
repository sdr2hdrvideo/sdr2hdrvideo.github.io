/* ──────────────────────────────────────────────────────────────────────────
 * videoLoader.js — decode an offline HEVC HDR mp4 into an array of GPU
 * textures (one rgba16float texture per frame).
 *
 * Why this approach
 * ─────────────────
 * TODO: write this section as we were wrong about some of our assumptions and had to pivot a bit. 
 *
 * Why we cache all 17 frames as textures up front
 * ───────────────────────────────────────────────
 * (a) Custom playback FPS / scrubbing / pause-and-step needs O(1) random
 *     access to any frame. Live-decoding-on-seek would re-trigger the
 *     decoder for every UI tick — too slow.
 * (b) 17 frames @ 1280×704 × rgba16f = ~12 MB / video. Even with 4 panels
 *     that's 48 MB GPU memory. Trivial on any GPU that can play HDR video.
 * 
 * TODO: revisit the caching strategy if we add more videos. A reasonable solution would be to cache the frames for the currently selected scene, and dispose them when the user picks a different scene. This would keep memory usage constant regardless of how many scenes we add.
 *
 * Why seek-based capture (not requestVideoFrameCallback)
 * ───────────────────────────────────────────────────────
 * `requestVideoFrameCallback` fires per *displayed* frame, and the browser
 * will drop frames if the page can't keep up — for a 17-frame sequence at
 * 24 fps that's a real risk. Seeking each frame and waiting for `seeked`
 * is slower (~50 ms / frame) but deterministic: every frame gets captured
 * exactly once.
 *
 * Color pipeline
 * ──────────────
 * `copyExternalImageToTexture({source: VideoFrame})` -> rgba16float / srgb
 * destination triggers the browser's HDR conversion: it reads the source's
 * tagged primaries+transfer (BT.2020 + PQ for HDR10), applies PQ EOTF,
 * primary matrix to BT.709, and stores extended-range linear sRGB floats.
 * PQ 100 nits ↔ 1.0 in the texture (Chrome / Safari convention), which
 * matches encode.py's NITS_PER_UNIT=100 and so makes the decoded floats
 * equal to the original EXR floats (within PQ-quantization).
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.videoLoader = (function () {
  'use strict';

  const SEEK_TIMEOUT_MS = 8000;

  /**
   * Marker thrown when the source File object has been invalidated by the
   * browser (typically because the tab was backgrounded long enough that
   * Chromium dropped the file handle behind our `<input webkitdirectory>`
   * blob). The user must re-pick the folder; main.js watches for this.
   */
  class StaleSourceError extends Error {
    constructor(msg) {
      super(msg);
      this.name = 'StaleSourceError';
      this.stale = true;
    }
  }

  /** Wait for an event with a timeout. Strict listener: removed on resolution. */
  function waitForEvent(el, name, timeoutMs) {
    timeoutMs = timeoutMs || SEEK_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let done = false;
      const onOk  = (e) => { if (done) return; done = true; cleanup(); resolve(e); };
      const onErr = ()  => {
        if (done) return; done = true; cleanup();
        // Distinguish "file source went stale" (post-backgrounding) from
        // a normal decode error so the UI layer can offer to re-pick the
        // folder rather than dying with a useless "video error" message.
        const me = el && el.error;
        const isBlob = typeof el.src === 'string' && el.src.startsWith('blob:');
        const looksStale = isBlob && me && (
          me.code === 2 /* MEDIA_ERR_NETWORK */ ||
          me.code === 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */
        );
        if (looksStale) {
          reject(new StaleSourceError(
            'video source went stale (likely tab was backgrounded). ' +
            'Please re-pick the videos/ folder.'));
        } else {
          reject(new Error(`${name} error` + (me ? ` (code ${me.code})` : '')));
        }
      };
      const onTimeout = () => { if (done) return; done = true; cleanup();
        reject(new Error(`${name} timed out after ${timeoutMs}ms`)); };
      function cleanup() {
        el.removeEventListener(name, onOk);
        el.removeEventListener('error', onErr);
        clearTimeout(timer);
      }
      const timer = setTimeout(onTimeout, timeoutMs);
      el.addEventListener(name, onOk, { once: true });
      el.addEventListener('error', onErr, { once: true });
    });
  }

  /**
   * Decode the entire video into `frameCount` rgba16float GPU textures.
   *
   * @param {object} args
   * @param {GPUDevice} args.device
   * @param {string}   args.url        relative URL, e.g. './videos/playground/method_ours.mp4'
   * @param {number}   args.fps        encode/playback fps (used to compute seek times)
   * @param {number}   args.frameCount number of frames to extract
   * @param {(loaded:number, total:number) => void} [args.onProgress]
   * @returns {Promise<{ textures: GPUTexture[], width: number, height: number }>}
   */
  async function decodeVideoToTextures(args) {
    const { device, url, fps, frameCount, onProgress } = args;

    if (typeof VideoFrame !== 'function') {
      throw new Error('VideoFrame API unavailable; needs Chrome 94+ or Safari 16.4+.');
    }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    // NB: do NOT set video.crossOrigin. Setting it forces Chrome to do a CORS
    // preflight, which file:// URLs can never satisfy (no headers possible).
    // For blob: URLs from our folder picker, the URL is already same-origin
    // with the page so no CORS is involved either way.
    video.src = url;

    // Wait for metadata so we know dimensions.
    await waitForEvent(video, 'loadedmetadata');
    const W = video.videoWidth;
    const H = video.videoHeight;
    if (!W || !H) throw new Error(`Video has no dimensions: ${url}`);

    // Make sure enough data is buffered to seek anywhere.
    if (video.readyState < 2 /* HAVE_CURRENT_DATA */) {
      await waitForEvent(video, 'loadeddata');
    }

    // Seek + capture each frame.
    const textures = new Array(frameCount);
    try {
      for (let i = 0; i < frameCount; i++) {
        // Land 0.5/fps past the frame boundary to avoid frame-edge ambiguity.
        const t = (i + 0.5) / fps;
        if (Math.abs(video.currentTime - t) > 1 / (4 * fps)) {
          video.currentTime = t;
          await waitForEvent(video, 'seeked');
        }

        // Capture the currently displayed frame as a VideoFrame.
        const vf = new VideoFrame(video);

        const tex = device.createTexture({
          size: [W, H],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING
               | GPUTextureUsage.COPY_DST
               | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        // Browser handles YUV420p10le BT.2020 PQ -> extended-range linear sRGB.
        // flipY:true to match the userStudy shader's bottom-up UV expectation.
        device.queue.copyExternalImageToTexture(
          { source: vf, flipY: true },
          { texture: tex, colorSpace: 'srgb' },
          [W, H],
        );

        vf.close();
        textures[i] = tex;
        if (onProgress) onProgress(i + 1, frameCount);
      }
    } catch (err) {
      // Free anything we allocated so a failed scene doesn't leak GPU memory.
      for (const t of textures) if (t && t.destroy) t.destroy();
      throw err;
    } finally {
      // Detach the source so the video element can be GC'd.
      video.removeAttribute('src');
      video.load();
    }

    return { textures, width: W, height: H };
  }

  /** Free an array of GPUTextures. Safe to call multiple times. */
  function destroyTextures(textures) {
    if (!textures) return;
    for (const t of textures) if (t && t.destroy) t.destroy();
  }

  return { decodeVideoToTextures, destroyTextures, StaleSourceError };
})();
