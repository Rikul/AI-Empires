export default async function ({ page, shot, wait, BASE }) {
  await page.goto(BASE + '/#/match/' + process.env.MATCH);
  await wait(2500);
  await page.click('.seg button[data-layout="left"]');
  await page.selectOption('.vp-header select', 'omni');
  await page.keyboard.press('Space');
  await wait(2000);
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      const g = window.__aiEmpires; const s = g.session.view;
      const mil = s.entities.filter((e) => e.kind === 'unit' && e.owner !== -1 && e.type !== 'Villager' && e.hp > 0 && e.anim === 'attack');
      const pick = mil.length ? mil : s.entities.filter((e) => e.kind === 'unit' && e.owner === 0 && e.type !== 'Villager' && e.hp > 0);
      if (!pick.length) return;
      const x = pick.reduce((a, e) => a + e.x, 0) / pick.length, y = pick.reduce((a, e) => a + e.y, 0) / pick.length;
      g.viewports[0].dist = 22; g.viewports[0].lookAt(x, y + 2);
      g.input.setSelection(pick.slice(0, 6).map((e) => e.id));
    });
    await wait(2500);
  }
  await shot('battle');
}
