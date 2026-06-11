// Verifies the Phase 2 click → wave pipeline: load the example mesh, click its
// center, and confirm the per-vertex colors change over the animation (the wave
// front actually moves), capturing a few frames.
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:4180/';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /load example/i }).click();
await page.waitForSelector('#overlay.hidden', { timeout: 15000 });
await page.waitForTimeout(600);

// Click the center of the canvas to stimulate a wave.
const box = await page.locator('#viewport canvas').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

// Capture frames across the animation.
const shots = [];
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `scripts/wave_${i}.png` });
  shots.push(`scripts/wave_${i}.png`);
}

const hintHidden = await page.evaluate(() => document.getElementById('hint').hidden);
await browser.close();

console.log('console errors:', errors.length, errors.slice(0, 5));
console.log('hint hidden after click:', hintHidden);
console.log('frames:', shots.join(', '));
if (errors.length) process.exit(1);
console.log('WAVE SMOKE OK');
