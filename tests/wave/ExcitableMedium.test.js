import { describe, it, expect } from 'vitest';
import { ExcitableMedium } from '../../src/wave/ExcitableMedium.js';

/** A chain 0—1—2—…  with unit edge lengths and per-edge conduction factors. */
function chain(n, factors) {
  const offsets = new Uint32Array(n + 1);
  const deg = (v) => (v > 0 ? 1 : 0) + (v < n - 1 ? 1 : 0);
  for (let v = 0; v < n; v++) offsets[v + 1] = offsets[v] + deg(v);
  const E = offsets[n];
  const neighbors = new Uint32Array(E);
  const edgeLen = new Float32Array(E).fill(1);
  const edgeFactor = new Float32Array(E);
  const cur = offsets.slice(0, n);
  const add = (a, b, f) => { const i = cur[a]++; neighbors[i] = b; edgeFactor[i] = f; };
  for (let v = 0; v < n - 1; v++) {
    const f = factors ? factors[v] : 1;
    add(v, v + 1, f); add(v + 1, v, f);
  }
  return { offsets, neighbors, edgeLen, edgeFactor, vertexCount: n };
}

function medium(graph, refractoryPeriod = 10, waveWidth = 0.1, baseVelocity = 1) {
  return new ExcitableMedium({ graph, baseVelocity, refractoryPeriod, waveWidth });
}

describe('ExcitableMedium', () => {
  it('propagates a stimulus along edges at the conduction speed', () => {
    const m = medium(chain(4)); // delay = length/velocity = 1 per hop
    m.stimulate(0, 0);
    m.step(0.5);
    expect(m.lastFired[0]).toBe(0);
    expect(m.lastFired[1]).toBe(-Infinity); // not yet (arrives at t=1)
    m.step(1.5);
    expect(m.lastFired[1]).toBe(1);
    m.step(2.5);
    expect(m.lastFired[2]).toBe(2);
  });

  it('does not back-propagate into freshly refractory tissue', () => {
    const m = medium(chain(3)); // long refractory
    m.stimulate(0, 0);
    m.step(5);
    // 0→1→2 forward only; vertex 0 must not re-fire from 1's backward event.
    expect(m.lastFired[0]).toBe(0);
    expect(m.lastFired[1]).toBe(1);
    expect(m.lastFired[2]).toBe(2);
  });

  it('blocks a stimulus delivered during the refractory period', () => {
    const m = medium(chain(2), 0.5);
    m.stimulate(0, 0);
    m.stimulate(0, 0.2);   // within refractory
    m.step(1);
    expect(m.lastFired[0]).toBe(0); // second stimulus dropped, not 0.2
  });

  it('allows a cell to fire again once recovered (reentry capability)', () => {
    const m = medium(chain(2), 0.5);
    m.stimulate(0, 0);
    m.stimulate(0, 0.6);   // past refractory
    m.step(1);
    expect(m.lastFired[0]).toBeCloseTo(0.6, 5); // Float32 storage
  });

  it('does not conduct across a blocked edge (factor 0)', () => {
    const m = medium(chain(3, [0, 1])); // edge 0—1 blocked
    m.stimulate(0, 0);
    m.step(10);
    expect(m.lastFired[0]).toBe(0);
    expect(m.lastFired[1]).toBe(-Infinity);
    expect(m.lastFired[2]).toBe(-Infinity);
  });

  it('sustains reentry around a unidirectional circuit', () => {
    // A ring with the counter-clockwise direction blocked is a clean one-way
    // loop. A single stimulus must circulate indefinitely as long as the lap
    // time (n hops) exceeds the refractory period — i.e. reentry is sustained.
    const n = 20;
    const offsets = new Uint32Array(n + 1);
    for (let v = 0; v < n; v++) offsets[v + 1] = offsets[v] + 2;
    const E = 2 * n;
    const neighbors = new Uint32Array(E);
    const edgeLen = new Float32Array(E).fill(1);
    const edgeFactor = new Float32Array(E);
    const cur = offsets.slice(0, n);
    for (let v = 0; v < n; v++) {
      let i = cur[v]++; neighbors[i] = (v + 1) % n; edgeFactor[i] = 1;       // clockwise: open
      i = cur[v]++; neighbors[i] = (v + n - 1) % n; edgeFactor[i] = 0;        // counter-cw: blocked
    }
    const ring = { offsets, neighbors, edgeLen, edgeFactor, vertexCount: n };

    const m = new ExcitableMedium({ graph: ring, baseVelocity: 1, refractoryPeriod: 5, waveWidth: 0.5 });
    m.stimulate(0, 0);
    m.step(30); // > 1.5 laps (lap = 20)

    expect(m.isActive).toBe(true);                 // wave still circulating
    expect(m.lastFired[0]).toBeGreaterThan(18);    // vertex 0 re-fired after a full lap
  });

  it('reports the action-potential phase over time', () => {
    const g = chain(1);
    const m = medium(g, 1.0, 0.1);
    m.stimulate(0, 0);
    m.step(0.05); expect(m.getPhase(0)).toBeCloseTo(0.5, 5);  // mid-upstroke
    m.step(0.10); expect(m.getPhase(0)).toBeCloseTo(1.0, 5);  // peak
    m.step(1.00); expect(m.getPhase(0)).toBe(0);              // recovered
  });
});
