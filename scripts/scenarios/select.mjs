// Verifies click, shift add/remove, box select and double-click select-same-type.
export default async function ({ page, shot, wait, BASE }) {
  const cfg = { mode: 'pva', mapSize: 'Small', biome: 'DesertOasis', seed: 'sel', popCap: 200, timeLimitMin: 60, generationVersion: 1, rulesVersion: 1, decisionIntervalSec: 15, decisionWindowSec: 10,
    players: [{ kind: 'human', name: 'Tester' }, { kind: 'ai', ai: { name: 'Mock', baseUrl: BASE + '/mock/v1', model: 'scripted-mock' } }] };
  await page.goto(BASE + '/');
  const rec = await page.evaluate(async (cfg) => (await fetch('/api/matches', { method: 'POST', body: JSON.stringify({ config: cfg }) })).json(), cfg);
  await page.goto(BASE + '/#/match/' + rec.id);
  await wait(2500);
  const canvasBox = await (await page.$('.game-canvas')).boundingBox();
  const units = async (type) => page.evaluate((type) => {
    const g = window.__aiEmpires; const vp = g.viewports[0];
    g.world.prepareView(g.session.view, vp.persp, vp.camera);
    return g.world.unitScreenPositions(vp.camera, vp.rect.w, vp.rect.h, g.session.view, (u) => u.owner === 0 && (!type || u.type === type));
  }, type);
  const sel = () => page.evaluate(() => window.__aiEmpires.input.selection.slice());
  const vills = await units('Villager');
  const at = (u) => [canvasBox.x + u.sx, canvasBox.y + u.sy - 6];
  const res = {};
  // single click
  await page.mouse.click(...at(vills[0]));
  await wait(400);
  res.click = await sel();
  // shift-click adds
  await page.keyboard.down('Shift');
  await page.mouse.click(...at(vills[1]));
  await wait(400);
  res.shiftAdd = await sel();
  // shift-click again removes
  await page.mouse.click(...at(vills[1]));
  await page.keyboard.up('Shift');
  await wait(400);
  res.shiftRemove = await sel();
  // double-click selects all visible villagers
  await page.mouse.click(...at(vills[2]));
  await wait(100);
  await page.mouse.dblclick(...at(vills[2]));
  await wait(500);
  res.dbl = await sel();
  res.villagerIds = vills.map((v) => v.id);
  // box select everything around the TC (villagers + scout)
  await page.mouse.move(canvasBox.x + 300, canvasBox.y + 150);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width - 300, canvasBox.y + canvasBox.height - 150, { steps: 6 });
  await page.mouse.up();
  await wait(400);
  res.box = await sel();
  await shot('select-box');
  console.log(JSON.stringify(res));
}
