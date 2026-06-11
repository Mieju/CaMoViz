/**
 * Binary min-heap priority queue keyed by a numeric priority.
 * Used by Dijkstra to always expand the closest frontier vertex next.
 */
export class PriorityQueue {
  constructor() {
    this._items = [];      // node payloads
    this._priority = [];   // parallel priorities
  }

  get size() {
    return this._items.length;
  }

  isEmpty() {
    return this._items.length === 0;
  }

  /** Smallest priority currently in the queue (undefined if empty). */
  peekPriority() {
    return this._priority[0];
  }

  push(item, priority) {
    this._items.push(item);
    this._priority.push(priority);
    this._siftUp(this._items.length - 1);
  }

  /** Remove and return the item with the smallest priority (or undefined if empty). */
  pop() {
    const n = this._items.length;
    if (n === 0) return undefined;
    const top = this._items[0];
    const lastItem = this._items.pop();
    const lastPri = this._priority.pop();
    if (n > 1) {
      this._items[0] = lastItem;
      this._priority[0] = lastPri;
      this._siftDown(0);
    }
    return top;
  }

  _siftUp(i) {
    const items = this._items, pri = this._priority;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[i] >= pri[parent]) break;
      this._swap(i, parent);
      i = parent;
    }
  }

  _siftDown(i) {
    const items = this._items, pri = this._priority;
    const n = items.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && pri[left] < pri[smallest]) smallest = left;
      if (right < n && pri[right] < pri[smallest]) smallest = right;
      if (smallest === i) break;
      this._swap(i, smallest);
      i = smallest;
    }
  }

  _swap(a, b) {
    const it = this._items, pr = this._priority;
    const ti = it[a]; it[a] = it[b]; it[b] = ti;
    const tp = pr[a]; pr[a] = pr[b]; pr[b] = tp;
  }
}
