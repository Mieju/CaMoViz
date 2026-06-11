import { chromium } from 'playwright';
const URL = process.env.SMOKE_URL || 'http://localhost:4180/';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors=[]; page.on('console',m=>{if(m.type()==='error')errors.push(m.text());}); page.on('pageerror',e=>errors.push(String(e)));
await page.goto(URL,{waitUntil:'networkidle'});
await page.getByRole('button',{name:/load example/i}).click();
await page.waitForSelector('#overlay.hidden',{timeout:15000});
await page.waitForTimeout(500);
const conduction = await page.inputValue('#p-conduction');
// Orbit a little so the equatorial scar faces us.
const box = await page.locator('#viewport canvas').boundingBox();
await page.mouse.move(box.x+600,box.y+400); await page.mouse.down();
for(let x=600;x<=720;x+=20) await page.mouse.move(box.x+x, box.y+420);
await page.mouse.up(); await page.waitForTimeout(400);
await page.screenshot({path:'scripts/p4_scar.png'});
// Stimulate center.
await page.mouse.click(box.x+box.width*0.5, box.y+box.height*0.45);
const triggerOn = await page.locator('#p-trigger').isEnabled();
for (let i=0;i<6;i++){ await page.waitForTimeout(220); await page.screenshot({path:`scripts/p4_s1_${i}.png`}); }
await browser.close();
console.log('console errors:', errors.length, errors.slice(0,5));
console.log('conduction:', conduction, '| trigger enabled after click:', triggerOn);
if (errors.length || conduction!=='fibrosis' || !triggerOn) process.exit(1);
console.log('PHASE4 SMOKE OK');
