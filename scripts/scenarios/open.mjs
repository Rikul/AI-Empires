export default async function ({ page, shot, wait, BASE }) {
  await page.goto(BASE + '/#/match/' + process.env.MATCH);
  await wait(3000);
  await shot('open-restored');
  if (process.env.OMNI) {
    for (const s of await page.$$('.vp-header select')) await s.selectOption('omni');
  }
  if (process.env.LAYOUT) await page.click(`.seg button[data-layout="${process.env.LAYOUT}"]`);
  await page.keyboard.press('Space');
  await wait(Number(process.env.PLAY ?? 6000));
  await shot('open-play');
  if (process.env.SEEK) {
    await page.click('text=⏪ 30s');
    await wait(4000);
    await shot('open-rewind');
  }
}
