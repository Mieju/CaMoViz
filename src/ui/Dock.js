/**
 * Left-edge dock: a thin always-visible icon rail plus a flyout drawer that
 * shows one section's controls at a time. Replaces the scatter of floating
 * panels with a single tidy home, while keeping the 3D mesh the hero — clicking
 * the active icon (or the flyout's ×) collapses back to just the rail.
 *
 * Each registered section returns a content element for the caller to populate;
 * the dock owns only the chrome (rail icon, section header, show/hide logic).
 */
export class Dock {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'dock';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="dock-rail"></div>
      <div class="dock-flyout" hidden><div class="dock-flyout-inner"></div></div>`;
    document.body.appendChild(this.el);

    this.rail = this.el.querySelector('.dock-rail');
    this.flyout = this.el.querySelector('.dock-flyout');
    this.inner = this.el.querySelector('.dock-flyout-inner');
    this.sections = new Map();
    this.active = null;
  }

  /**
   * Register a section.
   * @returns {HTMLElement} the section body to populate with controls.
   */
  addSection({ id, title, icon }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dock-icon';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = icon;
    btn.addEventListener('click', () => this.toggle(id));
    this.rail.appendChild(btn);

    const panel = document.createElement('section');
    panel.className = 'dock-section';
    panel.hidden = true;
    panel.innerHTML = `
      <header class="dock-section-head">
        <span>${title}</span>
        <button class="dock-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="dock-section-body"></div>`;
    panel.querySelector('.dock-close').addEventListener('click', () => this.close());
    this.inner.appendChild(panel);

    this.sections.set(id, { btn, panel, body: panel.querySelector('.dock-section-body') });
    return this.sections.get(id).body;
  }

  toggle(id) { (this.active === id) ? this.close() : this.open(id); }

  open(id) {
    if (!this.sections.has(id)) return;
    for (const [sid, sec] of this.sections) {
      const on = sid === id;
      sec.panel.hidden = !on;
      sec.btn.classList.toggle('active', on);
    }
    this.flyout.hidden = false;
    this.active = id;
  }

  close() {
    for (const sec of this.sections.values()) {
      sec.panel.hidden = true;
      sec.btn.classList.remove('active');
    }
    this.flyout.hidden = true;
    this.active = null;
  }

  show(visible) {
    this.el.hidden = !visible;
    if (!visible) this.close();
  }
}

/** Inline 20×20 SVG icons (currentColor), one per section. */
export const DOCK_ICONS = {
  mesh: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 9.5v8.5M4 7.5l8 4.5 8-4.5"/></svg>`,
  scenarios: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>`,
  simulation: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></g><g fill="var(--bg)" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="7" r="2.3"/><circle cx="15" cy="12" r="2.3"/><circle cx="8" cy="17" r="2.3"/></g></svg>`,
  view: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 6c-4.5 0-8.3 2.9-9.8 7 1.5 4.1 5.3 7 9.8 7s8.3-2.9 9.8-7C20.3 8.9 16.5 6 12 6zm0 11.5A4.5 4.5 0 1112 8.5a4.5 4.5 0 010 9zm0-2A2.5 2.5 0 1012 10.5a2.5 2.5 0 000 5z"/></svg>`,
};
