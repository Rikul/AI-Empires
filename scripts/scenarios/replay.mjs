export default async function ({ page, shot, wait, BASE }) {
  await page.goto(BASE + '/#/match/' + process.env.MATCH);
  await wait(2500);
  await page.keyboard.press('Space');
  await wait(4000);
  await shot('replay-start');
  // seek to 19:00 via the timeline
  await page.evaluate(() => { const s = document.querySelector('.timeline input[type=range]'); s.value = String(19 * 600); s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); });
  await wait(8000);
  await page.click('.panel-toggle');
  await wait(500);
  await page.selectOption('.vp-header select', 'omni');
  await wait(1500);
  await shot('replay-mid');
  await page.evaluate(() => { const s = document.querySelector('.timeline input[type=range]'); s.value = s.max; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); });
  await wait(6000);
  await shot('replay-end');
  // export via the server and import it back through the file input
  const exported = await page.evaluate(async (id) => (await fetch(`/api/matches/${id}/export`)).text(), process.env.MATCH);
  const fs = await import('node:fs');
  fs.writeFileSync('/tmp/shots/export.json', exported);
  const bad = JSON.parse(exported); bad.commands[5].tick = 'x';
  fs.writeFileSync('/tmp/shots/bad.json', JSON.stringify(bad));
  await page.goto(BASE + '/');
  await wait(1000);
  await page.setInputFiles('input[type=file]', '/tmp/shots/bad.json');
  await wait(2000);
  await shot('import-bad');
  await page.mouse.click(5, 5);
  await wait(300);
  await page.setInputFiles('input[type=file]', '/tmp/shots/export.json');
  await wait(6000);
  await shot('import-good');
}
