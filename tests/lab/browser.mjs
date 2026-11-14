/**
 * Real-browser pass for the Client half of `@zekilou/dsh-ask-form`.
 *
 * The offline suites drive the component tree with a hook runtime; this one drives it with a
 * real layout engine and real keyboard events, which is the only way to catch the failure the
 * user reported: a row that looks clickable but is not, and an input that looks like plain
 * text so nobody finds it.
 *
 * Run it inside a Linux guest (this Mac's Harness must not be disturbed):
 *
 *   node tests/lab/serve.mjs --port 7321          # on the guest
 *   node tests/lab/browser.mjs http://127.0.0.1:7321
 *
 * `playwright-core` must be resolvable from the script's directory; the guest install keeps it
 * in `~/ask-form-lab/node_modules`, so copy this file next to that `node_modules` before running.
 */
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://127.0.0.1:7321';
const failures = [];
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

async function open(form) {
  await page.goto(`${base}/?form=${form}`, { waitUntil: 'load' });
  await page.waitForSelector('.daf-card', { timeout: 5000 });
}

/** Geometry check: is the element actually the thing under the pointer at its own centre? */
async function hitTest(selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (node === null) return { missing: true };
    const box = node.getBoundingClientRect();
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      inside: node.contains(target),
      landedOn: target === null ? null : `${target.tagName.toLowerCase()}.${(target.className || '').toString().split(/\s+/).join('.')}`,
    };
  }, selector);
}

/* ------------------------------------------------------- single: the report */

console.log('\nreal browser: single + free-text other');
{
  await open('single');
  const row = await hitTest('.daf-otherRow');
  check('the other row has real geometry', row.missing !== true && row.box.w > 200 && row.box.h >= 40, row);

  const input = await hitTest('.daf-otherRow input');
  check('the input is on screen and hit-testable', input.missing !== true && input.inside === true && input.box.w > 80, input);

  // Click the row itself, where a user aims, not the input.
  const box = row.box;
  await page.mouse.click(box.x + box.w - 30, box.y + box.h / 2);
  const focused = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase() ?? null);
  check('clicking the row puts the caret in the field', focused === 'input', focused);

  await page.keyboard.type('Rust');
  const typed = await page.inputValue('.daf-otherRow input');
  check('real keystrokes reach the field', typed === 'Rust', typed);
  const selected = await page.evaluate(() => document.querySelectorAll('.daf-otherRow.daf-optionSelected').length);
  check('typing marks the row as chosen', selected === 1, selected);

  await page.click('.daf-buttonPrimary');
  const answer = await page.evaluate(() => window.__answer ?? null);
  const decoded = answer === null ? null : JSON.parse(answer.answers[0].custom.slice('\u0001dsh-form:'.length));
  check('the typed answer is what the model receives', decoded?.values?.runtime === 'Rust', decoded?.values);
}

console.log('\nreal browser: single + listed option after typing');
{
  await open('single');
  await page.click('.daf-otherRow');
  await page.keyboard.type('Rust');
  await page.click('.daf-options button:first-child');
  await page.click('.daf-buttonPrimary');
  const answer = await page.evaluate(() => window.__answer ?? null);
  const decoded = answer === null ? null : JSON.parse(answer.answers[0].custom.slice('\u0001dsh-form:'.length));
  check('a listed option still wins after typing', decoded?.values?.runtime === 'Node 22 (Recommended)', decoded?.values);
}

/* ------------------------------------------------------------ multi + chips */

console.log('\nreal browser: multi + free-text other');
{
  await open('multi');
  await page.click('.daf-otherRow');
  await page.keyboard.type('不能联网');
  await page.keyboard.press('Enter');
  const chips = await page.$$eval('.daf-otherChips .daf-tag', (nodes) => nodes.map((node) => node.textContent));
  check('Enter turns the typed text into a visible chip', chips.length === 1 && chips[0].includes('不能联网'), chips);
  const cleared = await page.inputValue('.daf-otherRow input');
  check('the draft clears after adding', cleared === '', cleared);

  await page.click('.daf-chipRemove');
  const remaining = await page.$$eval('.daf-otherChips .daf-tag', (nodes) => nodes.length);
  check('the chip can be removed with its ×', remaining === 0, remaining);
}

/* -------------------------------------------------------- number input, tags */

console.log('\nreal browser: numeric half-typing');
{
  await open('kitchen');
  const input = page.locator('.daf-input[aria-label="数量"]');
  await input.click();
  await page.keyboard.type('1e');
  const value = await input.inputValue();
  check('the box keeps what was typed instead of NaN', value === '1e', value);
}

console.log('\nreal browser: tag input on a click-away submit');
{
  await open('tags');
  await page.click('.daf-tagBox input');
  await page.keyboard.type('alpha');
  await page.click('.daf-buttonPrimary');
  const answer = await page.evaluate(() => window.__answer ?? null);
  const decoded = answer === null ? null : JSON.parse(answer.answers[0].custom.slice('\u0001dsh-form:'.length));
  check('a tag typed but not Enter-ed still reaches the answer', JSON.stringify(decoded?.values?.labels) === '["alpha"]', decoded?.values);
}

/* ---------------------------------------------------------------- steps+notes */

