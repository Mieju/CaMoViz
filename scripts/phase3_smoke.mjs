// Phase 3 checks on the example mesh: panel present, scalar-field dropdown
// populated + applied, colormap switch, origin marker, and a wave click.
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
await page.waitForTimeout(500);

const panelVisible = await page.locator('.panel').isVisible();
const fieldOptions = await page.$$eval('#p-field option', (os) => os.map((o) => o.textContent));

// Color the resting mesh by the scalar field, then switch colormap to viridis.
await page.selectOption('#p-field', { label: 'apex_base' });
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/p3_field.png' });

await page.selectOption('#p-colormap', 'viridis');
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/p3_viridis.png' });

// Back to resting palette, then click to trigger a wave (with origin marker).
await page.selectOption('#p-field', '');
await page.selectOption('#p-colormap', 'actionPotential');
const box = await page.locator('#viewport canvas').boundingBox();
await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45);
await page.waitForTimeout(350);
await page.screenshot({ path: 'scripts/p3_wave.png' });

await browser.close();
console.log('console errors:', errors.length, errors.slice(0, 5));
console.log('panel visible:', panelVisible);
console.log('field options:', JSON.stringify(fieldOptions));
if (errors.length || !panelVisible || !fieldOptions.includes('apex_base')) process.exit(1);
console.log('PHASE3 SMOKE OK');
