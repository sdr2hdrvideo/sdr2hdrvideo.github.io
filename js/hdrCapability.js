/* ──────────────────────────────────────────────────────────────────────────
 * hdrCapability.js — detect HDR-capable display.
 *
 * `(dynamic-range: high)` is the W3C Media Queries Level 5 query that
 * resolves true when the browser believes the output device + OS settings
 * support HDR. It does NOT tell us whether Chrome's experimental web-platform
 * features are enabled. Only tells us that the display reports HDR. We surface
 * a hint to the user when HDR is detected so they can opt in to those flags if they want.
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.hdrCapability = (function () {
  'use strict';

  const HDR_STATE = Object.freeze({
    UNKNOWN: 'unknown',
    SDR:     'sdr',
    HDR:     'hdr',
  });

  function detectHdrState() {
    if (typeof window === 'undefined' || !window.matchMedia) return HDR_STATE.UNKNOWN;
    try {
      return window.matchMedia('(dynamic-range: high)').matches
        ? HDR_STATE.HDR
        : HDR_STATE.SDR;
    } catch {
      return HDR_STATE.UNKNOWN;
    }
  }

  /**
   * Subscribe to HDR state changes (e.g., user toggles HDR in OS settings).
   * Returns an unsubscribe function.
   */
  function watchHdrState(callback) {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mq = window.matchMedia('(dynamic-range: high)');
    const handler = () => callback(mq.matches ? HDR_STATE.HDR : HDR_STATE.SDR);
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else mq.addListener(handler);  // Safari < 14 fallback
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else mq.removeListener(handler);
    };
  }

  /** short label for the header badge. */
  function labelForState(state) {
    switch (state) {
      case HDR_STATE.HDR: return 'HDR display';
      case HDR_STATE.SDR: return 'SDR display';
      default:            return 'display unknown';
    }
  }

  return { HDR_STATE, detectHdrState, watchHdrState, labelForState };
})();
