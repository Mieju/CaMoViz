import { PriorityQueue } from '../utils/PriorityQueue.js';

/**
 * Real-time excitable-medium simulation on a triangle-mesh surface.
 *
 * Every vertex is an excitable cell that cycles resting → depolarized →
 * refractory → resting. A depolarizing cell conducts to its neighbours after an
 * edge delay (length / conduction speed); a neighbour only fires if it has
 * recovered from its last activation (i.e. is past its refractory period). This
 * refractory gating is what lets wavefronts annihilate, block unidirectionally,
 * and — around a conduction obstacle (fibrosis) — re-enter recovered tissue to
 * form a sustained rotor. Stimuli (clicks / pacing) inject firing events.
 *
 * The sim is event-driven (a priority queue of future firing times) and stepped
 * each animation frame; it is not a precomputed activation field.
 */
export class ExcitableMedium {
  /**
   * @param {object} opts
   * @param {ReturnType<import('../mesh/ConductionGraph.js').buildConductionGraph>} opts.graph
   * @param {number} opts.baseVelocity        conduction speed (mesh units / second) at factor 1
   * @param {number} opts.refractoryPeriod    seconds from activation back to excitable
   * @param {number} opts.waveWidth           seconds of the depolarization upstroke
   */
  constructor({ graph, baseVelocity, refractoryPeriod, waveWidth }) {
    this.g = graph;
    this.vertexCount = graph.vertexCount;
    this.setParams({ baseVelocity, refractoryPeriod, waveWidth });

    this.lastFired = new Float32Array(this.vertexCount).fill(-Infinity);
    this.fired = new Uint8Array(this.vertexCount); // ever fired (drives the active list)
    this.firedList = [];                            // vertices to recolor each frame
    this.queue = new PriorityQueue();               // future firing events (priority = time)
    this.simTime = 0;
  }

  setParams({ baseVelocity, refractoryPeriod, waveWidth }) {
    if (baseVelocity != null) this.baseVelocity = baseVelocity;
    if (refractoryPeriod != null) this.refractoryPeriod = refractoryPeriod;
    if (waveWidth != null) this.waveWidth = waveWidth;
    this.waveWidth = Math.min(this.waveWidth, this.refractoryPeriod * 0.9);
  }

  /** Inject a stimulus at a vertex (fires if that cell is excitable at `time`). */
  stimulate(vertex, time) {
    this.queue.push(vertex, time);
  }

  /** Advance the simulation, processing all firing events up to `toTime`. */
  step(toTime) {
    const q = this.queue;
    const { offsets, neighbors, edgeLen, edgeFactor, edgeDelay } = this.g;
    const lastFired = this.lastFired;
    const refractory = this.refractoryPeriod;
    const vel = this.baseVelocity;

    let budget = 4_000_000; // safety cap; leftover events resolve next frame
    while (!q.isEmpty() && q.peekPriority() <= toTime && budget-- > 0) {
      const t = q.peekPriority();
      const v = q.pop();
      if (t - lastFired[v] < refractory) continue; // still refractory → blocked

      lastFired[v] = t;
      if (!this.fired[v]) { this.fired[v] = 1; this.firedList.push(v); }

      const end = offsets[v + 1];
      for (let e = offsets[v]; e < end; e++) {
        const f = edgeFactor[e];
        if (f <= 0) continue; // conduction block
        const extra = edgeDelay ? edgeDelay[e] : 0; // fixed AV-node delay, if any
        this.queue.push(neighbors[e], t + edgeLen[e] / (vel * f) + extra);
      }
    }
    this.simTime = toTime;
  }

  /** Whether any wavefront is still propagating. */
  get isActive() {
    return !this.queue.isEmpty();
  }

  /** Activation phase of a vertex at the current sim time: 0 resting … 1 peak. */
  getPhase(v) {
    const dt = this.simTime - this.lastFired[v];
    if (!(dt > 0) || dt >= this.refractoryPeriod) return 0;
    if (dt < this.waveWidth) return dt / this.waveWidth;
    return 1 - (dt - this.waveWidth) / (this.refractoryPeriod - this.waveWidth);
  }

  /**
   * Composite the wave over a base color buffer. Only ever-fired vertices are
   * touched (the active set), so cost scales with the excited surface, not the
   * whole mesh.
   */
  composite(out, base, writeColor) {
    const list = this.firedList;
    for (let k = 0; k < list.length; k++) {
      const v = list[k], off = 3 * v;
      const phase = this.getPhase(v);
      if (phase <= 0) {
        out[off] = base[off]; out[off + 1] = base[off + 1]; out[off + 2] = base[off + 2];
      } else {
        writeColor(phase, out, off);
        const w = phase, iw = 1 - phase;
        out[off] = base[off] * iw + out[off] * w;
        out[off + 1] = base[off + 1] * iw + out[off + 1] * w;
        out[off + 2] = base[off + 2] * iw + out[off + 2] * w;
      }
    }
  }

  /** Clear all activity and pending events. */
  reset() {
    this.lastFired.fill(-Infinity);
    this.fired.fill(0);
    this.firedList.length = 0;
    this.queue = new PriorityQueue();
  }
}
