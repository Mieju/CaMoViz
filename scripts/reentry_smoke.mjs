// Headless smoke for the Reentry preset: load the example mesh, click Reentry,
// and confirm the rotor renders and keeps animating with no console errors.
// Usage: SMOKE_URL=http://localhost:4173/ node scripts/reentry_smoke.mjs
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:4173/';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.click('#example-btn');
await page.waitForSelector('#overlay.hidden', { timeout: 60000, polling: 200 });
await page.waitForTimeout(800);

// Switch to the VT-substrate example (the anatomy heart has no scar field).
await page.click('.dock-icon[aria-label="Mesh"]');
await page.click('.dock-section-body >> text=VT substrate');
await page.waitForTimeout(800);

// Open the dock's Scenarios section and apply the Reentry scenario.
await page.click('.dock-icon[aria-label="Scenarios"]');
await page.waitForSelector('.pw-apply', { timeout: 5000 });
await page.click('.pw-apply >> text=Reentry');
await page.waitForTimeout(500);

// A dying single wave would be quiescent within a few seconds, so sample the
// canvas LATE (≈8 s after S1) twice ~1.5 s apart: a SUSTAINED rotor must still be
// changing pixels then.
const canvas = page.locator('#viewport canvas');
const sum = (buf) => { let s = 0; for (let i = 0; i < buf.length; i += 101) s += buf[i]; return s; };
await page.waitForTimeout(8000);                 // let the circuit run many laps
const a = sum(await canvas.screenshot());
await page.waitForTimeout(1500);
const b = sum(await canvas.screenshot());

await browser.close();

console.log('console errors:', errors.length, errors.slice(0, 5));
console.log('late frame checksums:', a, b, 'changed:', a !== b);
if (errors.length) { console.log('FAIL: console errors'); process.exit(1); }
if (a === b) { console.log('FAIL: rotor not sustained (canvas static ~8 s after S1)'); process.exit(1); }
console.log('REENTRY SMOKE OK — reentry still circulating ~10 s after a single beat');
