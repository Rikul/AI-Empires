// Headless browser driver for visual checks: node scripts/e2e.mjs <scenario>
import { chromium } from '../node_modules/playwright-core/index.mjs';
const BASE = process.env.BASE ?? 'http://localhost:8091';
const scenario = process.argv[2] ?? 'home';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await b.newPage({ viewport: { width: 1500, height: 900 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
const shot = async (name) => { await page.screenshot({ path: `/tmp/shots/${name}.png` }); console.log('shot', name); };
const wait = (ms) => page.waitForTimeout(ms);
try {
  const mod = await import(`./scenarios/${scenario}.mjs`);
  await mod.default({ page, shot, wait, BASE });
} catch (e) { console.log('ERROR', e.message); await shot('error'); }
console.log(logs.slice(0, 30).join('\n'));
await b.close();
