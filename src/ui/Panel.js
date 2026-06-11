/**
 * Collapsible control panel for wave parameters, colormap, scalar-field overlay,
 * loop toggle and reset. Emits the full parameter state via `onChange` on every
 * edit so the app can live-update.
 */
export class Panel {
  /**
   * @param {object} opts
   * @param {(state: PanelState) => void} opts.onChange
   * @param {() => void} opts.onReset
   */
  constructor({ onChange, onReset, onTrigger, onS1S2, onPreset, onPickS2 }) {
    this.onChange = onChange;
    this.onReset = onReset;
    this.onTrigger = onTrigger;
    this.onS1S2 = onS1S2;
    this.onPreset = onPreset;
    this.onPickS2 = onPickS2;

    this.el = document.createElement('div');
    this.el.className = 'panel';
    this.el.innerHTML = TEMPLATE;
    document.body.appendChild(this.el);

    this.$ = (id) => this.el.querySelector(`#${id}`);

    // Collapse toggle.
    this.$('panel-toggle').addEventListener('click', () => {
      this.el.classList.toggle('collapsed');
    });

    this._bindRange('p-speed', 'p-speed-val', (v) => `${v.toFixed(2)}×`);
    this._bindRange('p-refractory', 'p-refractory-val', (v) => `${v.toFixed(2)} s`);
    this._bindRange('p-width', 'p-width-val', (v) => `${v.toFixed(2)} s`);
    this._bindRange('p-s2', 'p-s2-val', (v) => `${v.toFixed(2)} s`);
    this.$('p-s2-btn').addEventListener('click', () => this.onS1S2 && this.onS1S2());
    this.$('p-set-s2').addEventListener('click', () => this.onPickS2 && this.onPickS2());
    this.$('p-colormap').addEventListener('change', () => this._emit());
    this.$('p-loop').addEventListener('change', () => this._emit());
    this.$('p-trigger').addEventListener('click', () => this.onTrigger && this.onTrigger());
    this.$('p-reset').addEventListener('click', () => this.onReset && this.onReset());
    this.$('p-preset-healthy').addEventListener('click', () => this.applyPreset('healthy'));
    this.$('p-preset-reentry').addEventListener('click', () => this.applyPreset('reentry'));
  }

  /**
   * Apply a named preset: write a coherent set of parameters into every control,
   * emit once, then notify the app (which clears the wave and shows guidance).
   * The Reentry substrate resolves the mesh's fibrosis field at apply time.
   */
  applyPreset(name) {
    const presets = {
      healthy: { waveSpeed: 1.0, refractoryPeriod: 0.5, waveWidth: 0.08, s2Coupling: 0.3,
                 colormap: 'actionPotential', loop: false },
      // Reentry: speed/refractory tuned so the gated channel circuit sustains.
      reentry: { waveSpeed: 1.0, refractoryPeriod: 0.45, waveWidth: 0.08, s2Coupling: 0.3,
                 colormap: 'actionPotential', loop: false },
    };
    const p = presets[name];
    if (!p) return;
    this.setState(p);
    if (this.onPreset) this.onPreset(name);
  }

  /** Write a partial state into the controls, refresh range labels, emit once. */
  setState(s) {
    const set = (id, v) => { if (v !== undefined) this.$(id).value = v; };
    set('p-speed', s.waveSpeed);
    set('p-refractory', s.refractoryPeriod);
    set('p-width', s.waveWidth);
    set('p-s2', s.s2Coupling);
    set('p-colormap', s.colormap);
    if (s.loop !== undefined) this.$('p-loop').checked = s.loop;
    for (const id in this._ranges) this._ranges[id]();
    this._emit();
  }

  /** Enable/disable origin-dependent controls (once a stimulus origin is set). */
  setCanTrigger(can) {
    this.$('p-trigger').disabled = !can;
    this.$('p-s2-btn').disabled = !can;
  }

