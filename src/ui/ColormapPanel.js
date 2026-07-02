import { regionRGB } from '../wave/Colormap.js';

/**
 * Colormap / appearance controls: the display-palette selector plus its colour
 * key — a gradient legend (with an optional scar swatch) for the wave palettes,
 * or a clickable anatomical-region legend in Regions view. Lives in its own dock
 * section, separate from the simulation parameters, because the palette is a
 * display choice independent of the wave dynamics (and of saved presets).
 *
 * Renders into a provided `mount` (a dock section body). Emits the selected value
 * via `onChange` when the user picks a palette; region swatch clicks call
 * `onIsolate(tag | null)`.
 */
export class ColormapPanel {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mount              container to render into
   * @param {(value: string) => void} opts.onChange  palette selection changed
   * @param {(tag: number|null) => void} opts.onIsolate  region isolate/clear
   */
  constructor({ mount, onChange, onIsolate }) {
    this.onChange = onChange;
    this.onIsolate = onIsolate;
    this.el = mount;
    this.el.innerHTML = TEMPLATE;
    this.$ = (id) => this.el.querySelector(`#${id}`);
    this.$('cm-select').addEventListener('change', () => this.onChange && this.onChange(this.value()));
  }

  /** @returns {string} the selected colormap value. */
  value() { return this.$('cm-select').value; }

  /** Set the selector value without emitting (the caller drives the apply). */
  setValue(value) { this.$('cm-select').value = value; }

  /**
   * Repaint the colour key as a gradient: sample the active colormap (phase 0 → 1)
   * into the bar, and show the scar swatch only when the mesh has a fibrosis field.
   */
  setColorKey(fn, hasScar) {
    this.$('cm-colorkey-grad').hidden = false;
    this.$('cm-colorkey-regions').hidden = true;
    if (fn) {
      const out = new Float32Array(3);
      const N = 12, stops = [];
      for (let i = 0; i <= N; i++) {
        const p = i / N;
        fn(p, out, 0);
        const r = Math.round(out[0] * 255), g = Math.round(out[1] * 255), b = Math.round(out[2] * 255);
        stops.push(`rgb(${r},${g},${b}) ${Math.round(p * 100)}%`);
      }
      this.$('cm-colorkey-bar').style.background = `linear-gradient(to right, ${stops.join(',')})`;
    }
    this.$('cm-colorkey-scar').hidden = !hasScar;
  }

  /**
   * Render the anatomical-region legend (Regions view): a clickable swatch per
   * tag. Clicking isolates that region (click again to clear). `active` is the
   * currently isolated tag, or null.
   */
  setRegionKey(tags, active) {
    this.$('cm-colorkey-grad').hidden = true;
    const c = this.$('cm-colorkey-regions');
    c.hidden = false;
    c.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'colorkey-note';
    note.textContent = active != null
      ? 'Isolating one region — click it again to show all.'
      : 'Each anatomical region a distinct colour. Click to isolate one.';
    c.appendChild(note);
    for (const t of tags) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'region-row' + (active === t ? ' active' : '');
      const sw = document.createElement('span');
      sw.className = 'region-sw';
      const [r, g, b] = regionRGB(t);
      sw.style.background = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      row.appendChild(sw);
      row.append(`Region ${t}`);
      row.addEventListener('click', () => this.onIsolate && this.onIsolate(active === t ? null : t));
      c.appendChild(row);
    }
  }
}

const TEMPLATE = `
    <label class="row">
      <span class="row-label">Colormap</span>
      <select id="cm-select">
        <option value="actionPotential">Action potential</option>
        <option value="viridis">Viridis</option>
        <option value="temperature">Temperature</option>
        <option value="regions">Regions (anatomy)</option>
      </select>
    </label>
    <div class="colorkey">
      <div id="cm-colorkey-grad">
        <div id="cm-colorkey-bar" class="colorkey-bar"></div>
        <div class="colorkey-labels"><span>Rest</span><span>Depolarized</span></div>
        <p class="colorkey-note">Front depolarizes, then a recovering <em>refractory</em> tail trails it back to rest.</p>
        <div id="cm-colorkey-scar" class="colorkey-scar" hidden><span class="ck-swatch"></span>Scar — conduction slowed / blocked</div>
      </div>
      <div id="cm-colorkey-regions" class="colorkey-regions" hidden></div>
    </div>
`;
