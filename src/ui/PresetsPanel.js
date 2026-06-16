/**
 * Presets / scenarios panel (rendered into a dock section). Lists the always-
 * present **standard** scenarios (e.g. Healthy, Reentry) plus any **custom**
 * configuration presets the user saves from the current controls. Custom presets
 * persist in localStorage so they survive a reload. Applying a preset is
 * delegated to the app via `onApply(preset)`.
 *
 * A preset is: { id, name, builtin, gate, params:{…panel state…} }.
 */
const LS_KEY = 'cwv-custom-presets';

export class PresetsPanel {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mount  container to render into (dock section body)
   * @param {object[]} opts.builtins  standard presets (not editable/deletable)
   * @param {(preset:object) => void} opts.onApply
   * @param {() => {params:object, gate:boolean}} opts.getCurrent snapshot of the
   *        live controls, captured when the user saves a new preset
   */
  constructor({ mount, builtins, onApply, getCurrent }) {
    this.builtins = builtins || [];
    this.onApply = onApply;
    this.getCurrent = getCurrent;
    this.custom = this._load();

    this.el = mount;
    this.el.innerHTML = TEMPLATE;
    this._list = this.el.querySelector('.pw-list');
    this.el.querySelector('.pw-save').addEventListener('click', () => this._saveCurrent());
    this._render();
  }

  _saveCurrent() {
    const name = (prompt('Name this configuration preset:', `Preset ${this.custom.length + 1}`) || '').trim();
    if (!name) return;
    const cur = this.getCurrent ? this.getCurrent() : {};
    this.custom.push({ id: `c${Date.now()}`, name, builtin: false, gate: !!cur.gate, params: cur.params });
    this._persist();
    this._render();
  }

  _delete(id) {
    this.custom = this.custom.filter((p) => p.id !== id);
    this._persist();
    this._render();
  }

  _render() {
    this._list.innerHTML = '';
    this._list.appendChild(this._sectionLabel('Standard'));
    for (const p of this.builtins) this._list.appendChild(this._row(p, false));
    this._list.appendChild(this._sectionLabel('Custom'));
    if (!this.custom.length) {
      const empty = document.createElement('div');
      empty.className = 'pw-empty';
      empty.textContent = 'Save the current sliders + scenario below as a reusable preset.';
      this._list.appendChild(empty);
    }
    for (const p of this.custom) this._list.appendChild(this._row(p, true));
  }

  _sectionLabel(text) {
    const h = document.createElement('div');
    h.className = 'pw-section';
    h.textContent = text;
    return h;
  }

  _row(preset, deletable) {
    const row = document.createElement('div');
    row.className = 'pw-row';

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'pw-apply';
    apply.textContent = preset.name;
    if (preset.gate) {
      const tag = document.createElement('span');
      tag.className = 'pw-tag';
      tag.textContent = 'VT';
      tag.title = 'Installs the one-way reentry gate';
      apply.appendChild(tag);
    }
    apply.addEventListener('click', () => this.onApply && this.onApply(preset));
    row.appendChild(apply);

    if (deletable) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pw-del';
      del.textContent = '×';
      del.title = 'Delete preset';
      del.addEventListener('click', () => this._delete(preset.id));
      row.appendChild(del);
    }
    return row;
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
  }
  _persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.custom)); } catch { /* ignore quota */ }
  }
}

const TEMPLATE = `
  <div class="pw-list"></div>
  <button class="pw-save" type="button">＋ Save current configuration</button>
`;
