/**
 * Side-by-side screenshots for the free-text "other" row: last committed bundle vs the working
 * tree. Run inside the Linux guest, next to `playwright-core`:
 *
 *   node shots.mjs http://127.0.0.1:7321
 */
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://127.0.0.1:7321';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 860, height: 720 }, deviceScaleFactor: 2 });

async function shot(file, query, steps) {
  await page.goto(`${base}/?${query}`, { waitUntil: 'load' });
  await page.waitForSelector('.daf-card');
  if (steps !== undefined) await steps();
  await page.waitForTimeout(250);
  await page.screenshot({ path: file });
  console.log(`wrote ${file}`);
}

/* Works for both bundles: the free-text row is always the last one in the option list. */
const OTHER_ROW = '.daf-options > :last-child';

const addChip = async () => {
  await page.click(OTHER_ROW);
  await page.keyboard.type('不能联网');
  await page.keyboard.press('Enter');
};

await shot('before-single.png', 'form=single&client=old', async () => {
  await page.click(OTHER_ROW);
  await page.keyboard.type('Rust');
  await page.keyboard.press('Enter');
});
await shot('after-single.png', 'form=single', async () => {
  await page.click(OTHER_ROW);
  await page.keyboard.type('Rust');
});
await shot('before-multi.png', 'form=multi&client=old', addChip);
await shot('after-multi.png', 'form=multi', addChip);
await shot('after-kitchen.png', 'form=kitchen');

await browser.close();