// Headless browser smoke test for the Phase 1 viewer.
// Loads the page, triggers the example mesh, screenshots, and asserts the WebGL
// canvas actually rendered something (non-background pixels present).
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL || 'http://localhost:4173/';
const OUT = process.env.SMOKE_OUT || 'scripts/smoke.png';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /load example/i }).click();

// Wait for the overlay to hide (mesh loaded) and a couple of render frames.
await page.waitForSelector('#overlay.hidden', { timeout: 15000 });
await page.waitForTimeout(800);
await page.screenshot({ path: OUT });

// Success signals from the load → render pipeline. (We don't read the GL
// backbuffer: Three.js leaves preserveDrawingBuffer off, so readPixels comes
// back blank even though the page composites the mesh — see the saved PNG.)
const state = await page.evaluate(() => {
  const c = document.querySelector('#viewport canvas');
  return {
    canvasW: c?.width || 0,
    overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
    toast: document.getElementById('toast').textContent,
  };
});

await browser.close();

console.log(`console errors: ${errors.length}`, errors.slice(0, 5));
console.log(`canvas width: ${state.canvasW}, overlay hidden: ${state.overlayHidden}`);
console.log(`toast: "${state.toast}"`);
console.log(`screenshot: ${OUT}`);

const ok = !errors.length && state.canvasW > 0 && state.overlayHidden && /vertices/.test(state.toast);
if (!ok) { console.error('FAIL: pipeline did not complete cleanly'); process.exit(1); }
console.log('SMOKE OK');
