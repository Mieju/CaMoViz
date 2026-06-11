// Loads a user-supplied .vtu through the real browser pipeline via the file
// picker (reads from disk, hands a File to the page — no server copy needed).
// Usage: SMOKE_URL=http://localhost:4180/ node scripts/block_smoke.mjs block.vtu
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:4180/';
const FILE = process.argv[2] || 'block.vtu';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--js-flags=--max-old-space-size=8192'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });

const t0 = Date.now();
await page.setInputFiles('#file-input', FILE);

// Wait until either the overlay hides (success) or the error toast appears.
let result = 'timeout';
try {
  await page.waitForFunction(() => {
    const o = document.getElementById('overlay');
    const t = document.getElementById('toast');
    if (o.classList.contains('hidden')) return 'ok';
    if (t && !t.hidden && t.classList.contains('error')) return 'err';
    return false;
  }, { timeout: 600000, polling: 500 });
  result = await page.evaluate(() =>
    document.getElementById('overlay').classList.contains('hidden') ? 'ok' : 'err');
} catch { result = 'timeout'; }

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const toast = await page.evaluate(() => document.getElementById('toast').textContent);
if (result === 'ok') {
  await page.waitForTimeout(1500); // let the landing overlay finish fading out
  await page.screenshot({ path: 'scripts/block_smoke.png' });
}

await browser.close();
console.log(`result: ${result} in ${secs}s`);
console.log(`toast: "${toast}"`);
console.log(`console errors: ${errors.length}`, errors.slice(0, 6));
process.exit(result === 'ok' ? 0 : 1);
