/* ──────────────────────────────────────────────────────────────────────────
 * ui.js — DOM event wiring (scene picker, sliders, playback bar, badges).
 *
 * Pure DOM helpers. Calls back through callbacks; never reaches into the
 * sync controller, panels, or sections directly.
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.ui = (function () {
  'use strict';

  const { HDR_STATE, labelForState } = window.App.hdrCapability;

  // ── Generic select builder ───────────────────────────────────────────────
  /**
   * Populate a <select> element with the given options.
   * `options` is an array of strings (used as both value and label).
   * `selected` is the value to pre-select (falls back to first option).
   */
  function buildSelectOptions(selectEl, options, selected) {
    if (!selectEl) return;  // Safety: element not found
    selectEl.replaceChildren();
    for (const opt of options) {
      const el = document.createElement('option');
      el.value = opt;
      el.textContent = opt;
      if (opt === selected) el.selected = true;
      selectEl.appendChild(el);
    }
    if (selected && !options.includes(selected) && options.length) {
      selectEl.value = options[0];
    }
  }

  // ── Inline slider row (for floating nav: pivot / contrast / saturation) ─
  /**
   * Build a horizontal row of compact slider controls. Each control has
   * label on the left, slider, value display.
   *
   * @param rootEl    container; emptied and refilled.
   * @param fields    array of { name, label, min, max, step, default }.
   * @param values    map from field.name -> current value.
   * @param onChange  (name, value) => void.
   */
  function buildInlineSliders(rootEl, fields, values, onChange) {
    if (!rootEl) return;  // Safety: element not found
    rootEl.replaceChildren();
    for (const field of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'inline-slider';

      const name = document.createElement('span');
      name.className = 'control-label';
      name.textContent = field.label || field.name;

      const initial = values[field.name] != null ? values[field.name] : field.default;
      const range = document.createElement('input');
      range.type = 'range';
      range.min  = field.min;
      range.max  = field.max;
      range.step = field.step;
      range.value = initial;
      range.className = 'inline-slider-range';

      const val = document.createElement('span');
      val.className = 'slider-value';
      val.textContent = formatNumber(initial);

      range.addEventListener('input', () => {
        const v = parseFloat(range.value);
        val.textContent = formatNumber(v);
        onChange(field.name, v);
      });

      wrap.appendChild(name);
      wrap.appendChild(range);
      wrap.appendChild(val);
      rootEl.appendChild(wrap);
    }
  }

  /**
   * Update slider value displays without rebuilding the DOM. Used after a
   * "reset" so the slider thumbs and value labels snap to defaults.
   */
  function refreshInlineSliders(rootEl, fields, values) {
    if (!rootEl) return;  // Safety: element not found
    const wraps = rootEl.querySelectorAll('.inline-slider');
    fields.forEach((field, i) => {
      const w = wraps[i];
      if (!w) return;
      const v = values[field.name] != null ? values[field.name] : field.default;
      const range = w.querySelector('input[type="range"]');
      const valEl = w.querySelector('.slider-value');
      if (range) range.value = v;
      if (valEl) valEl.textContent = formatNumber(v);
    });
  }

  // ── Per-panel exposure slider with value display ────────────────────────
  /**
   * Build a single compact slider row (used for per-panel exposure).
   *
   * Returns the input element so the caller can listen / write to it.
   */
  function buildPanelSlider(rootEl, field, value, onChange) {
    if (!rootEl) return null;  // Safety: element not found
    rootEl.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'panel-slider';

    const headRow = document.createElement('div');
    headRow.className = 'panel-slider-head';
    const name = document.createElement('span');
    name.className = 'control-label';
    name.textContent = field.label || field.name;
    const val = document.createElement('span');
    val.className = 'slider-value';
    val.textContent = formatNumber(value);
    headRow.appendChild(name);
    headRow.appendChild(val);

    const range = document.createElement('input');
    range.type = 'range';
    range.min  = field.min;
    range.max  = field.max;
    range.step = field.step;
    range.value = value;
    range.className = 'panel-slider-range';
    range.addEventListener('input', () => {
      const v = parseFloat(range.value);
      val.textContent = formatNumber(v);
      onChange(v);
    });

    wrap.appendChild(headRow);
    wrap.appendChild(range);
    rootEl.appendChild(wrap);
    return range;
  }

  /** Programmatically write a value into a slider built by buildPanelSlider
   *  (without firing the input event). */
  function setPanelSliderValue(rangeEl, value) {
    if (!rangeEl) return;
    rangeEl.value = value;
    const wrap = rangeEl.closest('.panel-slider');
    if (wrap) {
      const valEl = wrap.querySelector('.slider-value');
      if (valEl) valEl.textContent = formatNumber(value);
    }
  }

  // ── FPS slider (compact, lives in the playback bar) ─────────────────────
  /**
   * Build the small FPS slider used in each section's playback bar. Returns
   * an object with read/write helpers so the section can:
   *   - listen for live drags via the onChange callback,
   *   - mirror an externally driven fps change (e.g. when the section
   *     becomes active and we snap the global sync fps to the section
   *     default) without re-firing the change handler.
   */
  function buildFpsSlider(rootEl, initialFps, onChange) {
    rootEl.replaceChildren();
    const label = document.createElement('span');
    label.className = 'fps-label';
    label.textContent = 'fps';
    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'fps-slider';
    range.min = '1'; range.max = '60'; range.step = '1';
    range.value = String(initialFps);
    const val = document.createElement('span');
    val.className = 'slider-value fps-value';
    val.textContent = String(initialFps);
    range.addEventListener('input', () => {
      const v = parseInt(range.value, 10);
      val.textContent = String(v);
      if (Number.isFinite(v) && v > 0) onChange(v);
    });
    rootEl.appendChild(label);
    rootEl.appendChild(range);
    rootEl.appendChild(val);
    return {
      el: range,
      setValue(v) {
        if (!Number.isFinite(v)) return;
        range.value = String(v);
        val.textContent = String(v);
      },
    };
  }

  function formatNumber(v) {
    if (!Number.isFinite(v)) return '—';
    return Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  // ── HDR badge / banner ──────────────────────────────────────────────────
  function setHdrBadge(badgeEl, state) {
    if (!badgeEl) return;  // Safety: element not found
    badgeEl.dataset.state = state === HDR_STATE.HDR ? 'hdr'
                          : state === HDR_STATE.SDR ? 'sdr'
                          : 'unknown';
    const text = badgeEl.querySelector('.hdr-text');
    if (text) text.textContent = labelForState(state);
  }

  function setHdrHintVisible(bannerEl, visible) {
    if (!bannerEl) return;  // Safety: element not found
    bannerEl.hidden = !visible;
  }

  // ── Frame readout / scrub bar ───────────────────────────────────────────
  function setFrameReadout(el, idx, total) {
    if (!el) return;  // Safety: element not found
    el.textContent = `${idx} / ${total ? total - 1 : 0}`;
  }

  // ── Status pill ─────────────────────────────────────────────────────────
  function setLoadStatus(el, state, text) {
    if (!el) return;  // Safety: element not found
    if (state) el.dataset.state = state; else delete el.dataset.state;
    el.textContent = text || '';
  }

  // ── Diagnostics panel ───────────────────────────────────────────────────
  function setDiagnostics(el, lines) {
    if (!el) return;  // Safety: element not found
    el.replaceChildren();
    for (const ln of lines) {
      const span = document.createElement('div');
      if (ln.kind === 'ok')   span.className = 'diag-ok';
      if (ln.kind === 'warn') span.className = 'diag-warn';
      if (ln.kind === 'bad')  span.className = 'diag-bad';
      span.textContent = ln.text;
      el.appendChild(span);
    }
  }

  // ── Fatal overlay ──────────────────────────────────────────────────────
  function showFatal(message) {
    const overlay = document.getElementById('fatalOverlay');
    const msg = document.getElementById('fatalMessage');
    if (!overlay || !msg) return;  // Safety: elements not found
    msg.textContent = message;
    overlay.hidden = false;
  }

  // ── Exposure-bracket button row helpers ────────────────────────────────
  // The bracket buttons live in per-panel bracket rows; .active marks
  // which preset matches that panel's current exposure.

  function setActiveBracket(rowEl, bracketName) {
    if (!rowEl) return;  // Safety: element not found
    rowEl.querySelectorAll('.bracket-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.bracket === bracketName);
    });
  }

  function clearActiveBracket(rowEl) {
    if (!rowEl) return;  // Safety: element not found
    rowEl.querySelectorAll('.bracket-btn').forEach(btn => btn.classList.remove('active'));
  }

  function syncActiveBracketToExposure(rowEl, brackets, exposureValue) {
    if (!rowEl) return;  // Safety: element not found
    const eps = 1e-3;
    const match = brackets.find(b => Math.abs(b.exposure - exposureValue) < eps);
    if (match) setActiveBracket(rowEl, match.name);
    else       clearActiveBracket(rowEl);
  }

  /** Build a horizontal row of bracket buttons. Returns the row element
   *  for further manipulation (active-state syncing). */
  function buildBracketRow(rootEl, brackets, onPick) {
    if (!rootEl) return rootEl;  // Safety: element not found
    rootEl.replaceChildren();
    // Use classList.add so existing classes (e.g. 'pc-brackets') stay —
    // overwriting className would drop the CSS rule that centers the row.
    rootEl.classList.add('bracket-row');
    for (const b of brackets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bracket-btn';
      btn.dataset.bracket = b.name;
      btn.dataset.exposure = String(b.exposure);
      btn.textContent = b.label;
      btn.addEventListener('click', () => onPick(b));
      rootEl.appendChild(btn);
    }
  }

  return {
    buildSelectOptions,
    buildInlineSliders, refreshInlineSliders,
    buildPanelSlider, setPanelSliderValue,
    buildFpsSlider,
    buildBracketRow,
    setHdrBadge, setHdrHintVisible,
    setFrameReadout, setLoadStatus,
    setDiagnostics,
    showFatal,
    setActiveBracket, clearActiveBracket, syncActiveBracketToExposure,
    formatNumber,
  };
})();
