// Experiment: does a one-way conduction GATE in the scar channel let the SMOOTH
// eikonal engine sustain natural anatomical reentry? Builds the graph, blocks
// retrograde directed edges in a small disc on the channel ring (a unidirectional
// valve), fires a single S1 beat from healthy tissue near the corridor, and
// checks for a sustained circulating wave + its lap period. Sweeps gate site,
// radius, circulation sign, refractory. Run: node scripts/experiment_gate.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildConductionGraph } from '../src/mesh/ConductionGraph.js';
import { ExcitableMedium } from '../src/wave/ExcitableMedium.js';
import { parseVtuAscii, velocityFactorFromFibrosis } from '../tests/helpers/parseVtuAscii.js';

// NOTE: this is a legacy gate-sweep tool for the synthetic prolate-spheroid
// substrate (now the ASCII test fixture). The shipped heart VT substrate is
// (re)built by scripts/build_vt_substrate.py and validated by
// tests/wave/Reentry.test.js against public/example_heart_vt.vtu.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { positions, vertexCount, pointData, geometry } =
  parseVtuAscii(readFileSync(join(ROOT, 'tests', 'fixtures', 'example_substrate.vtu'), 'utf8'));

const meshScale = meshScaleOf(positions, vertexCount);
const baseV = (meshScale / 1.2) * 1.0;
const vf = velocityFactorFromFibrosis(pointData.fibrosis, vertexCount);
const fib = pointData.fibrosis;

// Scar centroid + channel ring vertices.
const center = centroid(positions, vertexCount, (v) => fib[v] >= 0.95);
const channel = []; for (let v = 0; v < vertexCount; v++) if (fib[v] > 0.3 && fib[v] < 0.95) channel.push(v);
// Restrict the ring to vertices close to the centroid (exclude the corridor tail).
const ring = channel.filter((v) => norm(sub(pos(v), center)) < 0.42);
console.error(`center=${center.map(n=>+n.toFixed(2))} ring=${ring.length}/${channel.length}`);

// S1: healthy vertex nearest the corridor mouth (toward base, phi≈0).
const s1 = nearestHealthy([1.0, 0, -0.25]);
console.error(`S1=${s1} xyz=${pos(s1).map(n=>+n.toFixed(2))}  baseV=${baseV.toFixed(2)}`);

const gateSites = sample(ring, 16);
const hits = [];
for (const gate of gateSites) {
  for (const radFrac of [0.06, 0.10, 0.15]) {
    for (const sign of [1, -1]) {
      for (const refr of [0.3, 0.45]) {
        const graph = buildConductionGraph(geometry, vf);
        const blocked = applyOneWayGate(graph, gate, center, meshScale * radFrac, sign);
        if (blocked < 2) continue;                  // gate did nothing
        const r = run(graph, s1, refr);
        if (r.sustain) hits.push({ gate, radFrac, sign, refr, ...r, blocked });
      }
    }
  }
}
hits.sort((a, b) => b.lap - a.lap);
console.error(`\nsustained-reentry gates: ${hits.length}`);
for (const h of hits.slice(0, 10)) {
  console.log(JSON.stringify({ gate: h.gate, gatexyz: pos(h.gate).map(n=>+n.toFixed(3)),
    radFrac: h.radFrac, sign: h.sign, refr: h.refr, lap: +h.lap.toFixed(2), frontEnd: h.frontEnd, blocked: h.blocked }));
}
process.exit(hits.length ? 0 : 1);

/** Zero retrograde directed edges within `radius` of `gateV` (one-way valve). */
function applyOneWayGate(graph, gateV, scarCenter, radius, sign) {
  const { offsets, neighbors, edgeFactor } = graph;
  const gp = pos(gateV), n = unit(gp);
  let radial = sub(gp, scarCenter); radial = sub(radial, scale(n, dot(radial, n))); radial = unit(radial);
  const tangent = scale(unit(cross(n, radial)), sign);   // allowed circulation
  let blocked = 0;
  for (let a = 0; a < vertexCount; a++) {
    if (fib[a] <= 0.3) continue;                  // gate lives in channel tissue only
    if (norm(sub(pos(a), gp)) > radius) continue;
    for (let e = offsets[a]; e < offsets[a + 1]; e++) {
      const b = neighbors[e];
      const edir = sub(pos(b), pos(a));
      if (dot(edir, tangent) < -1e-6) { if (edgeFactor[e] > 0) blocked++; edgeFactor[e] = 0; }
    }
  }
  return blocked;
}

function run(graph, s1, refr) {
  const m = new ExcitableMedium({ graph, baseVelocity: baseV, refractoryPeriod: refr, waveWidth: Math.min(0.08, refr * 0.3) });
  m.stimulate(s1, 0);
  let prev = -Infinity, sum = 0, gaps = 0;
  const probe = ring[0];
  const total = 20, dt = 0.05;
  for (let t = dt; t <= total + 1e-9; t += dt) {
    m.step(t);
    if (m.lastFired[probe] > prev + 1e-6 && m.lastFired[probe] > 0.2) {
      const g = m.lastFired[probe] - prev; if (prev > 0 && g > refr * 0.9) { sum += g; gaps++; } prev = m.lastFired[probe];
    }
  }
  let frontEnd = 0; for (let v = 0; v < vertexCount; v++) if (total - m.lastFired[v] < refr) frontEnd++;
  const lap = gaps >= 3 ? sum / gaps : 0;
  return { sustain: m.isActive && frontEnd > 5 && lap > refr, lap, frontEnd };
}

function nearestHealthy(target) { let best = -1, bd = 1e9; for (let v = 0; v < vertexCount; v++) { if (vf[v] < 0.95) continue; const d = norm(sub(pos(v), target)); if (d < bd) { bd = d; best = v; } } return best; }
function pos(v) { return [positions[3*v], positions[3*v+1], positions[3*v+2]]; }
function centroid(p, n, pred) { let s=[0,0,0], c=0; for (let v=0;v<n;v++) if (pred(v)) { s[0]+=p[3*v]; s[1]+=p[3*v+1]; s[2]+=p[3*v+2]; c++; } return [s[0]/c,s[1]/c,s[2]/c]; }
function sub(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
function scale(a,s){return [a[0]*s,a[1]*s,a[2]*s];}
function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function norm(a){return Math.hypot(a[0],a[1],a[2]);}
function unit(a){const l=norm(a)||1;return [a[0]/l,a[1]/l,a[2]/l];}
function sample(a,k){if(a.length<=k)return a.slice();const s=a.length/k,o=[];for(let i=0;i<k;i++)o.push(a[Math.floor(i*s)]);return o;}
function meshScaleOf(p,n){let a=[1/0,1/0,1/0],b=[-1/0,-1/0,-1/0];for(let v=0;v<n;v++)for(let k=0;k<3;k++){const x=p[3*v+k];if(x<a[k])a[k]=x;if(x>b[k])b[k]=x;}const c=[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];let r2=0;for(let v=0;v<n;v++){let d=0;for(let k=0;k<3;k++){const e=p[3*v+k]-c[k];d+=e*e;}if(d>r2)r2=d;}return 2*Math.sqrt(r2);}
