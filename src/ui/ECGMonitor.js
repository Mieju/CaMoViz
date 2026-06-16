/** The twelve standard ECG leads, in display order. */
export const LEAD_NAMES = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];

/**
 * Floating pseudo-ECG monitor: a draggable window with a scrolling trace and a
 * selectable lead. The app computes the cardiac dipole, the torso-electrode
 * potentials and the chosen lead (see main.js), then calls `push(t, value)`.
 * A single sweeping beat reads as one deflection; a reentrant circuit as a fast
 * regular rhythm. Different leads "see" the dipole from different angles, so the
 * morphology changes per lead — as on a real 12-lead ECG.
 */
export class ECGMonitor {
  /** @param {{ windowSeconds?: number }} [opts] seconds of trace shown */
  constructor({ windowSeconds = 5 } = {}) {
    this.windowSeconds = windowSeconds;
    this.samples = [];        // { t, v } within the visible window
    this.peak = 1e-6;         // adaptive amplitude for auto-gain
    this.lead = 'II';         // selected lead (II = classic rhythm strip)

    this.el = document.createElement('div');
    this.el.className = 'ecg-window';
    this.el.hidden = true;
    this.el.innerHTML = TEMPLATE;
    document.body.appendChild(this.el);

    this.canvas = this.el.querySelector('.ecg-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cw = 240; this.ch = 88;
    this._lastT = 0;
    // The window is resizable (CSS resize); keep the trace canvas filling it.
    this._ro = new ResizeObserver(() => this._fit());
    this._ro.observe(this.canvas);
    // Re-clamp into view if the viewport shrinks under a dragged window.
    window.addEventListener('resize', () => this._clampToViewport());

    // Lead-selector buttons.
    const leadRow = this.el.querySelector('.ecg-leads');
    for (const name of LEAD_NAMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ecg-lead' + (name === this.lead ? ' active' : '');
      b.textContent = name;
      b.addEventListener('click', () => this._selectLead(name));
      leadRow.appendChild(b);
    }

    this._minBtn = this.el.querySelector('.ecg-min');
    this._minBtn.addEventListener('click', () => {
      const min = this.el.classList.toggle('min');
      this._minBtn.textContent = min ? '+' : '–';
    });
    this._makeDraggable(this.el.querySelector('.ecg-head'));
    this._fit();
  }

  /** Resize the backing canvas to match its (resizable) CSS box and redraw. */
  _fit() {
    const w = this.canvas.clientWidth || this.cw;
    const h = this.canvas.clientHeight || this.ch;
    if (!w || !h) return;
    this.cw = w; this.ch = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._draw(this._lastT);
  }

  /** Keep a dragged window fully inside the viewport. */
  _clampToViewport() {
    if (!this.el.style.left && !this.el.style.top) return;   // still CSS-anchored
    const r = this.el.getBoundingClientRect();
    const x = Math.max(0, Math.min(window.innerWidth - r.width, r.left));
    const y = Math.max(0, Math.min(window.innerHeight - r.height, r.top));
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  _selectLead(name) {
    this.lead = name;
    this.el.querySelectorAll('.ecg-lead').forEach((b) => b.classList.toggle('active', b.textContent === name));
    this.el.querySelector('.ecg-lead-label').textContent = name;
    // Clear the trace but KEEP the gain, so a small lead (e.g. I for an axial
    // wave) reads as a small deflection instead of being re-normalized to full.
    this.samples.length = 0;
    this._draw(0);
  }

  show(visible) { this.el.hidden = !visible; }

  reset() { this.samples.length = 0; this.peak = 1e-6; this._draw(0); }

  /** Append a lead-signal sample at sim time `t` (seconds) and redraw. */
  push(t, v) {
    this._lastT = t;
    this.samples.push({ t, v });
    const t0 = t - this.windowSeconds;
    while (this.samples.length && this.samples[0].t < t0) this.samples.shift();
    const a = Math.abs(v);
    if (a > this.peak) this.peak = a;
    this.peak = Math.max(this.peak * 0.9997, 1e-6);  // adapt slowly; shared across leads
    if (!this.el.classList.contains('min')) this._draw(t);
  }

  _draw(tNow) {
    const ctx = this.ctx, W = this.cw, H = this.ch, mid = H * 0.5;
    ctx.clearRect(0, 0, W, H);

    // Faint ECG-paper grid.
    ctx.strokeStyle = 'rgba(255,120,120,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 24) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y <= H; y += 22) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    // Baseline.
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();

    if (this.samples.length < 2) return;
    const t0 = tNow - this.windowSeconds;
    const gain = (mid * 0.82) / this.peak;
    ctx.strokeStyle = '#ff9d4d';
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (const s of this.samples) {
      const x = ((s.t - t0) / this.windowSeconds) * W;
      const y = mid - s.v * gain;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  _makeDraggable(handle) {
    let dx = 0, dy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ecg-min')) return;
      dragging = true;
      const r = this.el.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      this.el.style.right = 'auto'; this.el.style.bottom = 'auto';
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = this.el.getBoundingClientRect();
      const x = Math.max(0, Math.min(window.innerWidth - r.width, e.clientX - dx));
      const y = Math.max(0, Math.min(window.innerHeight - r.height, e.clientY - dy));
      this.el.style.left = `${x}px`; this.el.style.top = `${y}px`;
    });
    handle.addEventListener('pointerup', () => { dragging = false; });
  }
}

const TEMPLATE = `
  <div class="ecg-head">
    <span class="ecg-title">Pseudo-ECG · <span class="ecg-lead-label">II</span></span>
    <button class="ecg-min" type="button" aria-label="Minimize">–</button>
  </div>
  <div class="ecg-body">
    <div class="ecg-leads"></div>
    <canvas class="ecg-canvas" width="240" height="88"></canvas>
  </div>
`;
