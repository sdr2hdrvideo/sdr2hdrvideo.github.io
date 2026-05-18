/* ──────────────────────────────────────────────────────────────────────────
 * comparisonSection.js — a reusable, self-contained "video-vs-video"
 * comparison module.
 *
 * Per-section state:
 *   - own SyncController instance (per-section timeline; sections do NOT
 *     share playback state — this is a deliberate change from earlier
 *     versions where one global controller drove every section in lockstep)
 *   - optional dataset tab row (only when datasets.length > 1)
 *   - optional exposure tab row (only when exposures.length > 1)
 *   - thumbnail rail of scenes (labels hidden when CONFIG.showSceneNames=false)
 *   - per-panel control block above the panel grid:
 *       method <select>  (display name via methodDisplayName())
 *       tone-mapper <select>   (greyed when method='Input')
 *       exposure slider in EV
 *       exposure bracket row (−4..+4 EV, centered)
 *   - chain/link toggle between the two control blocks. When linked, both
 *     exposure changes AND tone-mapper changes mirror to the other panel
 *     (the mirror skips Input panels, which lock their tone mapper to the
 *     passthrough).
 *   - comp-stage: panel-grid (side-by-side OR split-slider mode) +
 *     fullscreen-only vertical scene-strip + scene-prompt (only for
 *     text_to_video) + playback bar. The whole stage is what goes
 *     fullscreen.
 *   - playback bar: play/pause | scrub | fps slider | (status, hidden
 *     when state==ready) | display-mode toggle | fullscreen button.
 *   - hover-zoom drawer (lives outside comp-stage; not visible in
 *     fullscreen)
 *
 * SDR / HDR canvas mode
 * ─────────────────────
 * Each section owns a `currentToneMode` ('standard' | 'extended') which
 * is driven by the global SDR/HDR radio in the floating nav. Panels
 * hosting the 'Input' pseudo-method (SDR libx264 source) are *always*
 * pinned to 'standard' regardless of the global toggle — see
 * _applyMethodLockState and setToneMode below.
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.comparisonSection = (function () {
  'use strict';

  const {
    CONFIG, videoSource, thumbnailSource, sectionFps, orderScenes,
    promptFromSceneName, methodDisplayName, datasetDisplayName,
  } = window.App.config;
  const { Panel } = window.App.panel;
  const { HoverZoom } = window.App.hoverZoom;
  const { SyncController } = window.App.syncController;
  const {
    listToneMappers, getToneMapper, getToneMapperForMethod,
    isMethodLocked, EXPOSURE_BRACKETS, DEFAULT_TONE_MAPPER_NAME,
  } = window.App.toneMappers;
  const thumbs = window.App.thumbnails;
  const UI = window.App.ui;

  /* ── EV ↔ multiplier helpers ────────────────────────────────────────
   * The shader consumes exposure as a linear multiplier (1.0 = no change,
   * 2.0 = +1 stop, 0.5 = −1 stop). Internally we keep multipliers (so
   * EXPOSURE_BRACKETS stays unchanged and the linked-panel sync works on
   * the same number across sides). The slider, by contrast, is EV-scaled:
   * a linear EV slider has uniform "stop" feel across its range, whereas
   * a linear multiplier slider 0..16 crams 90% of useful range into the
   * bottom 6%. We convert at the slider boundary only.
   */
  const evToMul = (ev) => Math.pow(2, ev);
  const mulToEv = (mul) => Math.log2(Math.max(mul, 1e-6));

  // Exposure slider in EV space. Bracket buttons cover ±4 EV (common cases);
  // the slider extends to ±8 EV for scenes that need extreme adjustment.
  const EXPOSURE_FIELD = {
    name: 'exposure',
    label: 'exposure (EV)',
    min: -8, max: 8, step: 0.1, default: 0,
  };

  class ComparisonSection {
    /**
     * @param opts {
     *   mount:        HTMLElement,
     *   sectionId:    string,
     *   manifest:     object,
     *   datasets:     string[]|null,
     *   exposures:    string[]|null,
     *   showGT:       boolean,
     *   device:       GPUDevice,
     *   getGlobalUniforms: () => { pivot, contrast, saturation },
     *   initialToneMode: 'standard'|'extended',
     *   onActivate:   (section) => void,
     * }
     */
    constructor(opts) {
      this.opts        = opts;
      this.mount       = opts.mount;
      this.device      = opts.device;
      this.manifest    = opts.manifest;
      this.sectionId   = opts.sectionId;
      this.datasets    = opts.datasets;
      this.exposures   = opts.exposures;
      this.showGT      = !!opts.showGT;
      this.getGlobalUniforms = opts.getGlobalUniforms || (() => ({}));

      // ── Per-section SyncController ──────────────────────────────────
      // Earlier versions shared one global controller across every
      // section, which meant hitting play in one section started every
      // other section too. We now own a controller per section; the
      // playback bar buttons here only drive this section's panels.
      this.sync = new SyncController({
        frameCount: CONFIG.frameCount,
        fps: sectionFps(this.sectionId),
      });

      this.panels       = [];
      this.panelMethods = ['', ''];

      // Global SDR/HDR canvas mode, tracked at section level so we can
      // override it to 'standard' on a per-panel basis when the panel
      // hosts an Input pseudo-method (whose mp4 is plain SDR libx264 and
      // must NOT be run through the 'extended' canvas tone-mapping mode).
      this.currentToneMode = opts.initialToneMode || 'standard';

      // Per-panel local state.
      this.panelExposures   = [1.0, 1.0];  // multipliers
      this.panelToneMappers = [DEFAULT_TONE_MAPPER_NAME, DEFAULT_TONE_MAPPER_NAME];
      // Remember the user-chosen mapper so we can restore it after the panel
      // briefly hosts the 'Input' method (which forces the input mapper).
      this.panelUserMappers = [DEFAULT_TONE_MAPPER_NAME, DEFAULT_TONE_MAPPER_NAME];

      // Link: when true, exposure + tone-mapper changes mirror to the
      // sibling panel (skipping the mirror when the sibling is Input).
      this.linked = true;

      // Playback-bar exposure slider handles (wired in _wirePlaybackBar).
      this._pbExpSlider = null;
      this._pbExpValue  = null;

      // Display mode for the panel grid: 'split' (default) presents both
      // panels in the same image area with a draggable vertical divider;
      // 'side' falls back to a 2-col grid. Default is split because the
      // primary use-case for this supplement is comparing two methods'
      // output on the same scene, where overlaying is more telling than
      // side-by-side.
      this.displayMode = 'split';
      this.splitPosition = 50;  // percent from left, used by .split-divider

      // Per-panel DOM handles (filled in _buildPanelControls).
      this.panelCtrls = [
        { methodSel: null, toneSel: null, expSlider: null, bracketRow: null },
        { methodSel: null, toneSel: null, expSlider: null, bracketRow: null },
      ];

      this.selection = { dataset: null, exposure: null, scene: null };
      this.loadToken = 0;
      this.loaded = false;

      // Per-section fps; applied on activation.
      this.sectionFps = sectionFps(this.sectionId);

      this._build();

      this.sync.addListener({
        onFrame:     (idx)     => this.drawFrame(idx),
        onPlayState: (playing) => this.setPlayIcon(playing),
      });
    }

    /* ── DOM build ─────────────────────────────────────────────────── */
    _build() {
      const root = document.createElement('div');
      root.className = 'comp-block';

      // Tab row(s): dataset and/or exposure pills.
      this.tabRow = document.createElement('div');
      this.tabRow.className = 'tab-row';
      root.appendChild(this.tabRow);

      // Thumbnail rail.
      this.thumbRail = document.createElement('div');
      this.thumbRail.className = 'thumb-rail';
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'thumb-rail-wrap';
      thumbWrap.appendChild(this.thumbRail);
      root.appendChild(thumbWrap);

      // Per-panel control row (grid: 1fr auto 1fr; link button in the middle).
      this.controlsRow = document.createElement('div');
      this.controlsRow.className = 'comp-controls';
      root.appendChild(this.controlsRow);

      // Stage wrapper: this is what goes fullscreen — panel-grid + scene
      // prompt + playback bar all need to stay together once we expand.
      this.compStage = document.createElement('div');
      this.compStage.className = 'comp-stage';
      this.compStage.dataset.fullscreen = '0';
      root.appendChild(this.compStage);

      // Fullscreen-only vertical scene strip on the left edge of the
      // stage. We append it now so the CSS can show/hide via the
      // [data-fullscreen] attribute on .comp-stage. Populated by
      // _rebuildFullscreenSceneStrip() after thumbnails are known.
      this.fsSceneStrip = document.createElement('div');
      this.fsSceneStrip.className = 'fs-scene-strip';
      this.compStage.appendChild(this.fsSceneStrip);

      // Container that holds the panel-grid + scene-prompt + playback-bar.
      // Used to keep the stage layout (scene-strip + content column) tidy
      // when fullscreen flips the comp-stage to a flex row.
      this.fsContent = document.createElement('div');
      this.fsContent.className = 'fs-stage-content';
      this.compStage.appendChild(this.fsContent);

      // Panel grid (with data-display for side/split modes).
      this.panelGrid = document.createElement('div');
      this.panelGrid.className = 'panel-grid';
      this.panelGrid.dataset.display = this.displayMode;
      this.fsContent.appendChild(this.panelGrid);

      // Split-mode divider — only interactive in split mode. We always
      // append it so the CSS can show/hide via [data-display].
      this.splitDivider = document.createElement('div');
      this.splitDivider.className = 'split-divider';
      this.splitDivider.setAttribute('aria-label', 'split-screen slider');
      this.splitDivider.innerHTML = '<div class="split-divider-handle"></div>';
      this.panelGrid.appendChild(this.splitDivider);
      this._wireSplitDivider();
      this._applySplitPosition();

      // Coverr attribution — absolute overlay on the panel-grid bottom-right.
      // Uses <span> (not <div>) so it doesn't shift the div:nth-of-type counts
      // that the split-mode CSS relies on to identify panel[0] and panel[1].
      this.coverrAttrEl = document.createElement('span');
      this.coverrAttrEl.className = 'coverr-attribution';
      this.coverrAttrEl.textContent = 'Input SDR video sourced from coverr.co';
      this.coverrAttrEl.hidden = true;
      this.panelGrid.appendChild(this.coverrAttrEl);

      // Scene title — shown for cinema scenes between panel-grid and playback bar.
      this.sceneTitleEl = document.createElement('div');
      this.sceneTitleEl.className = 'scene-title';
      this.sceneTitleEl.hidden = true;
      this.fsContent.appendChild(this.sceneTitleEl);

      // Scene prompt (used for text_to_video; hidden otherwise).
      this.scenePromptEl = document.createElement('div');
      this.scenePromptEl.className = 'scene-prompt';
      this.scenePromptEl.hidden = true;
      this.fsContent.appendChild(this.scenePromptEl);

      // Playback bar. The initial active dm-btn matches this.displayMode
      // (default 'split' → Slider is active). Don't print the resting
      // 'ready' status — only show text on transient states.
      this.playbackBar = document.createElement('div');
      this.playbackBar.className = 'playback-bar';
      this.playbackBar.innerHTML = `
        <button class="playback-btn" type="button" aria-label="play/pause" data-role="play">
          <span data-role="playIcon">▶</span>
        </button>
        <div class="playback-frame">
          <span class="playback-label">frame</span>
          <span class="frame-readout" data-role="frameReadout">0 / 0</span>
        </div>
        <input type="range" class="scrub" data-role="scrub" min="0" max="0" step="1" value="0" aria-label="scrub">
        <div class="playback-fps" data-role="fpsHost"></div>
        <div class="playback-status" data-role="status" data-state="ready"></div>
        <div class="display-mode-toggle" role="group" aria-label="display mode">
          <button type="button" class="dm-btn ${this.displayMode === 'side'  ? 'active' : ''}" data-mode="side"  title="Side-by-side">Side</button>
          <button type="button" class="dm-btn ${this.displayMode === 'split' ? 'active' : ''}" data-mode="split" title="Split-screen slider">Slider</button>
        </div>
        <button class="fullscreen-btn" type="button" data-role="fullscreen"
                aria-label="toggle fullscreen" title="Toggle fullscreen">
          <span class="fs-icon" aria-hidden="true">⛶</span>
          <span class="fs-label">Full Screen</span>
        </button>
      `;
      this.fsContent.appendChild(this.playbackBar);

      this.mount.appendChild(root);

      // Build order matters: controls + panels first so the tab build (which
      // cascades into thumbnail/method-select population) can safely reach
      // into both.
      this._buildPanelControls();
      this._buildPanels();
      this._buildTabs();
      this._wirePlaybackBar();
      this._wireDisplayModeToggle();
      this._wireFullscreen();

      // Hover-zoom (after panels exist). Open by default. Appended to
      // comp-block (NOT comp-stage), so it's not part of fullscreen.
      this.hoverZoom = new HoverZoom({
        container: root,
        panelGrid: this.panelGrid,
        panels: this.panels,
        labels: [this.panelMethods[0] || 'Left', this.panelMethods[1] || 'Right'],
      });
      // Sync initial display mode so HoverZoom starts in the right state.
      this.hoverZoom.setDisplayMode(this.displayMode);
    }

    /* ── Tabs (dataset/exposure pills) ───────────────────────────── */
    _buildTabs() {
      this.tabRow.replaceChildren();
      const structure = this.manifest.structure || {};

      // Dataset tab group (only show if user has >1 dataset to switch).
      const datasetKeys = this.datasets || Object.keys(structure);
      if (datasetKeys.length > 1) {
        const grp = document.createElement('div');
        grp.className = 'tab-row-group';
        const lbl = document.createElement('span');
        lbl.className = 'tab-row-label';
        lbl.textContent = 'dataset';
        const pills = document.createElement('div');
        pills.className = 'pill-tabs';
        for (const ds of datasetKeys) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'pill-tab';
          // Use the display-name helper so acronyms like UBC render in
          // all caps. The pill's data-value stays the canonical key.
          btn.textContent = datasetDisplayName(ds);
          btn.dataset.value = ds;
          btn.addEventListener('click', () => this._chooseDataset(ds));
          pills.appendChild(btn);
        }
        grp.appendChild(lbl);
        grp.appendChild(pills);
        this.tabRow.appendChild(grp);
        this._datasetPills = pills;
      }

      // Exposure tab group host (populated by _rebuildExposureTabs).
      this.exposurePillsHost = document.createElement('div');
      this.exposurePillsHost.className = 'tab-row-group';
      this.tabRow.appendChild(this.exposurePillsHost);

      // Pick initial dataset.
      this.selection.dataset = datasetKeys[0];
      this._refreshDatasetActive();
      this._rebuildExposureTabs();
    }

    _refreshDatasetActive() {
      if (!this._datasetPills) return;
      this._datasetPills.querySelectorAll('.pill-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === this.selection.dataset);
      });
    }

    _rebuildExposureTabs() {
      this.exposurePillsHost.replaceChildren();
      const structure = this.manifest.structure || {};
      const present = Object.keys((structure[this.selection.dataset] || {}))
        .filter(k => k !== 'gt')
        .sort();
      const exposures = (this.exposures || present).filter(e => present.includes(e));

      if (!exposures.length) {
        this.selection.exposure = null;
        this._rebuildThumbnails();
        return;
      }
      if (exposures.length > 1) {
        const lbl = document.createElement('span');
        lbl.className = 'tab-row-label';
        lbl.textContent = 'exposure';
        const pills = document.createElement('div');
        pills.className = 'pill-tabs';
        this._exposurePills = pills;
        for (const ex of exposures) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'pill-tab';
          btn.textContent = ex;
          btn.dataset.value = ex;
          btn.addEventListener('click', () => this._chooseExposure(ex));
          pills.appendChild(btn);
        }
        this.exposurePillsHost.appendChild(lbl);
        this.exposurePillsHost.appendChild(pills);
      } else {
        this._exposurePills = null;
      }
      this.selection.exposure = exposures.includes('over') ? 'over' : exposures[0];
      this._refreshExposureActive();
      this._rebuildThumbnails();
    }

    _refreshExposureActive() {
      if (!this._exposurePills) return;
      this._exposurePills.querySelectorAll('.pill-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === this.selection.exposure);
      });
    }

    _chooseDataset(ds) {
      if (ds === this.selection.dataset) return;
      this.selection.dataset = ds;
      this._refreshDatasetActive();
      this._rebuildExposureTabs();
    }

    _chooseExposure(ex) {
      if (ex === this.selection.exposure) return;
      this.selection.exposure = ex;
      this._refreshExposureActive();
      this._rebuildThumbnails();
    }

    /* ── Per-panel controls (method select / tone mapper / exposure) */
    _buildPanelControls() {
      this.controlsRow.replaceChildren();

      const leftBlock  = document.createElement('div');
      leftBlock.className = 'panel-controls';
      this._buildOnePanelControlBlock(leftBlock, 0);

      // Vertical column: chain button on top, "LINK" label below for
      // discoverability — paper reviewers won't know what an unlabelled
      // chain symbol does.
      const linkCell = document.createElement('div');
      linkCell.className = 'link-toggle-cell';
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'link-toggle' + (this.linked ? ' active' : '');
      link.dataset.role = 'link';
      link.title = this.linked
        ? 'Linked — exposure & tone mapper sync between panels. Click to unlink.'
        : 'Unlinked — panels controlled independently. Click to link.';
      link.setAttribute('aria-label', 'link controls between panels');
      link.textContent = this.linked ? '⛓' : '⛓̸';
      link.addEventListener('click', () => this._toggleLink());
      this._linkBtn = link;

      const linkLbl = document.createElement('span');
      linkLbl.className = 'link-toggle-label';
      linkLbl.dataset.role = 'linkLabel';
      linkLbl.textContent = 'Link';
      this._linkLbl = linkLbl;

      linkCell.appendChild(link);
      linkCell.appendChild(linkLbl);

      const rightBlock = document.createElement('div');
      rightBlock.className = 'panel-controls';
      this._buildOnePanelControlBlock(rightBlock, 1);

      this.controlsRow.appendChild(leftBlock);
      this.controlsRow.appendChild(linkCell);
      this.controlsRow.appendChild(rightBlock);
    }

    _toggleLink() {
      if (!this._linkBtn) return;  // Safety: element not found
      this.linked = !this.linked;
      this._linkBtn.classList.toggle('active', this.linked);
      this._linkBtn.textContent = this.linked ? '⛓' : '⛓̸';
      this._linkBtn.title = this.linked
        ? 'Linked — exposure & tone mapper sync between panels. Click to unlink.'
        : 'Unlinked — panels controlled independently. Click to link.';
      // Sync panel 1 to panel 0 when re-linking (Lightroom-style "sync now"),
      // so users don't end up with a mysterious offset.
      if (this.linked) {
        this._setPanelExposure(1, this.panelExposures[0], { mirror: false });
        // Also sync the tone mapper (if right panel isn't Input).
        if (!isMethodLocked(this.panelMethods[1])) {
          // If panel 0 is currently Input-locked its panelToneMappers[0] holds
          // the passthrough mapper name, which panel 1's dropdown doesn't have
          // as an option — causing it to display Null. Use the user-chosen
          // mapper (or the default) from panel 0 instead.
          const srcMapper = isMethodLocked(this.panelMethods[0])
            ? (this.panelUserMappers[0] || DEFAULT_TONE_MAPPER_NAME)
            : (this.panelToneMappers[0] || DEFAULT_TONE_MAPPER_NAME);
          this._setPanelToneMapper(1, srcMapper, { mirror: false });
        }
      }
    }

    _buildOnePanelControlBlock(host, idx) {
      // Method select
      const methodCell = document.createElement('div');
      methodCell.className = 'pc-row pc-method';
      const methodLbl = document.createElement('span');
      methodLbl.className = 'control-label';
      methodLbl.textContent = idx === 0 ? 'method · left' : 'method · right';
      const methodSel = document.createElement('select');
      methodSel.className = 'method-select';
      methodSel.id = `${this.sectionId}-methodSelect-${idx}`;
      methodCell.appendChild(methodLbl);
      methodCell.appendChild(methodSel);

      // Tone mapper select
      const toneCell = document.createElement('div');
      toneCell.className = 'pc-row pc-tone';
      const toneLbl = document.createElement('span');
      toneLbl.className = 'control-label';
      toneLbl.textContent = 'tone mapper';
      const toneSel = document.createElement('select');
      toneSel.className = 'tone-select';
      const tmList = listToneMappers();
      for (const m of tmList) {
        const opt = document.createElement('option');
        opt.value = m.name; opt.textContent = m.label || m.name;
        toneSel.appendChild(opt);
      }
      toneSel.value = DEFAULT_TONE_MAPPER_NAME;
      toneSel.addEventListener('change', () => this._onPanelToneMapperChange(idx, toneSel.value));
      toneCell.appendChild(toneLbl);
      toneCell.appendChild(toneSel);

      // Exposure slider — EV space, see comment on EXPOSURE_FIELD.
      const expCell = document.createElement('div');
      expCell.className = 'pc-row pc-exposure';
      const expSlider = UI.buildPanelSlider(expCell, EXPOSURE_FIELD,
        mulToEv(this.panelExposures[idx]),
        (ev) => this._setPanelExposure(idx, evToMul(ev), { mirror: true }));

      // Bracket row (centered in CSS).
      const bracketCell = document.createElement('div');
      bracketCell.className = 'pc-row pc-brackets';
      UI.buildBracketRow(bracketCell, EXPOSURE_BRACKETS, (b) => {
        this._setPanelExposure(idx, b.exposure, { mirror: true });
      });
      UI.syncActiveBracketToExposure(bracketCell, EXPOSURE_BRACKETS, this.panelExposures[idx]);

      host.appendChild(methodCell);
      host.appendChild(toneCell);
      host.appendChild(expCell);
      host.appendChild(bracketCell);

      this.panelCtrls[idx] = {
        methodSel,
        toneSel,
        expSlider,
        bracketRow: bracketCell,
      };
    }

    _onPanelToneMapperChange(idx, mapperName) {
      // The user-driven path: applies to this panel, mirrors to the
      // sibling when linked & the sibling isn't a locked-Input panel.
      this._setPanelToneMapper(idx, mapperName, { mirror: true });
    }

    /**
     * Apply a tone-mapper choice to panel `idx`. Keeps panelToneMappers and
     * panelUserMappers in sync so the choice survives a future Input ↔
     * non-Input flip. If `mirror` and link is on, mirror to the other panel
     * (skipping the mirror when the other panel is Input-locked).
     */
    _setPanelToneMapper(idx, mapperName, { mirror }) {
      this.panelToneMappers[idx] = mapperName;
      this.panelUserMappers[idx] = mapperName;
      const mapper = getToneMapper(mapperName);
      if (mapper && this.panels[idx]) {
        this.panels[idx].swapToneMapper(mapper);
        this._applyPanelUniforms(idx);
      }
      const { toneSel } = this.panelCtrls[idx];
      if (toneSel && toneSel.value !== mapperName) toneSel.value = mapperName;

      if (mirror && this.linked) {
        const other = 1 - idx;
        // Don't fight the Input lock — Input always uses the passthrough
        // mapper, mirroring would force a re-apply on the next method
        // toggle anyway.
        if (isMethodLocked(this.panelMethods[other])) return;
        if (this.panelToneMappers[other] === mapperName) return;
        this._setPanelToneMapper(other, mapperName, { mirror: false });
      }
    }

    /** Update panel `idx`'s exposure (canonical multiplier value). If
     *  `mirror` is true and panels are linked, also update the other panel. */
    _setPanelExposure(idx, value, { mirror }) {
      this.panelExposures[idx] = value;
      const c = this.panelCtrls[idx];
      UI.setPanelSliderValue(c.expSlider, mulToEv(value));
      UI.syncActiveBracketToExposure(c.bracketRow, EXPOSURE_BRACKETS, value);
      this._applyPanelUniforms(idx);
      if (mirror && this.linked) {
        const other = 1 - idx;
        if (Math.abs(this.panelExposures[other] - value) > 1e-6) {
          this.panelExposures[other] = value;
          const oc = this.panelCtrls[other];
          UI.setPanelSliderValue(oc.expSlider, mulToEv(value));
          UI.syncActiveBracketToExposure(oc.bracketRow, EXPOSURE_BRACKETS, value);
          this._applyPanelUniforms(other);
        }
      }
      this._syncPbExposure();
    }

    /** Keep the playback-bar EV slider in sync with panel 0's exposure. */
    _syncPbExposure() {
      if (!this._pbExpSlider) return;
      const ev0 = mulToEv(this.panelExposures[0]);
      this._pbExpSlider.value = String(ev0);
      if (this._pbExpValue) this._pbExpValue.textContent = ev0.toFixed(1);
    }

    /* ── Thumbnails ───────────────────────────────────────────────── */
    _rebuildThumbnails() {
      this.thumbRail.replaceChildren();
      const structure = this.manifest.structure || {};
      const rawScenes = Object.keys(
        ((structure[this.selection.dataset] || {})[this.selection.exposure] || {})
      );
      const scenes = orderScenes(this.sectionId, rawScenes);
      if (!scenes.length) {
        const empty = document.createElement('div');
        empty.className = 'thumb-card-label';
        empty.style.padding = '20px';
        empty.textContent = 'no scenes available';
        this.thumbRail.appendChild(empty);
        this._rebuildFullscreenSceneStrip([]);
        return;
      }
      // Preserve the current scene selection when switching between exposures or
      // datasets that share the same scene names (e.g. over → under). Fall back
      // to the first scene only when the previous selection isn't present.
      const prevScene = this.selection.scene;
      this.selection.scene = (prevScene && scenes.includes(prevScene)) ? prevScene : scenes[0];

      // Build all cards first (without thumbnail content) so the user
      // sees the scene rail immediately. Thumbnail decoding is deferred
      // until after the active scene's videos have been kicked off.
      const showNames = !!CONFIG.showSceneNames;
      const pendingThumbs = [];
      for (const scene of scenes) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'thumb-card';
        card.dataset.scene = scene;
        const img = document.createElement('img');
        img.className = 'thumb-card-img';
        img.alt = scene;
        card.appendChild(img);
        if (showNames) {
          const lbl = document.createElement('div');
          lbl.className = 'thumb-card-label';
          lbl.textContent = scene;
          card.appendChild(lbl);
        }
        card.addEventListener('click', () => this._chooseScene(scene));
        this.thumbRail.appendChild(card);

        // First try a precomputed thumbnail (encode.py writes one per
        // scene into videos/thumbnails/{dataset}/{exposure}/{scene}.jpg).
        // If present, set the <img src> directly to a blob URL with zero
        // video-decoder usage. Otherwise queue a JS-side decode as a
        // fallback (older folders without precomputed thumbs).
        const precomputed = thumbnailSource(
          this.selection.dataset, this.selection.exposure, scene);
        if (precomputed && precomputed.url) {
          img.src = precomputed.url;
          // We deliberately do NOT revoke here — the blob URL must remain
          // live for the lifetime of the <img> element. The browser GC
          // will reclaim it when the card is replaced.
        } else {
          pendingThumbs.push({ img, scene });
        }
      }

      // Kick off any JS-decode fallbacks asynchronously, AFTER yielding
      // control so the active scene can start loading first. Each
      // thumbnail still goes through the existing serial queue inside
      // window.App.thumbnails so we don't trash the video decoder.
      if (pendingThumbs.length) {
        setTimeout(() => {
          for (const { img, scene } of pendingThumbs) {
            const methodsHere = this._methodsForScene(scene);
            const thumbMethod = methodsHere.includes('Input') ? 'Input' : methodsHere[0];
            if (!thumbMethod) continue;
            const src = videoSource(this.selection.dataset, this.selection.exposure, scene, thumbMethod);
            if (!src.url) continue;
            thumbs.request(src.url).then(dataUrl => {
              if (dataUrl) img.src = dataUrl;
              if (src.dispose) src.dispose();
            });
          }
        }, 0);
      }

      this._refreshSceneActive();
      this._populateMethodSelects();
      this._updateScenePrompt();
      this._rebuildFullscreenSceneStrip(scenes);
      // Reload the viewer when the user switches dataset or exposure tabs.
      // Guard on this.loaded so we don't double-load during initial build
      // (mountSections already calls _loadScene after construction).
      if (scenes.length && this.loaded) this._loadScene();
    }

    _refreshSceneActive() {
      if (this.thumbRail) {
        this.thumbRail.querySelectorAll('.thumb-card').forEach(c => {
          c.classList.toggle('active', c.dataset.scene === this.selection.scene);
        });
      }
      // Mirror the active state onto the fullscreen scene strip.
      if (this.fsSceneStrip) {
        this.fsSceneStrip.querySelectorAll('.fs-scene-card').forEach(c => {
          c.classList.toggle('active', c.dataset.scene === this.selection.scene);
        });
      }
    }

    _chooseScene(scene) {
      if (scene === this.selection.scene) return;
      this.selection.scene = scene;
      this._refreshSceneActive();
      this._populateMethodSelects();
      this._updateScenePrompt();
      if (this.loaded || this._shouldAutoload()) this._loadScene();
    }

    _shouldAutoload() { return true; }

    /** Update the scene-specific labels beneath the panel-grid:
     *  - cinema section: show the film title from CONFIG.cinemaSceneTitles
     *  - wild section:   show a coverr.co attribution for coverr-* scenes
     *  - text_to_video:  show the original WAN prompt (spaces→underscores reversed)
     */
    _updateScenePrompt() {
      // Cinema section title
      if (this.sceneTitleEl) {
        if (this.sectionId === 'cinema' && this.selection.scene) {
          const title = (CONFIG.cinemaSceneTitles || {})[this.selection.scene];
          this.sceneTitleEl.textContent = title || '';
          this.sceneTitleEl.hidden = !title;
        } else {
          this.sceneTitleEl.hidden = true;
        }
      }

      // Coverr attribution
      if (this.coverrAttrEl) {
        this.coverrAttrEl.hidden = !(
          this.selection.scene && this.selection.scene.startsWith('coverr')
        );
      }

      // text_to_video scene prompt
      if (!this.scenePromptEl) return;
      if (this.sectionId !== 'text_to_video' || !this.selection.scene) {
        this.scenePromptEl.hidden = true;
        this.scenePromptEl.textContent = '';
        return;
      }
      const prompt = promptFromSceneName(this.selection.scene);
      this.scenePromptEl.textContent = prompt;
      this.scenePromptEl.hidden = !prompt;
    }

    /* ── Method selects ───────────────────────────────────────────── */

    /** Get the methods available for the currently selected (dataset, exposure, scene),
     *  filtered by section policy (e.g. hide GT outside the datasets section)
     *  and ordered by CONFIG.methodOrder. */
    _methodsForScene(scene) {
      const structure = this.manifest.structure || {};
      let methods = ((structure[this.selection.dataset] || {})[this.selection.exposure] || {})[scene] || [];
      if (!this.showGT) methods = methods.filter(m => m !== 'GT');
      return this._orderMethods(methods);
    }

    _orderMethods(methods) {
      const idx = new Map(CONFIG.methodOrder.map((m, i) => [m, i]));
      const score = m => idx.has(m) ? idx.get(m) : (CONFIG.methodOrder.length + m.toLowerCase().charCodeAt(0));
      return [...methods].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
    }

    _initialMethodForPanel(idx, available) {
      if (!available.length) return '';
      const preferred = CONFIG.initialPanelMethods[idx];
      if (preferred && available.includes(preferred)) return preferred;
      const otherPref = CONFIG.initialPanelMethods[1 - idx];
      const other = this.panelMethods[1 - idx];
      const candidates = available.filter(m => m !== other && m !== otherPref);
      if (candidates.length) return candidates[0];
      return available[Math.min(idx, available.length - 1)];
    }

    _populateMethodSelects() {
      const methods = this._methodsForScene(this.selection.scene);
      for (let i = 0; i < 2; i++) {
        const { methodSel } = this.panelCtrls[i];
        if (!methodSel) continue;  // Safety: element not found
        const currentlySelected = methodSel.value;
        let pick;
        if (this.panelMethods[i] && methods.includes(this.panelMethods[i])) {
          pick = this.panelMethods[i];
        } else if (currentlySelected && methods.includes(currentlySelected)) {
          pick = currentlySelected;
        } else {
          pick = this._initialMethodForPanel(i, methods);
        }
        // Build the <option> list with display-name overrides — the
        // option's `value` stays canonical so file paths and lock checks
        // work unchanged; only `textContent` reads as the friendly name.
        methodSel.replaceChildren();
        for (const m of methods) {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = methodDisplayName(m);
          methodSel.appendChild(opt);
        }
        methodSel.value = pick || '';
        this.panelMethods[i] = methodSel.value;
        methodSel.onchange = () => {
          this.panelMethods[i] = methodSel.value;
          this._applyMethodLockState(i);
          this.panels[i].setLabel(methodDisplayName(methodSel.value));
          this._updateHoverZoomLabels();
          this._loadOnePanel(i);
        };
        this._applyMethodLockState(i);
      }
      this._updateHoverZoomLabels();
    }

    /** When a panel's method is 'Input', force its tone-mapper to the
     *  'input' passthrough, lock the panel to SDR canvas mode, and disable
     *  the dropdown; otherwise restore the user's preferred mapper and
     *  release the SDR lock. */
    _applyMethodLockState(idx) {
      const method = this.panelMethods[idx];
      const { toneSel } = this.panelCtrls[idx];
      const panel = this.panels[idx];

      // The Input mp4 is libx264/yuv420p/bt709 SDR — never feed it through
      // the 'extended' canvas tone-mapping mode. Other methods follow the
      // section's current tone mode unchanged.
      if (panel) {
        const wantMode = isMethodLocked(method) ? 'standard' : this.currentToneMode;
        panel.setToneMode(wantMode);
      }

      if (isMethodLocked(method)) {
        toneSel.disabled = true;
        toneSel.classList.add('disabled');
        const lockedMapper = getToneMapperForMethod(method);
        if (lockedMapper) {
          let placeholder = toneSel.querySelector('option[data-locked="1"]');
          if (!placeholder) {
            placeholder = document.createElement('option');
            placeholder.dataset.locked = '1';
            placeholder.value = lockedMapper.name;
            placeholder.textContent = lockedMapper.label || lockedMapper.name;
            toneSel.appendChild(placeholder);
          }
          toneSel.value = lockedMapper.name;
          this.panelToneMappers[idx] = lockedMapper.name;
          if (panel) panel.swapToneMapper(lockedMapper);
          this._applyPanelUniforms(idx);
        }
      } else {
        const placeholder = toneSel.querySelector('option[data-locked="1"]');
        if (placeholder) placeholder.remove();
        toneSel.disabled = false;
        toneSel.classList.remove('disabled');
        const wanted = this.panelUserMappers[idx] || DEFAULT_TONE_MAPPER_NAME;
        toneSel.value = wanted;
        this.panelToneMappers[idx] = wanted;
        const mapper = getToneMapper(wanted);
        if (mapper && panel) panel.swapToneMapper(mapper);
        this._applyPanelUniforms(idx);
      }
    }

    _updateHoverZoomLabels() {
      if (!this.hoverZoom || typeof this.hoverZoom.setLabels !== 'function') return;
      this.hoverZoom.setLabels([
        methodDisplayName(this.panelMethods[0]),
        methodDisplayName(this.panelMethods[1]),
      ]);
    }

    /* ── Panel construction ───────────────────────────────────────── */
    _buildPanels() {
      // Panels are created with the section's CURRENT tone mode, not the
      // global radio's. _applyMethodLockState (called shortly after via
      // _populateMethodSelects) overrides this to 'standard' for any
      // panel whose method is the locked Input pseudo-method.
      for (let i = 0; i < 2; i++) {
        const panel = new Panel({
          device: this.device,
          container: this.panelGrid,
          method: '—',
          toneMode: this.currentToneMode,
        });
        this.panels.push(panel);
      }
      // The split divider must remain the last child of panel-grid in DOM
      // so it stacks above the panels (no z-index gymnastics required).
      if (this.splitDivider) this.panelGrid.appendChild(this.splitDivider);
    }

    /* ── Playback bar wiring ──────────────────────────────────────── */
    _wirePlaybackBar() {
      const scrub  = this.playbackBar.querySelector('[data-role="scrub"]');
      const playBtn = this.playbackBar.querySelector('[data-role="play"]');
      const fpsHost = this.playbackBar.querySelector('[data-role="fpsHost"]');

      scrub.max = String(Math.max(0, CONFIG.frameCount - 1));
      playBtn.addEventListener('click', () => { this._activate(); this.sync.toggle(); });
      scrub.addEventListener('input', () => {
        this._activate();
        this.sync.pause();
        this.sync.setFrame(parseInt(scrub.value, 10));
      });
      this._fpsControl = UI.buildFpsSlider(fpsHost, this.sectionFps, (v) => {
        this.sync.setFps(v);
      });

      // Exposure slider in the playback bar — always visible, essential
      // in fullscreen where the per-panel control blocks are off-screen.
      const expHost = document.createElement('div');
      expHost.className = 'pb-exposure-host';
      const expLbl = document.createElement('span');
      expLbl.className = 'fps-label';
      expLbl.textContent = 'EV';
      const expSlider = document.createElement('input');
      expSlider.type = 'range';
      expSlider.className = 'fps-slider pb-exposure-slider';
      expSlider.min = '-8'; expSlider.max = '8'; expSlider.step = '0.1'; expSlider.value = '0';
      expSlider.setAttribute('aria-label', 'exposure (EV)');
      const expVal = document.createElement('span');
      expVal.className = 'fps-value';
      expVal.textContent = '0.0';
      expHost.appendChild(expLbl);
      expHost.appendChild(expSlider);
      expHost.appendChild(expVal);
      expSlider.addEventListener('input', () => {
        const ev = parseFloat(expSlider.value);
        expVal.textContent = ev.toFixed(1);
        this._setPanelExposure(0, evToMul(ev), { mirror: true });
      });
      this._pbExpSlider = expSlider;
      this._pbExpValue  = expVal;
      const dmToggle = this.playbackBar.querySelector('.display-mode-toggle');
      if (dmToggle) this.playbackBar.insertBefore(expHost, dmToggle);
      else this.playbackBar.appendChild(expHost);
    }

    /* ── Display-mode (Side / Slider) + Fullscreen ────────────────── */
    _wireDisplayModeToggle() {
      const buttons = this.playbackBar.querySelectorAll('.dm-btn');
      buttons.forEach(btn => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.mode;
          if (!mode || mode === this.displayMode) return;
          this._setDisplayMode(mode);
          requestAnimationFrame(() => {
            for (const p of this.panels) p._syncCanvasSize && p._syncCanvasSize();
            this._applySplitPosition();
          });
        });
      });
    }

    _wireFullscreen() {
      const btn = this.playbackBar.querySelector('[data-role="fullscreen"]');
      if (!btn) return;
      const stage = this.compStage;
      let pseudoFS = false;

      const _syncCanvases = () => {
        requestAnimationFrame(() => {
          for (const p of this.panels) p._syncCanvasSize && p._syncCanvasSize();
          this._applySplitPosition();
        });
      };

      const _onEnter = () => {
        stage.dataset.fullscreen = '1';
        btn.classList.add('active');
        this.splitPosition = 50;
        const portraitPhone = window.matchMedia(
          '(max-width: 720px) and (orientation: portrait)').matches;
        this._setDisplayMode(portraitPhone ? 'side' : 'split');
        _syncCanvases();
      };

      const _onExit = () => {
        stage.dataset.fullscreen = '0';
        btn.classList.remove('active');
        _syncCanvases();
      };

      // CSS pseudo-fullscreen: position: fixed overlay used when the native
      // Fullscreen API is unavailable (iOS Safari in regular browser tabs).
      const enterPseudoFS = () => {
        pseudoFS = true;
        stage.classList.add('pseudo-fullscreen');
        document.body.style.overflow = 'hidden';
        _onEnter();
      };

      const exitPseudoFS = () => {
        pseudoFS = false;
        stage.classList.remove('pseudo-fullscreen');
        document.body.style.overflow = '';
        _onExit();
      };

      btn.addEventListener('click', () => {
        if (pseudoFS) { exitPseudoFS(); return; }
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
          return;
        }
        // Try native fullscreen; fall back to pseudo-FS on rejection (iOS Safari).
        const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
        if (req) {
          let p;
          try { p = req.call(stage); } catch (_e) { p = null; }
          if (p && typeof p.catch === 'function') {
            p.catch(() => enterPseudoFS());
          }
          // If req exists but returns nothing (old webkit), assume it worked;
          // the fullscreenchange event will confirm.
        } else {
          enterPseudoFS();
        }
      });

      // Escape dismisses pseudo-FS (native FS handles Escape natively).
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && pseudoFS) exitPseudoFS();
      });

      const onChange = () => {
        const fs = (document.fullscreenElement === stage) ||
                   (document.webkitFullscreenElement === stage);
        if (fs) { _onEnter(); } else { _onExit(); }
      };
      document.addEventListener('fullscreenchange', onChange);
      document.addEventListener('webkitfullscreenchange', onChange);
    }

    /** Switch between 'side' and 'split' display modes, updating the
     *  panel-grid data attribute and the dm-btn active states. */
    _setDisplayMode(mode) {
      if (mode === this.displayMode) return;
      this.displayMode = mode;
      this.panelGrid.dataset.display = mode;
      const buttons = this.playbackBar.querySelectorAll('.dm-btn');
      buttons.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
      // Notify the hover-zoom inspector so it switches between its
      // per-panel lenses (side mode) and the grid-level lens (split mode).
      if (this.hoverZoom && typeof this.hoverZoom.setDisplayMode === 'function') {
        this.hoverZoom.setDisplayMode(mode);
      }
    }

    /* ── Split-divider drag handling ──────────────────────────────── */
    _wireSplitDivider() {
      const divider = this.splitDivider;
      let dragging = false;
      const onPointer = (e) => {
        if (!dragging) return;
        const r = this.panelGrid.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        this.splitPosition = Math.max(0, Math.min(100, x * 100));
        this._applySplitPosition();
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        window.removeEventListener('pointermove', onPointer);
        window.removeEventListener('pointerup',   onUp);
      };
      divider.addEventListener('pointerdown', (e) => {
        // Only respond in split mode.
        if (this.panelGrid.dataset.display !== 'split') return;
        dragging = true;
        e.preventDefault();
        window.addEventListener('pointermove', onPointer);
        window.addEventListener('pointerup',   onUp);
      });
    }

    /** Push the divider's X position into the CSS variable that drives
     *  the right panel's clip-path. */
    _applySplitPosition() {
      if (!this.panelGrid) return;
      this.panelGrid.style.setProperty('--split-pos', `${this.splitPosition}%`);
    }

    /* ── Fullscreen scene strip ──────────────────────────────────────
     * A vertical list of thumbnails on the left edge of the comp-stage,
     * shown only when the stage is fullscreen. Sharing the same DOM as
     * the regular thumb-rail would not survive fullscreen (the strip
     * needs to live inside .comp-stage to remain visible), so we build
     * a parallel rail and keep its active class in sync.
     * ────────────────────────────────────────────────────────────── */
    _rebuildFullscreenSceneStrip(scenes) {
      if (!this.fsSceneStrip) return;
      this.fsSceneStrip.replaceChildren();
      const sceneList = scenes || [];
      for (const scene of sceneList) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'fs-scene-card';
        card.dataset.scene = scene;
        card.title = scene;

        const img = document.createElement('img');
        img.className = 'fs-scene-img';
        img.alt = scene;
        card.appendChild(img);

        // Reuse precomputed thumbnails for the fullscreen strip too —
        // these are tiny and cheap. JS-decoded thumbnails the main rail
        // produced will repaint themselves there; we don't bother
        // requesting separately here to avoid double-loading.
        const precomputed = thumbnailSource(
          this.selection.dataset, this.selection.exposure, scene);
        if (precomputed && precomputed.url) img.src = precomputed.url;

        card.addEventListener('click', () => this._chooseScene(scene));
        this.fsSceneStrip.appendChild(card);
      }
      this._refreshSceneActive();
    }

    _activate() {
      if (this.opts.onActivate) this.opts.onActivate(this);
      if (!this.loaded) this._loadScene();
      // Apply this section's preferred fps when the user first interacts.
      // The slider already shows the section's value; this just makes
      // the section's timeline match.
      if (this._fpsControl) {
        this.sync.setFps(this.sectionFps);
        this._fpsControl.setValue(this.sectionFps);
      }
    }

    /* ── Scene/panel loading ─────────────────────────────────────── */

    /** Apply pivot/contrast/saturation (global) + this panel's exposure
     *  to the panel's uniform buffer and redraw. */
    _applyPanelUniforms(idx) {
      const panel = this.panels[idx];
      if (!panel) return;
      const g = this.getGlobalUniforms();
      panel.setUniforms({
        pivot:      g.pivot,
        contrast:   g.contrast,
        saturation: g.saturation,
        exposure:   this.panelExposures[idx],
      });
      panel.redraw();
    }

    /** Show the status only on non-ready states. The 'ready' resting state
     *  was occupying space next to the display-mode toggle without giving
     *  any information once a scene has loaded; the CSS hides any element
     *  with data-state="ready", and we still keep the element in the DOM
     *  so loading/error transitions can swap state on it. */
    _setStatus(state, text) {
      const status = this.playbackBar.querySelector('[data-role="status"]');
      if (!status) return;
      UI.setLoadStatus(status, state, state === 'ready' ? '' : text);
    }

    async _loadScene() {
      const { dataset, exposure, scene } = this.selection;
      if (!dataset || !exposure || !scene) return;
      const token = ++this.loadToken;
      // Preserve playback state across the scene change: a paused viewer
      // stays paused, a playing one keeps playing once the new clip is
      // loaded. Earlier versions called sync.pause() unconditionally,
      // which felt jarring when scrubbing through several scenes.
      const wasPlaying = this.sync.isPlaying;
      this.sync.pause();
      this._setStatus('loading', 'loading…');
      const total = this.panels.length * CONFIG.frameCount;
      let loaded = 0;
      const work = this.panels.map((panel, i) => {
        const method = this.panelMethods[i];
        if (!method) return Promise.resolve(null);
        const src = videoSource(dataset, exposure, scene, method);
        panel.setLabel(methodDisplayName(method));
        return panel.loadSequence(src, CONFIG.fps, CONFIG.frameCount, () => {
          loaded++;
          this._setStatus('loading', `loading… ${Math.round(100 * loaded / total)}%`);
        }).catch(err => err);
      });
      const results = await Promise.all(work);
      if (token !== this.loadToken) return;
      const errs = results.filter(r => r instanceof Error);
      if (errs.length === this.panels.length) {
        this._setStatus('error', `failed — videos/${dataset}/${exposure}/${scene}/`);
        return;
      }
      this._setStatus('ready',
        errs.length ? `${this.panels.length - errs.length}/${this.panels.length} loaded` : 'ready');
      this.loaded = true;
      this.sync.setFrame(0);
      for (let i = 0; i < this.panels.length; i++) this._applyPanelUniforms(i);
      for (const p of this.panels) p.drawFrame(0);

      // Re-fit canvas sizes after the grid has fully laid out. The size
      // computed inside loadSequence runs while the grid is still settling
      // (each panel grows the row as its inline canvas height is set),
      // which produced a too-cramped initial sizing. Double-RAF defers
      // long enough for the row height to stabilise, giving the same
      // result the slider→side toggle path produces.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const p of this.panels) p._syncCanvasSize && p._syncCanvasSize();
      }));

      const readout = this.playbackBar.querySelector('[data-role="frameReadout"]');
      const scrub   = this.playbackBar.querySelector('[data-role="scrub"]');
      scrub.max = String(Math.max(0, CONFIG.frameCount - 1));
      scrub.value = '0';
      UI.setFrameReadout(readout, 0, CONFIG.frameCount);

      // Resume playback if the user was watching before the scene change.
      if (wasPlaying) this.sync.play();
    }

    async _loadOnePanel(idx) {
      const { dataset, exposure, scene } = this.selection;
      const method = this.panelMethods[idx];
      if (!dataset || !exposure || !scene || !method) return;
      const token = ++this.loadToken;
      // Preserve play state across method swap, for the same reason as
      // _loadScene above. A paused user shouldn't suddenly start playing,
      // and a playing user shouldn't stop when they swap a method.
      const wasPlaying = this.sync.isPlaying;
      this.sync.pause();
      this._setStatus('loading', `loading panel ${idx + 1}…`);
      const src = videoSource(dataset, exposure, scene, method);
      try {
        await this.panels[idx].loadSequence(src, CONFIG.fps, CONFIG.frameCount, null);
        if (token !== this.loadToken) return;
        this._applyPanelUniforms(idx);
        this.sync.setFrame(0);
        this.panels[idx].drawFrame(0);
        this._setStatus('ready', 'ready');
        if (wasPlaying) this.sync.play();
      } catch (err) {
        this._setStatus('error', `panel ${idx + 1} failed`);
      }
    }

    /* ── External interface (called by main.js global wiring) ─────── */

    /**
     * Apply the section-level SDR/HDR canvas mode. Always re-applies the
     * per-panel lock state so that Input panels stay in 'standard' even
     * when the global radio wants 'extended', and HDR panels follow the
     * global toggle in either direction.
     *
     * Defensive: this calls panel.setToneMode unconditionally, even when
     * the mode hasn't changed at the section level, so the canvas
     * configuration is guaranteed to match what the panel's method
     * implies. This is what fixes the "HDR sticks even after SDR is
     * picked" failure mode that earlier versions had when toneMode and
     * actual canvas state drifted apart.
     */
    setToneMode(mode) {
      this.currentToneMode = mode;
      for (let i = 0; i < this.panels.length; i++) {
        // Per-panel override: panels hosting an Input pseudo-method (SDR
        // libx264 mp4) stay in 'standard' canvas mode regardless of what
        // the global SDR/HDR radio says.
        const want = isMethodLocked(this.panelMethods[i]) ? 'standard' : mode;
        this.panels[i].setToneMode(want);
      }
    }

    /** Called by main.js when a global slider (pivot/contrast/saturation)
     *  changes. Re-applies all per-panel uniforms. */
    onGlobalUniformsChanged() {
      for (let i = 0; i < this.panels.length; i++) this._applyPanelUniforms(i);
    }

    refreshPipeline() {
      for (const p of this.panels) p.refreshPipeline();
    }

    drawFrame(idx) {
      for (const p of this.panels) p.drawFrame(idx);
      const readout = this.playbackBar.querySelector('[data-role="frameReadout"]');
      const scrub   = this.playbackBar.querySelector('[data-role="scrub"]');
      readout.textContent = `${idx} / ${CONFIG.frameCount - 1}`;
      scrub.value = String(idx);
      if (this.hoverZoom && typeof this.hoverZoom.refresh === 'function') this.hoverZoom.refresh();
    }

    setPlayIcon(playing) {
      const icon = this.playbackBar.querySelector('[data-role="playIcon"]');
      if (icon) icon.textContent = playing ? '❚❚' : '▶';
    }
  }

  return { ComparisonSection };
})();