  /** Reflect "pick S2 on next click" mode in the button. */
  setPickS2State(on) {
    const btn = this.$('p-set-s2');
    btn.classList.toggle('active', on);
    btn.textContent = on ? 'Click mesh… (cancel)' : 'Set S2 point';
  }

  /** Update the S2-site status label. */
  setS2Status(text) {
    this.$('p-s2-status').textContent = text;
  }

  _bindRange(id, valId, fmt) {
    const input = this.$(id);
    const out = this.$(valId);
    const update = () => { out.textContent = fmt(parseFloat(input.value)); };
    this._ranges = this._ranges || {};
    this._ranges[id] = update;            // so setState can refresh labels
    input.addEventListener('input', () => { update(); this._emit(); });
    update();
  }

  show(visible) {
    this.el.hidden = !visible;
  }

  /** @returns {PanelState} */
  state() {
    return {
      waveSpeed: parseFloat(this.$('p-speed').value),
      refractoryPeriod: parseFloat(this.$('p-refractory').value),
      waveWidth: parseFloat(this.$('p-width').value),
      s2Coupling: parseFloat(this.$('p-s2').value),
      colormap: this.$('p-colormap').value,
      loop: this.$('p-loop').checked,
    };
  }

  _emit() {
    if (this.onChange) this.onChange(this.state());
  }
}

/** @typedef {{waveSpeed:number,refractoryPeriod:number,waveWidth:number,s2Coupling:number,colormap:string,loop:boolean}} PanelState */

const TEMPLATE = `
  <div class="panel-head">
    <span class="panel-title">Controls</span>
    <button id="panel-toggle" class="panel-toggle" type="button" aria-label="Collapse">▸</button>
  </div>
  <div class="panel-body">
    <div class="presets">
      <span class="presets-label">Preset</span>
      <button id="p-preset-healthy" type="button">Healthy</button>
      <button id="p-preset-reentry" type="button">Reentry</button>
    </div>
    <button id="p-trigger" class="panel-trigger" type="button" disabled>▶ Stimulate origin (S1)</button>
    <p class="panel-tip">Click the mesh to set the stimulus origin and fire S1, or enable pacing below.</p>
    <div class="s1s2">
      <div class="s1s2-head">
        <button id="p-set-s2" class="s2-pick" type="button">Set S2 point</button>
        <span id="p-s2-status" class="s2-status">S2: same as S1</span>
      </div>
      <label class="row">
        <span class="row-label">S1→S2 coupling <em id="p-s2-val"></em></span>
        <input id="p-s2" type="range" min="0.05" max="1.5" step="0.01" value="0.3" />
      </label>
      <button id="p-s2-btn" class="panel-trigger s2" type="button" disabled>⏯ Deliver S1–S2</button>
      <details class="panel-help">
        <summary>How S1–S2 works</summary>
        <p>S1 fires at the white origin; S2 follows at the cyan point (or the same point) one coupling interval after that site activates. Coupling above the refractory period captures; below it blocks (a premature beat).</p>
      </details>
    </div>
    <label class="row">
      <span class="row-label">Conduction speed <em id="p-speed-val"></em></span>
      <input id="p-speed" type="range" min="0.1" max="3" step="0.05" value="1" />
    </label>
    <label class="row">
      <span class="row-label">Refractory <em id="p-refractory-val"></em></span>
      <input id="p-refractory" type="range" min="0.15" max="1.5" step="0.05" value="0.5" />
    </label>
    <label class="row">
      <span class="row-label">Wave width <em id="p-width-val"></em></span>
      <input id="p-width" type="range" min="0.02" max="0.3" step="0.01" value="0.08" />
    </label>
    <label class="row">
      <span class="row-label">Colormap</span>
      <select id="p-colormap">
        <option value="actionPotential">Action potential</option>
        <option value="viridis">Viridis</option>
        <option value="temperature">Temperature</option>
      </select>
    </label>
    <label class="row row-inline">
      <input id="p-loop" type="checkbox" />
      <span class="row-label">Loop</span>
    </label>
    <button id="p-reset" class="panel-reset" type="button">Reset</button>
  </div>
`;
