export default async function ({ page, shot, wait, BASE }) {
  for (const w of [1280, 1500]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto(BASE + '/#/match/' + process.env.MATCH);
    await wait(2500);
    await page.screenshot({ path: `/tmp/shots/topbar-${w}.png`, clip: { x: 0, y: 0, width: w, height: 50 } });
    const vis = await page.evaluate(() => { const b = [...document.querySelectorAll('.topbar button')].find((x) => x.textContent.includes('Export')); const r = b.getBoundingClientRect(); return r.right <= window.innerWidth; });
    console.log(w, 'export visible', vis);
  }
}
