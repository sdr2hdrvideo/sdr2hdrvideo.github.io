/* ──────────────────────────────────────────────────────────────────────────
 * hoverZoom.js — collapsible side-by-side magnified-region viewer.
 *
 * Attaches to a pair of Panels. When opened, hovering on either panel:
 *   - shows a lens overlay (rectangle) on the source panel(s),
 *   - draws the zoomed crop from BOTH panels into two zoom canvases.
 *
 * The zoom canvases are 2D (sRGB) — `drawImage` from each Panel's WebGPU
 * canvas. This loses HDR fidelity in the zoom; the main panels remain
 * HDR-accurate. The zoom is a preview / pixel-peep aid.
 *
 * The drawer starts OPEN by default; users can collapse it via the header.
 *
 * DISPLAY MODES
 * ─────────────
 * In "side" mode each panel has its own lens overlay that tracks the cursor
 * within that panel. In "split" mode a single grid-level lens (a child of
 * the panelGrid element) is used instead so the crop-selection box is
 * always visible across BOTH panels simultaneously, regardless of which
 * side of the split divider the cursor is on. ComparisonSection calls
 * setDisplayMode() whenever the user switches between Side and Slider.
 *
 * ZOOM SCALE FIX
 * ──────────────
 * The crop is computed in source-pixel space but must correspond to the
 * apparent magnification the user expects. Formula:
 *   crop_source_px = inspector_CSS_px × (src_internal_px / display_CSS_px) / zoom
 * This ensures that "zoom = 3" always means 3× apparent magnification,
 * regardless of whether the panel is displayed half-width (side mode) or
 * full-width (split mode).
 *
 * REDRAW MODEL — event-driven
 * ────────────────────────────
 * Reading from a WebGPU canvas via `drawImage` is racy on Chrome: the
 * canvas's last-presented frame may be torn down between mouse events,
 * leaving the 2D context with a black or stale image.
 *
 * Fix: each `_render()` call first force-redraws both source panels (so
 * their WebGPU swapchains hold a fresh texture for the upcoming
 * drawImage), then performs the actual `drawImage`. This is event-driven,
 * not RAF-driven — we only spend cycles on mousemove, zoom-slider drag,
 * or per-frame ticks from the SyncController. There is no persistent
 * 60-Hz loop, so the inspector adds no overhead while idle.
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.hoverZoom = (function () {
  'use strict';

  class HoverZoom {
    constructor({ container, panelGrid, panels, labels }) {
      this.panels = panels;             // [Panel, Panel]
      this.labels = labels || ['Left', 'Right'];
      this.zoom = 3;
      this.isOpen = true;               // open by default
      this.showLens = true;             // bounding-box overlay enabled by default
      this.displayMode = 'split';       // matches ComparisonSection default
      // Start with a centered focus on the left panel so the inspector is
      // never empty before the user hovers.
      this.lastFocus = { panelIdx: 0, relX: 0.5, relY: 0.5 };

      // Grid-level lens for split mode — sits above both panels (z-index 5)
      // so the selection box spans the full panel-grid width, visible on
      // whichever side of the split divider the cursor is near.
      this.panelGrid = panelGrid || null;
      this.gridLens  = null;
      if (panelGrid) {
        this.gridLens = document.createElement('div');
        this.gridLens.className = 'zoom-lens';
        this.gridLens.style.zIndex = '5';   // above panel z-index 1 and 2
        this.gridLens.style.display = 'none';
        panelGrid.appendChild(this.gridLens);
      }

      this.root = document.createElement('div');
      this.root.className = 'zoom-drawer open';   // start open

      const head = document.createElement('div');
      head.className = 'zoom-drawer-head';
      // Make the whole head row act as a button for screen-readers and
      // keyboard users; we also wire 'click' for mouse below.
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.setAttribute('aria-label', 'toggle hover-zoom inspector');

      const title = document.createElement('div');
      title.className = 'zoom-drawer-title';
      title.textContent = 'Hover-zoom inspector';

      const ctrls = document.createElement('div');
      ctrls.className = 'zoom-drawer-controls';
      const zLbl = document.createElement('span');
      zLbl.className = 'control-label zoom-drawer-zoom-label';
      zLbl.textContent = 'zoom';
      const zRange = document.createElement('input');
      zRange.type = 'range'; zRange.min = '2'; zRange.max = '8'; zRange.step = '0.5'; zRange.value = String(this.zoom);
      zRange.className = 'zoom-drawer-zoom-range';
      const zVal = document.createElement('span');
      zVal.className = 'slider-value zoom-drawer-zoom-value';
      zVal.textContent = `${this.zoom}×`;
      zRange.addEventListener('click', e => e.stopPropagation());
      zRange.addEventListener('input', () => {
        this.zoom = parseFloat(zRange.value);
        zVal.textContent = `${this.zoom}×`;
        this._render();
      });
      ctrls.appendChild(zLbl);
      ctrls.appendChild(zRange);
      ctrls.appendChild(zVal);

      // "Show box" checkbox — lets the user disable the lens overlay when it
      // gets distracting. Inspector keeps updating regardless. Default: on.
      const boxLbl = document.createElement('label');
      boxLbl.className = 'zoom-drawer-checkbox';
      const boxCb = document.createElement('input');
      boxCb.type = 'checkbox';
      boxCb.checked = true;
      const boxTxt = document.createElement('span');
      boxTxt.textContent = 'show box';
      boxLbl.appendChild(boxCb);
      boxLbl.appendChild(boxTxt);
      boxLbl.addEventListener('click', e => e.stopPropagation());
      boxCb.addEventListener('change', () => {
        this.showLens = boxCb.checked;
        if (!this.showLens) {
          if (this.gridLens) this.gridLens.style.display = 'none';
          this.panels.forEach(p => { if (p._zoomLens) p._zoomLens.style.display = 'none'; });
        }
      });
      ctrls.appendChild(boxLbl);

      // Explicit Show/Hide pill — the bare chevron wasn't reading as
      // interactive to reviewers, so we put a labelled button at the
      // right edge of the header. CSS swaps its text between
      // "Hide" / "Show" based on the .open class on the drawer root.
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'zoom-drawer-toggle';
      toggleBtn.dataset.role = 'toggle';
      toggleBtn.setAttribute('aria-label', 'toggle hover-zoom inspector');
      toggleBtn.textContent = 'Hide';
      toggleBtn.addEventListener('click', (e) => {
        // Prevent the head's click handler from running too (would
        // double-toggle back to the previous state).
        e.stopPropagation();
        this.toggle();
      });
      this._toggleBtn = toggleBtn;

      head.appendChild(title);
      head.appendChild(ctrls);
      head.appendChild(toggleBtn);
      head.addEventListener('click', () => this.toggle());
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.toggle();
        }
      });

      this.body = document.createElement('div');
      this.body.className = 'zoom-drawer-body';

      this.zoomCanvases = [];
      this.zoomLabels = [];
      for (let i = 0; i < 2; i++) {
        const cell = document.createElement('div');
        cell.className = 'zoom-panel';
        const lbl = document.createElement('div');
        lbl.className = 'zoom-panel-label';
        lbl.textContent = this.labels[i];
        const cv = document.createElement('canvas');
        cv.width = 600; cv.height = 360;
        cell.appendChild(lbl);
        cell.appendChild(cv);
        this.body.appendChild(cell);
        this.zoomCanvases.push(cv);
        this.zoomLabels.push(lbl);
      }

      this.root.appendChild(head);
      this.root.appendChild(this.body);
      container.appendChild(this.root);

      this._wirePanels();
      if (panelGrid) this._wireGrid(panelGrid);
    }

    setLabels(labels) {
      this.labels = labels;
      this.zoomLabels.forEach((el, i) => { el.textContent = labels[i] || ''; });
    }

    /** Called by ComparisonSection when the user switches between Side and Slider. */
    setDisplayMode(mode) {
      this.displayMode = mode;
      // Hide all lenses on mode change — they will reappear on next hover.
      if (this.gridLens) this.gridLens.style.display = 'none';
      this.panels.forEach(p => { if (p._zoomLens) p._zoomLens.style.display = 'none'; });
    }

    open()  {
      this.root.classList.add('open');
      this.isOpen = true;
      if (this._toggleBtn) this._toggleBtn.textContent = 'Hide';
      this._render();
    }
    close() {
      this.root.classList.remove('open');
      this.isOpen = false;
      if (this._toggleBtn) this._toggleBtn.textContent = 'Show';
    }
    toggle() { this.isOpen ? this.close() : this.open(); }

    /** Re-render zoom canvases (called by section after each frame draw,
     *  and internally after mouse / zoom-slider events). */
    refresh() { if (this.isOpen) this._render(); }

    /** Compute the visible content rect inside a container, accounting for
     *  CSS `object-fit: contain` letterboxing. The canvas's intrinsic
     *  resolution (e.g. 1280×704) is preserved when scaled into the
     *  container; if the container's aspect ratio differs, the content is
     *  centered with black bars on either side (or top/bottom). The cursor
     *  position must be mapped against the VISIBLE content rect, not the
     *  container's full bounding rect, or the zoom inspector ends up
     *  cropping the wrong source pixels.
     *
     *  Returns { displayW, displayH, offsetX, offsetY } in CSS pixels
     *  relative to the container's top-left. */
    _visibleContentRect(canvas, containerR) {
      const iw = canvas.width, ih = canvas.height;
      if (!iw || !ih || !containerR.width || !containerR.height) {
        return { displayW: containerR.width, displayH: containerR.height, offsetX: 0, offsetY: 0 };
      }
      const contentAspect   = iw / ih;
      const containerAspect = containerR.width / containerR.height;
      if (containerAspect > contentAspect) {
        // Container is wider than content → letterbox on left/right.
        const displayH = containerR.height;
        const displayW = displayH * contentAspect;
        return { displayW, displayH, offsetX: (containerR.width - displayW) / 2, offsetY: 0 };
      }
      // Container is taller than content (or equal) → letterbox top/bottom.
      const displayW = containerR.width;
      const displayH = displayW / contentAspect;
      return { displayW, displayH, offsetX: 0, offsetY: (containerR.height - displayH) / 2 };
    }

    _wirePanels() {
      this.panels.forEach((panel, idx) => {
        // Individual lens overlay — only active in side mode.
        const lens = document.createElement('div');
        lens.className = 'zoom-lens';
        panel.root.appendChild(lens);
        panel._zoomLens = lens;

        panel.root.addEventListener('mousemove', (e) => {
          if (!this.isOpen) return;
          // In split mode, the grid-level lens handles everything.
          if (this.displayMode === 'split') {
            lens.style.display = 'none';
            return;
          }
          const cv = panel.canvas;
          const r = cv.getBoundingClientRect();
          const xInCv = e.clientX - r.left;
          const yInCv = e.clientY - r.top;
          if (xInCv < 0 || yInCv < 0 || xInCv > r.width || yInCv > r.height) {
            lens.style.display = 'none';
            return;
          }
          // Account for object-fit: contain letterboxing inside the canvas.
          const { displayW, displayH, offsetX, offsetY } = this._visibleContentRect(cv, r);
          const xInContent = xInCv - offsetX;
          const yInContent = yInCv - offsetY;
          if (xInContent < 0 || yInContent < 0 || xInContent > displayW || yInContent > displayH) {
            lens.style.display = 'none';
            return;
          }

          this.lastFocus = {
            panelIdx: idx,
            relX: xInContent / displayW,
            relY: yInContent / displayH,
          };
          this._render();

          if (!this.showLens) { lens.style.display = 'none'; return; }

          // Lens follows cursor within panel.root coords.
          const rootR = panel.root.getBoundingClientRect();
          // Size the lens to represent the same region that the zoom
          // inspector is showing. We anchor to the inspector canvas
          // width (not the display canvas width) so the apparent zoom
          // factor is consistent regardless of panel size.
          const dst = this.zoomCanvases[0];
          const dstR = dst.getBoundingClientRect();
          const dstAspect = (dstR.width > 0 && dstR.height > 0)
            ? (dstR.width / dstR.height) : (r.width / r.height);
          const lensW = dstR.width / this.zoom;
          const lensH = lensW / dstAspect;
          lens.style.display = 'block';
          lens.style.left = `${e.clientX - rootR.left}px`;
          lens.style.top  = `${e.clientY - rootR.top}px`;
          lens.style.width  = `${lensW}px`;
          lens.style.height = `${lensH}px`;
        });

        panel.root.addEventListener('mouseleave', () => {
          lens.style.display = 'none';
        });
      });
    }

    /** Wire a grid-level lens for split mode. The single lens sits above
     *  both panels (z-index 5) so the selection box spans across the
     *  split divider and is visible on both halves simultaneously.
     *
     *  We listen on `pointermove` (not `mousemove`) because the split
     *  divider calls `e.preventDefault()` on `pointerdown`, which suppresses
     *  the browser's compat `mousemove` events during the drag. `pointermove`
     *  fires regardless and still bubbles from the divider up to panelGrid,
     *  so the lens continues tracking the cursor while the divider is dragged. */
    _wireGrid(panelGrid) {
      const onMove = (e) => {
        if (!this.isOpen || this.displayMode !== 'split' || !this.gridLens) return;
        const gridR = panelGrid.getBoundingClientRect();
        const xInGrid = e.clientX - gridR.left;
        const yInGrid = e.clientY - gridR.top;
        if (xInGrid < 0 || yInGrid < 0 || xInGrid > gridR.width || yInGrid > gridR.height) {
          this.gridLens.style.display = 'none';
          return;
        }
        // The canvas inside each panel is forced to width:100%/height:100% +
        // object-fit:contain, so when the panel-grid's aspect ratio differs
        // from the canvas (1280×704 ≈ 1.818) there are black bars on the
        // sides. Map the cursor against the VISIBLE content rect, not the
        // full grid, so the inspector crops the pixel the cursor actually
        // sits over.
        const refCanvas = this.panels[0] && this.panels[0].canvas;
        if (!refCanvas) return;
        const { displayW, displayH, offsetX, offsetY } = this._visibleContentRect(refCanvas, gridR);
        const xInContent = xInGrid - offsetX;
        const yInContent = yInGrid - offsetY;
        if (xInContent < 0 || yInContent < 0 || xInContent > displayW || yInContent > displayH) {
          this.gridLens.style.display = 'none';
          return;
        }

        this.lastFocus = {
          panelIdx: 0,
          relX: xInContent / displayW,
          relY: yInContent / displayH,
        };
        this._render();

        if (!this.showLens) { this.gridLens.style.display = 'none'; return; }

        const dst = this.zoomCanvases[0];
        const dstR = dst.getBoundingClientRect();
        const dstAspect = (dstR.width > 0 && dstR.height > 0)
          ? (dstR.width / dstR.height) : 1;
        const lensW = dstR.width / this.zoom;
        const lensH = lensW / dstAspect;
        this.gridLens.style.display = 'block';
        this.gridLens.style.left   = `${xInGrid}px`;
        this.gridLens.style.top    = `${yInGrid}px`;
        this.gridLens.style.width  = `${lensW}px`;
        this.gridLens.style.height = `${lensH}px`;
      };

      // pointermove fires during pointer-captured drag; mousemove is
      // suppressed by the divider's preventDefault(). Use pointermove as
      // the primary listener and skip mousemove to avoid double-firing.
      panelGrid.addEventListener('pointermove', onMove);

      const onLeave = () => {
        if (this.gridLens) this.gridLens.style.display = 'none';
      };
      panelGrid.addEventListener('mouseleave',   onLeave);
      panelGrid.addEventListener('pointerleave', onLeave);
    }

    _render() {
      if (!this.lastFocus) return;
      // Force-redraw both source panels so their WebGPU swapchains hold a
      // fresh texture for the upcoming drawImage. Without this we get
      // black or stale zoom canvases when the cursor moves fast or
      // playback is paused (the panel has no other reason to redraw
      // itself). Skipped for panels that don't have a scene loaded yet.
      for (const p of this.panels) {
        if (p && p.bindGroups) p.redraw();
      }
      const { relX, relY } = this.lastFocus;
      for (let i = 0; i < this.zoomCanvases.length; i++) {
        const src = this.panels[i].canvas;
        const dst = this.zoomCanvases[i];
        if (!src.width || !src.height) continue;
        // Match dst canvas pixel size to its CSS box for crispness.
        const r = dst.getBoundingClientRect();
        const w = Math.max(1, Math.floor(r.width));
        const h = Math.max(1, Math.floor(r.height));
        if (dst.width !== w) dst.width = w;
        if (dst.height !== h) dst.height = h;
        const ctx = dst.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);

        // Crop region — the aspect ratio MUST match the destination zoom
        // box so what's shown == what the lens cursor covers.
        const dstAspect = (w > 0 && h > 0) ? (w / h) : (src.width / src.height);

        // Zoom-correct crop: the crop size is computed so that the apparent
        // magnification in the inspector always equals this.zoom, regardless
        // of whether the source canvas fills a half-width panel (side mode)
        // or a full-width panel (split mode).
        //   crop_px = inspector_CSS_px × (src_internal / visible_content_CSS) / zoom
        // We use the VISIBLE content dimensions (after object-fit: contain
        // letterboxing), not the canvas's full bounding rect, so the apparent
        // zoom factor stays correct when the panel's aspect ratio differs
        // from the canvas's intrinsic aspect.
        const srcR = src.getBoundingClientRect();
        const { displayW, displayH } = this._visibleContentRect(src, srcR);
        const srcDisplayW = Math.max(1, displayW);
        const srcDisplayH = Math.max(1, displayH);
        let cw, ch;
        if (dstAspect >= 1) {
          cw = w * src.width  / (this.zoom * srcDisplayW);
          ch = cw / dstAspect;
        } else {
          ch = h * src.height / (this.zoom * srcDisplayH);
          cw = ch * dstAspect;
        }
        let cx = relX * src.width  - cw / 2;
        let cy = relY * src.height - ch / 2;
        cx = Math.max(0, Math.min(src.width  - cw, cx));
        cy = Math.max(0, Math.min(src.height - ch, cy));
        ctx.imageSmoothingEnabled = false;
        try { ctx.drawImage(src, cx, cy, cw, ch, 0, 0, w, h); } catch (_) {}
      }
    }
  }

  return { HoverZoom };
})();
