/**
 * Slim, persistent interaction cheat-sheet pinned bottom-centre. Replaces the
 * old one-line hint that vanished forever after the first wave — a teaching tool
 * should keep telling new viewers how to drive it.
 */
export class HelpBar {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'helpbar';
    this.el.hidden = true;
    this.el.innerHTML = TEMPLATE;
    document.body.appendChild(this.el);
  }

  show(visible) { this.el.hidden = !visible; }
}

const TEMPLATE = `
  <span><kbd>Click</kbd> fire wave</span>
  <span><kbd>Drag</kbd> rotate</span>
  <span><kbd>Scroll</kbd> zoom</span>
  <span><kbd>Right-drag</kbd> pan</span>
  <span><kbd>Space</kbd> pause</span>
`;
