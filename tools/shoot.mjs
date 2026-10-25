// Headless screenshots of the gallery. Usage: node tools/shoot.mjs [port] [query ...]
// Each query like "view=units&t=1.2" -> /tmp/gallery_<sanitized>.png
import { chromium } from '/home/rikul/src/ai_empires/node_modules/playwright-core/index.mjs';

const port = process.argv[2] ?? '5199';
const queries = process.argv.slice(3);
if (!queries.length) queries.push('view=overview&t=1');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const q of queries) {
  await page.goto(`http://localhost:${port}/gallery.html?${q}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const name = q.replace(/[^a-zA-Z0-9=.]+/g, '_').replace(/=/g, '-');
  const file = `/tmp/gallery_${name}.png`;
  await page.screenshot({ path: file });
  console.log(file);
}
await browser.close();