console.log('\nreal browser: steps pages through notes');
{
  await open('stepsnotes');
  const first = await page.textContent('.daf-progress');
  check('progress counts the notes page', first === '1 / 3', first);

  // Submitting from here must complain and stay put instead of answering.
  await page.click('.daf-buttonPrimary');
  const blocked = await page.evaluate(() => window.__answer ?? null);
  const feedback = await page.textContent('.daf-feedback');
  check('an empty required step blocks submit', blocked === null);
  check('the block is explained', (feedback ?? '').includes('需要修正'), feedback);

  await page.fill('.daf-input', '甲');
  await page.click('[aria-label="下一题"]');
  await page.fill('.daf-input', '乙');
  await page.click('[aria-label="下一题"]');
  const onNotes = await page.$$eval('textarea.daf-textarea', (nodes) => nodes.length);
  check('the notes textarea is reachable as the last step', onNotes === 1, onNotes);
  await page.click('.daf-textarea');
  await page.keyboard.type('补充一句');
  await page.click('.daf-buttonPrimary');
  const answer = await page.evaluate(() => window.__answer);
  const decoded = JSON.parse(answer.answers[0].custom.slice('\u0001dsh-form:'.length));
  check('notes typed on the last step reach the answer', decoded?.notes === '补充一句', decoded?.notes);
}

/* --------------------------------------------------------- closed list, errors */

console.log('\nreal browser: closed list and the second round');
{
  await open('closed');
  const others = await page.$$eval('.daf-otherRow', (nodes) => nodes.length);
  check('allow_other false renders no free-text row', others === 0, others);
}
{
  await page.goto(`${base}/?form=reask&errors=1`, { waitUntil: 'load' });
  await page.waitForSelector('.daf-card');
  const errors = await page.$$eval('.daf-error', (nodes) => nodes.map((node) => node.textContent));
  check('a re-ask shows the previous failure on the field', errors.some((text) => text.includes('此项为必填')), errors);
}

/* --------------------------------------- the page must never be taken hostage */

console.log('\nreal browser: an open form does not block the page');
{
  await open('single');
  const frame = await page.evaluate(() => getComputedStyle(document.querySelector('.daf-frame')).pointerEvents);
  const card = await page.evaluate(() => getComputedStyle(document.querySelector('.daf-card')).pointerEvents);
  check('the positioning frame ignores the pointer', frame === 'none', frame);
  check('the card itself still takes the pointer', card === 'auto', card);

  await page.evaluate(() => { window.__bgClicks = 0; });
  await page.click('#bg');
  const clicks = await page.evaluate(() => window.__bgClicks);
  check('a control behind the form stays clickable', clicks === 1, clicks);
}

console.log('\nreal browser: Escape leaves the card');
{
  await open('single');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  const cards = await page.$$eval('.daf-card', (nodes) => nodes.length);
  const cancelled = await page.evaluate(() => window.__cancelled === true);
  check('Escape removes the card', cards === 0, cards);
  check('Escape tells the carrier it was cancelled', cancelled === true, cancelled);
}

console.log('\nreal browser: a submit that never answers can still be abandoned');
{
  await page.goto(`${base}/?form=single&hang=1`, { waitUntil: 'load' });
  await page.waitForSelector('.daf-card');
  await page.click('.daf-options button:first-child');
  await page.click('.daf-buttonPrimary');
  await page.waitForTimeout(400);
  const label = await page.textContent('.daf-footerActions button:first-child');
  check('the exit is relabelled while a submit hangs', label.trim() === '关闭', label);
  await page.click('.daf-footerActions button:first-child');
  await page.waitForTimeout(150);
  const cards = await page.$$eval('.daf-card', (nodes) => nodes.length);
  check('the card closes even though the answer never landed', cards === 0, cards);
  await page.evaluate(() => { window.__bgClicks = 0; });
  await page.click('#bg');
  check('the page is usable right afterwards', (await page.evaluate(() => window.__bgClicks)) === 1);
}

console.log('\nreal browser: the old bundle reproduces the lockout');
{
  await page.goto(`${base}/?form=single&client=old`, { waitUntil: 'load' });
  await page.waitForSelector('.daf-card');
  await page.evaluate(() => { window.__bgClicks = 0; });
  await page.mouse.click(30, 30);
  const clicks = await page.evaluate(() => window.__bgClicks ?? 0);
  check('old bundle: the mask swallows clicks meant for the page', clicks === 0, clicks);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const cards = await page.$$eval('.daf-card', (nodes) => nodes.length);
  check('old bundle: Escape does nothing', cards === 1, cards);
}

console.log('\nreal browser: script mode is opt-in');
{
  await page.goto(`${base}/?form=script`, { waitUntil: 'load' });
  await page.waitForSelector('.daf-card');
  const text = await page.textContent('.daf-card');
  check('script mode is refused without the page flag', text.includes('显式授权'), text.slice(0, 60));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  check('the refusal surface can be closed too', (await page.$$eval('.daf-card', (nodes) => nodes.length)) === 0);
}
{
  await page.goto(`${base}/?form=script&allow=1`, { waitUntil: 'load' });
  await page.waitForSelector('.daf-card');
  const text = await page.textContent('.daf-card');
  check('an opting-in page still renders the script', text.includes('来自脚本的界面'), text.slice(0, 60));
}

console.log('\nreal browser: console hygiene');
check('no console errors anywhere', consoleErrors.length === 0, consoleErrors.slice(0, 3));

if (process.argv.includes('--screenshot')) {
  await open('single');
  await page.screenshot({ path: 'single.png', fullPage: false });
  await open('kitchen');
  await page.screenshot({ path: 'kitchen.png', fullPage: false });
}

await browser.close();
console.log(failures.length === 0 ? '\nALL BROWSER CHECKS PASSED' : `\n${failures.length} BROWSER CHECK(S) FAILED: ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;