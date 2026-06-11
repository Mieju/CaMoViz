// Capture the block wave across time to confirm the propagation front is visible,
// and exercise the panel ▶ Trigger button (replay from the selected origin).
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

const triggerDisabledBefore = await page.locator('#p-trigger').isDisabled();

// Select an origin near a corner so the front sweeps across visibly.
const box = await page.locator('#viewport canvas').boundingBox();
await page.mouse.click(box.x + box.width * 0.40, box.y + box.height * 0.35);

const triggerEnabledAfter = await page.locator('#p-trigger').isEnabled();

// Sample frames during the sweep.
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `scripts/bf_${i}.png` });
}

// Now exercise the explicit replay button and grab one mid-wave frame.
await page.click('#p-trigger');
await page.waitForTimeout(500);
await page.screenshot({ path: 'scripts/bf_replay.png' });

await browser.close();
console.log('console errors:', errors.length, errors.slice(0, 5));
console.log('trigger disabled before click:', triggerDisabledBefore, '| enabled after:', triggerEnabledAfter);
if (errors.length || triggerDisabledBefore !== true || triggerEnabledAfter !== true) process.exit(1);
console.log('BLOCK FRAMES OK');
