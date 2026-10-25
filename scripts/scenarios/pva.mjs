export default async function ({ page, shot, wait, BASE }) {
  await page.goto(BASE + '/#/new');
  await wait(800);
  await page.click('text=Player vs AI');
  await wait(300);
  await page.click('text=Use test commander');
  await wait(200);
  await shot('setup-pva');
  await page.click('text=Start match');
  await wait(3000);
  await page.keyboard.press('Space');
  await wait(1500);
  const box = await page.$('.stage');
  const r = await box.boundingBox();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  // box select around the town center
  await page.mouse.move(cx - 260, cy - 200);
  await page.mouse.down();
  await page.mouse.move(cx + 260, cy + 120, { steps: 5 });
  await page.mouse.up();
  await wait(800);
  await shot('pva-selected');
  // click House build button
  await page.click('.cmd-grid button:has-text("House")');
  await wait(300);
  await page.mouse.move(cx - 150, cy + 60, { steps: 3 });
  await wait(500);
  await shot('pva-ghost');
  await page.mouse.click(cx - 150, cy + 60);
  await wait(4000);
  await shot('pva-building');
  // zoom in
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -200); await wait(100); }
  await wait(3000);
  await shot('pva-zoom');
}
