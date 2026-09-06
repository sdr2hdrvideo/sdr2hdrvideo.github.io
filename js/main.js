/* ──────────────────────────────────────────────────────────────────────────
 * main.js — multi-section orchestration for the paper supplement.
 *
 * Boots WebGPU, loads the manifest, mounts one ComparisonSection per
 * results category (wild → cinema → text_to_video → datasets → limitations).
 *
 * Each ComparisonSection owns its own SyncController, so the playback
 * bar in any section drives only that section's panels. Keyboard
 * shortcuts (space, ←/→, Home/End) target the most-recently-activated
 * section, where "activated" means the user clicked play, scrubbed, or
 * otherwise interacted with that section's playback bar.
 *
 * The floating nav bar holds:
 *   - SDR/HDR display radio
 *   - Three "look" sliders (pivot, contrast, saturation) that broadcast
 *     to every loaded panel of every section
 *   - reset + info buttons
 *
 * Per-panel exposure and per-panel tone mapper are owned by each section
 * (not here).
 * ────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  const { CONFIG, loadManifest } = window.App.config;
  const { detectHdrState, watchHdrState, HDR_STATE } = window.App.hdrCapability;
  const { setLinearizeMode } = window.App.toneMappers;
  const { ComparisonSection } = window.App.comparisonSection;
  const fileSource = window.App.fileSource;
  const UI = window.App.ui;

  const appState = {
    device: null,
    sections: [],         // ComparisonSection[]
    manifest: null,
    // Global look uniforms broadcast to every panel of every section.
    globalUniforms: {
      pivot:      CONFIG.toneMapperParams.pivot,
      contrast:   CONFIG.toneMapperParams.contrast,
      saturation: CONFIG.toneMapperParams.saturation,
    },
  };

  // Fields surfaced in the floating nav as inline sliders.
  const GLOBAL_SLIDER_FIELDS = [
    { name: 'pivot',      label: 'pivot',      min: 0.01, max: 1, step: 0.01, default: CONFIG.toneMapperParams.pivot },
    { name: 'contrast',   label: 'contrast',   min: 0.01, max: 2, step: 0.01, default: CONFIG.toneMapperParams.contrast },
    { name: 'saturation', label: 'saturation', min: 0,    max: 2, step: 0.01, default: CONFIG.toneMapperParams.saturation },
  ];

  function checkFeatures() {
    const missing = [];
    if (!('gpu' in navigator)) missing.push('WebGPU (navigator.gpu)');
    if (typeof VideoFrame !== 'function') missing.push('VideoFrame');
    if (typeof ResizeObserver !== 'function') missing.push('ResizeObserver');
    return missing;
  }

  async function boot() {
    const missing = checkFeatures();
    if (missing.length) { UI.showFatal(`Missing browser feature(s): ${missing.join(', ')}.`); return; }

    let adapter, device;
    try {
      adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('No WebGPU adapter available.');
      device = await adapter.requestDevice();
    } catch (err) {
      UI.showFatal(`WebGPU init failed: ${err.message || err}`); return;
    }
    appState.device = device;

    // Lock linearize mode to PQ EOTF (the only documented HDR input).
    setLinearizeMode('pq');

    setupDiagnostics(adapter, device);
    setupHdrBadge();
    setupInfoPopover();

    setupToneModeRadio();
    setupGlobalSliders();
    setupControlBarToggle();
    setupKeyboard();

    // ── Manifest ──────────────────────────────────────────────────────
    // Fetch manifest.json from the relative ./videos/ path. Works on
    // any http(s) host (including GitHub Pages) as long as the videos/
    // directory is committed alongside index.html.
    const manifest = await loadManifest();
    appState.manifest = manifest;

    // ── Display mode ──────────────────────────────────────────────────
    // Chosen from the detected display, with no prompt. Must happen before
    // mountSections() — each section reads the SDR/HDR radio for its
    // initialToneMode.
    setToneModeRadio(defaultToneMode());

    if (!appState.manifest) {
      const diag = document.getElementById('diagnostics');
      if (diag) {
        const ln = document.createElement('div');
        ln.className = 'diag-bad';
        ln.textContent = 'manifest.json not found — run encode.py first.';
        diag.appendChild(ln);
      }
      return;
    }
    mountSections();
  }

  /* ── Section mounting ───────────────────────────────────────────────── */

  function structureDatasets() {
    return Object.keys(appState.manifest.structure || {});
  }

  /**
   * Map our five section IDs to (datasets[], exposures[], showGT)
   * projections of the manifest.
   *
   * The manifest is a flat dataset→exposure→scene→method[] map; we
   * project subsets into each section.
   *
   * Wild content lives under dataset='wild' with the four pseudo-exposures
   * matching encode.py's WILD_CATEGORIES = (wild, cinema, text_to_video,
   * limitations). The datasets section pulls the real datasets (UBC,
   * Stuttgart) and exposes 'over' / 'under' as exposure tabs ('gt' is
   * promoted into both and never shown as a tab).
   */
  function sectionSpec(sectionId) {
    const all = structureDatasets();
    switch (sectionId) {
      case 'datasets':
        return { datasets: all.filter(d => d !== 'wild'),
                 exposures: ['over', 'under'],
                 showGT: true };
      case 'wild':
        return { datasets: ['wild'], exposures: ['wild'], showGT: false };
      case 'cinema':
        return { datasets: ['wild'], exposures: ['cinema'], showGT: false };
      case 'text_to_video':
        return { datasets: ['wild'], exposures: ['text_to_video'], showGT: false };
      case 'limitations':
        return { datasets: ['wild'], exposures: ['limitations'], showGT: false };
    }
    return { datasets: all, exposures: null, showGT: false };
  }

  function mountSections() {
    const sectionEls = document.querySelectorAll('.comp-section');
    sectionEls.forEach(secEl => {
      const sectionId = secEl.dataset.sectionId;
      const mount = secEl.querySelector('.comp-mount');
      if (!mount) return;
      const spec = sectionSpec(sectionId);
      // Only mount if some content exists.
      const struct = appState.manifest.structure || {};
      const hasContent = (spec.datasets || []).some(ds => {
        const exs = spec.exposures || Object.keys(struct[ds] || {});
        return exs.some(ex => Object.keys((struct[ds] || {})[ex] || {}).length > 0);
      });
      if (!hasContent) {
        const empty = document.createElement('p');
        empty.className = 'section-desc';
        empty.style.fontStyle = 'italic';
        empty.textContent = '(no clips encoded for this section — Please ensure you are using the correct videos/ directory.)';
        mount.appendChild(empty);
        return;
      }
      const sec = new ComparisonSection({
        mount,
        sectionId,
        manifest: appState.manifest,
        datasets: spec.datasets,
        exposures: spec.exposures,
        showGT: spec.showGT,
        device: appState.device,
        getGlobalUniforms: () => appState.globalUniforms,
        initialToneMode: (() => {
          const extEl = document.getElementById('tmExtended');
          return (extEl && extEl.checked) ? 'extended' : 'standard';
        })(),
        onActivate: (s) => activateSection(s),
      });
      appState.sections.push(sec);
    });

    // Auto-load every section's first scene so visitors don't land on
    // panels stuck in the "loading" state. Sections load in PARALLEL so
    // the user doesn't have to scroll past a half-loaded page or click
    // play just to trigger lazy-load on a section. The previous sequential
    // version meant later sections kept their "loading…" overlay until
    // the user interacted with them.
    Promise.all(
      appState.sections.map(sec =>
        sec._loadScene().catch(e => console.warn('section autoload failed', e))
      )
    ).then(() => {
      // Auto-play only the first section (In-the-Wild Videos). All other
      // sections start paused so the page isn't overwhelming on load.
      if (appState.sections.length) appState.sections[0].sync.play();
    });

    // Pre-activate the first section so keyboard shortcuts have a sane
    // default target before the user has clicked anything.
    if (appState.sections.length) activateSection(appState.sections[0]);
  }

  let activeSection = null;
  function activateSection(s) { activeSection = s; }

  /* ── Global control wiring ─────────────────────────────────────────── */

  function setupToneModeRadio() {
    const std = document.getElementById('tmStandard');
    const ext = document.getElementById('tmExtended');
    if (!std || !ext) return;  // Safety: elements not found
    const apply = () => {
      const mode = ext.checked ? 'extended' : 'standard';
      for (const s of appState.sections) s.setToneMode(mode);
    };
    std.addEventListener('change', apply);
    ext.addEventListener('change', apply);
  }

  function setupGlobalSliders() {
    const host = document.querySelector('[data-role="globalSliders"]');
    if (!host) return;
    UI.buildInlineSliders(host, GLOBAL_SLIDER_FIELDS, appState.globalUniforms, (name, value) => {
      appState.globalUniforms[name] = value;
      for (const s of appState.sections) s.onGlobalUniformsChanged();
    });
    const resetBtn = document.getElementById('resetSlidersBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        for (const f of GLOBAL_SLIDER_FIELDS) appState.globalUniforms[f.name] = f.default;
        UI.refreshInlineSliders(host, GLOBAL_SLIDER_FIELDS, appState.globalUniforms);
        for (const s of appState.sections) s.onGlobalUniformsChanged();
      });
    }
  }

  /**
   * Mobile-only: expand/collapse toggle on the floating control bar.
   * The bar starts collapsed on mobile (CSS hides the sliders + reset
   * by default at small viewports). The toggle button flips an
   * `.expanded` class on the bar, revealing the rest of the controls.
   */
  function setupControlBarToggle() {
    const bar = document.getElementById('floatingNav');
    const btn = document.getElementById('controlBarToggle');
    if (!bar || !btn) return;
    btn.addEventListener('click', () => {
      const expanded = bar.classList.toggle('expanded');
      btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  }

  /**
   * Keyboard shortcuts target the most-recently-activated section. With
   * per-section SyncControllers, there is no global "current frame" any
   * more — pressing space on a page with five sections has to pick
   * exactly one. We resolve that by remembering whichever section the
   * user last clicked play / scrubbed / chose a scene in.
   */
  function setupKeyboard() {
    const target = () => activeSection && activeSection.sync;
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const sync = target();
      if (!sync) return;
      switch (e.key) {
        case ' ':          e.preventDefault(); sync.toggle(); break;
        case 'ArrowLeft':  e.preventDefault(); sync.pause(); sync.stepFrame(-1); break;
        case 'ArrowRight': e.preventDefault(); sync.pause(); sync.stepFrame(+1); break;
        case 'Home':       e.preventDefault(); sync.pause(); sync.setFrame(0); break;
        case 'End':        e.preventDefault(); sync.pause(); sync.setFrame(CONFIG.frameCount - 1); break;
      }
    });
  }

  /* ── Diagnostics popover ───────────────────────────────────────────── */

  function setupInfoPopover() {
    const btn   = document.getElementById('infoBtn');
    const popup = document.getElementById('infoPopover');
    const close = document.getElementById('infoCloseBtn');
    if (!btn || !popup || !close) return;  // Safety: elements not found
    popup.hidden = true;
    btn.addEventListener('click', () => { popup.hidden = !popup.hidden; });
    close.addEventListener('click', () => { popup.hidden = true; });
    popup.addEventListener('click', (e) => {
      if (e.target === popup) popup.hidden = true;
    });
  }

  function setupHdrBadge() {
    const badgeEl = document.getElementById('hdrBadge');
    const hintEl  = document.getElementById('hdrHint');
    if (!badgeEl) return;  // Safety: element not found
    const initial = detectHdrState();
    UI.setHdrBadge(badgeEl, initial);
    if (hintEl) UI.setHdrHintVisible(hintEl, initial === HDR_STATE.HDR);
    watchHdrState(state => {
      UI.setHdrBadge(badgeEl, state);
      if (hintEl) UI.setHdrHintVisible(hintEl, state === HDR_STATE.HDR);
    });
  }

  function setupDiagnostics(adapter, device) {
    const diagEl = document.getElementById('diagnostics');
    if (!diagEl) return;  // Safety: element not found
    const lines = [];
    const info = adapter.info || {};
    if (info.vendor)       lines.push({ kind: '',   text: `gpu vendor: ${info.vendor}` });
    if (info.architecture) lines.push({ kind: '',   text: `gpu arch:   ${info.architecture}` });
    lines.push({ kind: 'ok', text: 'webgpu     ready' });
    lines.push({ kind: 'ok', text: 'videoframe ready' });
    lines.push({ kind: '',   text: `target fps ${CONFIG.fps}` });
    lines.push({ kind: '',   text: `frames/seq ${CONFIG.frameCount}` });
    lines.push({ kind: '',   text: `linearize  PQ EOTF (fixed)` });
    UI.setDiagnostics(diagEl, lines);
  }

  /* ── Display mode ─────────────────────────────────────────────────────
   * The mode is chosen from the detected display rather than asked for:
   *   - HDR display, single monitor → HDR
   *   - SDR display                 → SDR
   *   - multiple displays           → SDR, since we can't tell which
   *     monitor the window will actually be viewed on.
   *
   * The SDR/HDR prompt that used to run here is commented out below,
   * kept in case we want to offer the choice again.
   */

  /** Check the SDR/HDR radio without notifying sections. Sections read this
   *  radio for their initialToneMode, so this must run before mounting. */
  function setToneModeRadio(mode) {
    const el = document.getElementById(mode === 'extended' ? 'tmExtended' : 'tmStandard');
    if (el) el.checked = true;
  }

  /** Pick the default mode for this display. */
  function defaultToneMode() {
    const isHdr = detectHdrState() === HDR_STATE.HDR;
    const isMulti =
      (typeof window.screen !== 'undefined' && window.screen.isExtended === true);
    return (isHdr && !isMulti) ? 'extended' : 'standard';
  }

  /* ── Disabled: SDR/HDR prompt ─────────────────────────────────────────
   * Shown on load, asking the user to confirm the display mode. Replaced
   * by defaultToneMode() above. Kept here for reference.
   *
   * function applyToneMode(mode) {
   *   const el = document.getElementById(mode === 'extended' ? 'tmExtended' : 'tmStandard');
   *   if (!el) return;
   *   el.checked = true;
   *   el.dispatchEvent(new Event('change'));
   * }
   *
   * function showDisplayModePrompt() {
   *   const overlay = document.getElementById('displayModePrompt');
   *   if (!overlay) return;
   *
   *   const isHdr = detectHdrState() === HDR_STATE.HDR;
   *   const isMulti =
   *     (typeof window.screen !== 'undefined' && window.screen.isExtended === true);
   *
   *   // Nothing to offer on a single SDR display — stay quiet.
   *   if (!isHdr && !isMulti) return;
   *
   *   const titleEl = overlay.querySelector('[data-role="dmpTitle"]');
   *   const leadEl  = overlay.querySelector('[data-role="dmpLead"]');
   *   const multiEl = overlay.querySelector('[data-role="dmpMulti"]');
   *   const hdrBtn  = overlay.querySelector('[data-dm-choice="extended"]');
   *   const sdrBtn  = overlay.querySelector('[data-dm-choice="standard"]');
   *
   *   if (titleEl) titleEl.textContent = isHdr ? 'HDR display detected'
   *                                            : 'Multiple displays detected';
   *   if (leadEl)  leadEl.innerHTML    = isHdr ? 'Showing results in <strong>HDR</strong>.'
   *                                            : 'Showing results in <strong>SDR</strong>.';
   *   if (multiEl) multiEl.hidden = !isMulti;
   *
   *   // Without an HDR display the HDR button can't do anything useful, so
   *   // it stays disabled and SDR becomes the emphasised choice.
   *   if (hdrBtn) {
   *     hdrBtn.disabled = !isHdr;
   *     hdrBtn.textContent = isHdr ? 'Keep HDR' : 'HDR unavailable';
   *     if (isHdr) hdrBtn.removeAttribute('aria-disabled');
   *     else       hdrBtn.setAttribute('aria-disabled', 'true');
   *   }
   *   if (sdrBtn) {
   *     sdrBtn.classList.toggle('primary-btn', !isHdr);
   *     sdrBtn.classList.toggle('ghost-btn',    isHdr);
   *     sdrBtn.textContent = isHdr ? 'Use SDR' : 'Continue in SDR';
   *   }
   *
   *   overlay.hidden = false;
   *
   *   const ac = new AbortController();
   *   const close = (mode) => {
   *     ac.abort();
   *     if (mode) applyToneMode(mode === 'extended' && !isHdr ? 'standard' : mode);
   *     overlay.hidden = true;
   *   };
   *   overlay.querySelectorAll('[data-dm-choice]').forEach(btn => {
   *     btn.addEventListener('click', () => close(btn.dataset.dmChoice), { signal: ac.signal });
   *   });
   * }
   */

  boot().catch(err => {
    console.error('Boot failed:', err);
    UI.showFatal(`Initialization error: ${err.message || err}`);
  });
})();
