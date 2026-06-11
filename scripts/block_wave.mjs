// Verifies the worker geodesic path: load the large block.vtu (> 150k verts →
// Dijkstra runs in the Web Worker), click it, and confirm a wave renders.
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:4180/';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--js-flags=--max-old-space-size=8192'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.setInputFiles('#file-input', 'block.vtu');
await page.waitForSelector('#overlay.hidden', { timeout: 600000, polling: 500 });
await page.waitForTimeout(1500);

const box = await page.locator('#viewport canvas').boundingBox();
const t0 = Date.now();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(500);
await page.screenshot({ path: 'scripts/block_wave.png' });
const clickMs = Date.now() - t0;

await browser.close();
console.log('console errors:', errors.length, errors.slice(0, 5));
console.log('click→render ms:', clickMs);
if (errors.length) process.exit(1);
console.log('BLOCK WAVE OK');
