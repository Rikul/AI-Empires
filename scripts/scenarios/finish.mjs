export default async function ({ page, shot, wait, BASE }) {
  const cfg = { mode: 'pva', mapSize: 'Small', biome: 'SnowyHighlands', seed: 'finish', popCap: 200, timeLimitMin: 1, generationVersion: 1, rulesVersion: 1, decisionIntervalSec: 15, decisionWindowSec: 10,
    players: [{ kind: 'human', name: 'Tester' }, { kind: 'ai', ai: { name: 'Mock', baseUrl: BASE + '/mock/v1', model: 'scripted-mock' } }] };
  await page.goto(BASE + '/');
  const rec = await page.evaluate(async (cfg) => (await fetch('/api/matches', { method: 'POST', body: JSON.stringify({ config: cfg }) })).json(), cfg);
  await page.goto(BASE + '/#/match/' + rec.id);
  await wait(2500);
  await page.keyboard.press('Space');
  await page.click('text=2×');
  for (let i = 0; i < 40; i++) {
    await wait(3000);
    const done = await page.evaluate(() => !!document.querySelector('.modal'));
    if (done) break;
  }
  await shot('finish');
  // reload: the completed match should be listed and open as a replay
  await page.goto(BASE + '/');
  await wait(1500);
  const list = await page.evaluate(async () => (await fetch('/api/matches')).json());
  const m = list.find((x) => x.id === rec.id);
  console.log('status after reload', m.status, JSON.stringify(m.result), m.currentTick);
}
