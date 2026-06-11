/**
 * Wires the landing overlay's drag-and-drop + file-picker UI.
 * Emits the selected File via the `onFile` callback.
 */
export class DropZone {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.dropEl     element that accepts drops + shows dragover state
   * @param {HTMLInputElement} opts.inputEl hidden <input type=file>
   * @param {HTMLElement} opts.pickBtn    button that opens the file picker
   * @param {(file: File) => void} opts.onFile
   */
  constructor({ dropEl, inputEl, pickBtn, onFile }) {
    this.dropEl = dropEl;
    this.inputEl = inputEl;
    this.onFile = onFile;

    pickBtn.addEventListener('click', () => inputEl.click());
    inputEl.addEventListener('change', () => {
      if (inputEl.files?.length) this._emit(inputEl.files[0]);
      inputEl.value = ''; // allow re-selecting the same file
    });

    // Drag-drop is bound on the whole window so users can drop anywhere,
    // but the dragover highlight only applies to the drop card.
    ['dragenter', 'dragover'].forEach((evt) =>
      window.addEventListener(evt, (e) => { this._prevent(e); dropEl.classList.add('dragover'); })
    );
    ['dragleave', 'drop'].forEach((evt) =>
      window.addEventListener(evt, (e) => {
        this._prevent(e);
        if (evt === 'dragleave' && e.relatedTarget) return;
        dropEl.classList.remove('dragover');
      })
    );
    window.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) this._emit(file);
    });
  }

  _emit(file) {
    if (this.onFile) this.onFile(file);
  }

  _prevent(e) {
    e.preventDefault();
    e.stopPropagation();
  }
}
