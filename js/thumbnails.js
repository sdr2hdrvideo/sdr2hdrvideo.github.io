/* ──────────────────────────────────────────────────────────────────────────
 * thumbnails.js — generate first-frame thumbnails from videos.
 *
 * Lazily decodes the first frame of an MP4 to a small 2D canvas (then
 * data URL) so each scene can show a representative still in its tile.
 * The thumbnail is NOT HDR-accurate (2D canvas is sRGB) — it's a preview.
 *
 * Queue is serial: one decoder at a time, to avoid trashing the GPU video
 * decoder when many sections are mounted.
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.thumbnails = (function () {
  'use strict';

  const cache = new Map();   // url -> data URL
  const queue = [];
  let working = false;

  function getCached(url) { return cache.get(url) || null; }

  function request(url) {
    if (cache.has(url)) return Promise.resolve(cache.get(url));
    return new Promise((resolve, reject) => {
      queue.push({ url, resolve, reject });
      pump();
    });
  }

  async function pump() {
    if (working) return;
    if (!queue.length) return;
    working = true;
    while (queue.length) {
      const { url, resolve, reject } = queue.shift();
      try {
        const dataUrl = await decodeFirstFrame(url);
        cache.set(url, dataUrl);
        resolve(dataUrl);
      } catch (err) {
        cache.set(url, null);
        resolve(null);   // never reject; treat as "no thumb"
      }
    }
    working = false;
  }

  function decodeFirstFrame(url) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      let settled = false;
      const cleanup = () => { v.removeAttribute('src'); v.load(); };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('thumbnail timeout'));
      }, 5000);

      v.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error('video error'));
      });

      v.addEventListener('loadeddata', () => {
        // Already at t=0; pull a frame.
        try {
          const cw = 320;
          const ch = Math.round(cw * (v.videoHeight / v.videoWidth));
          const c = document.createElement('canvas');
          c.width = cw; c.height = ch;
          const cx = c.getContext('2d');
          cx.drawImage(v, 0, 0, cw, ch);
          const data = c.toDataURL('image/jpeg', 0.78);
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          resolve(data);
        } catch (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          reject(err);
        }
      });

      v.src = url;
    });
  }

  return { request, getCached };
})();
