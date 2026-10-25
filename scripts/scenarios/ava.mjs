export default async function ({ page, shot, wait, BASE }) {
  await page.goto(BASE + '/');
  await wait(800);
  await shot('home');
  await page.click('text=New match');
  await wait(500);
  await page.click('text=AI vs AI');
  await wait(400);
  for (const b of await page.$$('text=Use test commander')) await b.click();
  await wait(300);
  await shot('setup-ava');
  await page.click('text=Start match');
  await wait(3000);
  await shot('ava-start');
  await page.keyboard.press('Space');
  await wait(Number(process.env.PLAY ?? 15000));
  await shot('ava-play');
}
