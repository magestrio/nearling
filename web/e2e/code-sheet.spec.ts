import { expect, test, type Page } from '@playwright/test';
import type { ToolView } from '../src/seams/worker-types';
import { BISCUIT, calls, drawn, lookAgain, openWith, OWNER, PIXEL, reloadHolding, setWorker, SIGNED_IN } from './helpers';

// Skill code sheet (add-pet-errands › Skill code sheet screen, Skill code flow): where the owner writes the skill's code, runs one of its
// functions on sample values, ticks the functions the pet may call and saves it. The fakes answer the reads, the test runs and the saves.
test.use({ timezoneId: 'Etc/GMT-2' });

const LABEL = 'opening lines';
const INSTRUCTION = 'Give one surprising opening line, then say in one sentence why it works.';
const SAVED = 'export async function openerFor(month, day) {\n  return { month, day };\n}';
const EDITED = `${SAVED}\n// edited`;
const SESSION_LINE = "You've been signed out. Sign in to pick up where you left off.";
const ERROR_LINE = "We couldn't save that. Nothing's lost — try again.";
const OPENER: ToolView = {
  name: 'openerFor',
  description: 'An opening line for a date.',
  params: [{ name: 'month', type: 'number', required: true }, { name: 'day', type: 'number', required: true }],
  tickable: true,
  ticked: true,
};
const RAW: ToolView = { name: 'rawFeed', description: 'The feed as it is.', params: [{ name: 'query', type: 'text', required: true }], tickable: false, reason: 'free_text' };
const FUNCTIONS = [OPENER, RAW];

const skillSheet = (page: Page) => page.getByRole('dialog', { name: "Pixel's skill" });
const codeSheet = (page: Page) => page.getByRole('dialog', { name: "Pixel's code" });
const codeField = (page: Page) => codeSheet(page).getByLabel('JavaScript, up to 32 KB');
const fnField = (page: Page) => codeSheet(page).getByLabel('Function to test');
const valuesField = (page: Page) => codeSheet(page).getByLabel('Sample values');
const testRun = (page: Page) => codeSheet(page).getByRole('button', { name: 'Test run' });
const saveCode = (page: Page) => codeSheet(page).getByRole('button', { name: 'Save code' });

/** Pixel with its skill saved; `code` — what the server keeps of its code (none by default) */
const open = async (page: Page, written: boolean, extra: Record<string, unknown> = {}) => {
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: {
      ...OWNER,
      pets: { '9': { ...PIXEL, skill: { label: LABEL }, owner: {} }, '2': BISCUIT },
      skill: { skill: { label: LABEL, instruction: INSTRUCTION }, sources: [], code: written ? { functions: FUNCTIONS } : null },
      code: written ? { code: SAVED, functions: FUNCTIONS, testsLeft: 20 } : { code: null, functions: [], testsLeft: 20 },
      ...extra,
    },
  });
  await page.getByRole('button', { name: `Pixel's skill: Good at ${LABEL}` }).click();
  await expect(skillSheet(page)).toBeVisible();
  await skillSheet(page).getByRole('button', { name: written ? "Pixel's code" : 'Add code' }).click();
  await expect(codeSheet(page)).toBeVisible();
  await expect(codeField(page)).toBeEditable();
};
/** the function named and its sample values typed, «Test run» tapped */
const runTest = async (page: Page, fn = 'openerFor', values = '11, 3') => {
  await fnField(page).fill(fn);
  await valuesField(page).fill(values);
  await testRun(page).click();
};

// spec: add-pet-errands › Skill code sheet screen › success
test('success: «Pixel\'s code», a blank field with its hint, the two lines, «Test run» and an inactive «Save code»', async ({ page }) => {
  await open(page, false);
  const dialog = codeSheet(page);
  await expect(dialog.getByRole('heading', { name: "Pixel's code" })).toBeVisible();
  await expect(codeField(page)).toHaveValue('');
  await expect(dialog.getByText("Declare Pixel's functions in export const functions.")).toBeVisible();
  await expect(dialog.getByText("Your code can reach only this skill's data sources. It runs apart from the game, with a time limit.")).toBeVisible();
  await expect(dialog.getByText("Only you can see this code. It's never shown to other players or sent to NEAR AI.")).toBeVisible();
  await expect(valuesField(page)).toHaveAccessibleDescription('e.g. BTC, 7');
  await expect(testRun(page)).toBeDisabled();
  await expect(saveCode(page)).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Remove code' })).toHaveCount(0);
  // a function named: the run is there
  await codeField(page).fill(SAVED);
  await fnField(page).fill('openerFor');
  await expect(testRun(page)).toBeEnabled();
  // typed and not tested: still nothing to save
  await expect(saveCode(page)).toBeDisabled();
});

// spec: add-pet-errands › Skill code sheet screen › code already written
test('code already written: the saved code, its functions ticked, «Remove code»; «Save code» waits for one test of the day, saved code unchanged or edited', async ({ page }) => {
  await open(page, true);
  const dialog = codeSheet(page);
  await expect(codeField(page)).toHaveValue(SAVED);
  await expect(dialog.getByRole('checkbox', { name: 'openerFor' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'rawFeed' })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: 'openerFor' })).toHaveAccessibleDescription(/An opening line for a date\. Takes: month \(number\), day \(number\)\./);
  await expect(dialog.getByRole('button', { name: 'Remove code' })).toBeVisible();
  // untouched, it is still off, and says what to do
  await expect(saveCode(page)).toBeDisabled();
  await expect(dialog.getByText('Changing which functions Pixel can call? Run one test first, then save.')).toBeVisible();
  await expect(saveCode(page)).toHaveAccessibleDescription('Changing which functions Pixel can call? Run one test first, then save.');
  await runTest(page);
  await expect(saveCode(page)).toBeEnabled();
  await expect(dialog.getByText('Changing which functions Pixel can call? Run one test first, then save.')).toHaveCount(0);
  // an edit after the pass: off again until a test of the edited code passes
  await codeField(page).fill(EDITED);
  await expect(saveCode(page)).toBeDisabled();
  await runTest(page);
  await expect(saveCode(page)).toBeEnabled();
  await codeField(page).fill(`${EDITED}\n// again`);
  await expect(saveCode(page)).toBeDisabled();
});

// spec: add-pet-errands › Skill code sheet screen › nothing to test
test('nothing to test: «Test run» is inactive while the field holds no code or «Function to test» names none, and turns active once both are filled', async ({ page }) => {
  await open(page, false);
  await expect(testRun(page)).toBeDisabled();
  await codeField(page).fill(SAVED);
  await expect(testRun(page)).toBeDisabled();
  await fnField(page).fill('openerFor');
  await expect(testRun(page)).toBeEnabled();
  await codeField(page).fill('');
  await expect(testRun(page)).toBeDisabled();
  await codeField(page).fill(SAVED);
  await fnField(page).fill('  ');
  await expect(testRun(page)).toBeDisabled();
  expect((await calls(page)).filter((c) => c.includes('testCode'))).toEqual([]);
});

// spec: add-pet-errands › Skill code flow › test passed
test('test passed: the output under the field, the functions it declares ticked but the one that takes text, «Save code» on', async ({ page }) => {
  await open(page, false, { testCode: { outcome: 'ok', output: '{ "year": 1957 }', functions: FUNCTIONS.map((f) => ({ ...f, ticked: undefined })) } });
  await codeField(page).fill(SAVED);
  await runTest(page);
  const dialog = codeSheet(page);
  await expect(dialog.locator('pre', { hasText: '{ "year": 1957 }' })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'openerFor' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'rawFeed' })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: 'rawFeed' })).not.toBeChecked();
  await expect(saveCode(page)).toBeEnabled();
  expect(await calls(page)).toContain('worker:testCode:openerFor');
  // a function unticked is not saved
  await dialog.getByRole('checkbox', { name: 'openerFor' }).uncheck();
  await expect(dialog.getByRole('checkbox', { name: 'openerFor' })).not.toBeChecked();
});

// spec: add-pet-errands › Skill code flow › limit hit
test('limit hit: «Your code ran past its limits. Make it lighter and test again.» and «Save code» stays inactive', async ({ page }) => {
  await open(page, false, { testCode: { outcome: 'limit' } });
  await codeField(page).fill(SAVED);
  await runTest(page);
  await expect(codeSheet(page).getByText('Your code ran past its limits. Make it lighter and test again.').first()).toBeVisible();
  await expect(saveCode(page)).toBeDisabled();
});

// spec: add-pet-errands › Skill code flow › code error
test('code error: «Your code stopped with an error:» and the error\'s text; «Save code» stays inactive', async ({ page }) => {
  await open(page, false, { testCode: { outcome: 'error', error: "TypeError: Cannot read properties of undefined (reading 'year')\n    at openerFor (code.js:5:24)" } });
  await codeField(page).fill(SAVED);
  await runTest(page);
  await expect(codeSheet(page).getByText('Your code stopped with an error:').first()).toBeVisible();
  await expect(codeSheet(page).getByText("TypeError: Cannot read properties of undefined (reading 'year')", { exact: false })).toBeVisible();
  await expect(saveCode(page)).toBeDisabled();
});

// spec: add-pet-errands › Skill code flow › function not declared
test('function not declared: «nope isn\'t in export const functions, so nothing ran. …»; «Save code» stays inactive and «Test run» stays live', async ({ page }) => {
  await open(page, false, { testCode: { outcome: 'undeclared', fn: 'nope' } });
  await codeField(page).fill(SAVED);
  await runTest(page, 'nope');
  await expect(codeSheet(page).getByText("nope isn't in export const functions, so nothing ran. Declare it there and test again.").first()).toBeVisible();
  await expect(saveCode(page)).toBeDisabled();
  await expect(testRun(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-errands › Skill code flow › cap reached
test('cap reached: «Test run» is off, the console tells when it is back (00:00 UTC in local time); the field keeps its text', async ({ page }) => {
  await open(page, false, { testCode: { fail: { status: 429, code: 'tests_used_up' } } });
  await codeField(page).fill(SAVED);
  await runTest(page);
  const line = "That's all the test runs for today. Your code is still here — test it again at 02:00.";
  await expect(codeSheet(page).getByText(line).first()).toBeVisible();
  await expect(testRun(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(testRun(page)).toHaveAccessibleDescription(line);
  await expect(codeField(page)).toHaveValue(SAVED);
  const before = (await calls(page)).filter((c) => c.includes('testCode')).length;
  await testRun(page).click({ force: true });
  expect((await calls(page)).filter((c) => c.includes('testCode')).length).toBe(before);
});

// spec: add-pet-errands › Skill code flow › cap reached
test('cap reached: a sheet opened with no test runs left says it at once', async ({ page }) => {
  await open(page, true, { code: { code: SAVED, functions: FUNCTIONS, testsLeft: 0 } });
  await expect(codeSheet(page).getByText("That's all the test runs for today. Your code is still here — test it again at 02:00.").first()).toBeVisible();
  await expect(testRun(page)).toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-errands › Skill code flow › cap reached
test('cap reached: the twentieth run keeps its output and gives Test run its cap reason', async ({ page }) => {
  await open(page, true, { code: { code: SAVED, functions: FUNCTIONS, testsLeft: 1 } });
  await runTest(page);
  const line = "That's all the test runs for today. Your code is still here — test it again at 02:00.";
  await expect(codeSheet(page).getByText('"ok"')).toBeVisible();
  await expect(drawn(page, line)).toBeVisible();
  await expect(testRun(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(testRun(page)).toHaveAccessibleDescription(line);
});

// spec: add-pet-errands › Skill code flow › test passed
test('test passed: an unticked saved function stays unticked while a new usable function is ticked', async ({ page }) => {
  const next = { ...OPENER, name: 'newFunction', ticked: true };
  await open(page, true, { code: { code: SAVED, functions: [{ ...OPENER, ticked: false }, RAW], testsLeft: 20 }, testCode: { outcome: 'ok', output: '"ok"', functions: [OPENER, next, RAW] } });
  await runTest(page);
  await expect(codeSheet(page).getByRole('checkbox', { name: 'openerFor' })).not.toBeChecked();
  await expect(codeSheet(page).getByRole('checkbox', { name: 'newFunction' })).toBeChecked();
});

// spec: add-pet-errands › Skill code sheet screen › success
test('success: UTF-8 code over 32 KB gets a field error and cannot be run or saved', async ({ page }) => {
  await open(page, false);
  await codeField(page).fill('é'.repeat(16_385));
  await fnField(page).fill('openerFor');
  await expect(codeField(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(codeField(page)).toHaveAccessibleDescription(/JavaScript, up to 32 KB\./);
  await expect(testRun(page)).toBeDisabled();
  await expect(saveCode(page)).toBeDisabled();
  expect((await calls(page)).filter((c) => c.includes('testCode'))).toEqual([]);
});

// spec: add-pet-errands › Skill code sheet screen › success × the session ends and sign-in returns
test('success × 401 during Test run: the sheet and typing stay with Sign in', async ({ page }) => {
  await open(page, false);
  await codeField(page).fill(EDITED);
  await fnField(page).fill('openerFor');
  await valuesField(page).fill('11, 3');
  await setWorker(page, { sessionExpired: true });
  await testRun(page).click();
  await expect(codeSheet(page).getByText(SESSION_LINE).and(page.locator(':not(.ds-hidden)'))).toBeVisible();
  await expect(codeField(page)).toHaveValue(EDITED);
  await expect(fnField(page)).toHaveValue('openerFor');
  await expect(valuesField(page)).toHaveValue('11, 3');
  await expect(codeSheet(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
});

// spec: add-pet-errands › Skill code flow › game's code cap reached
test('game\'s code cap reached: «The game has run all the code it can for today. …»; nothing ran, «Save code» stays inactive', async ({ page }) => {
  await open(page, false, { testCode: { fail: { status: 429, code: 'game_capped' } } });
  await codeField(page).fill(SAVED);
  await runTest(page);
  await expect(codeSheet(page).getByText('The game has run all the code it can for today. Your code is still here — test it again at 02:00.').first()).toBeVisible();
  await expect(saveCode(page)).toBeDisabled();
  await expect(testRun(page)).not.toHaveAttribute('aria-disabled', 'true');
});

// spec: add-pet-errands › Skill code flow › code saved
test('code saved: Skill sheet with «Pixel\'s code» in the socket and «Saved. Pixel can run its code from its next job.»', async ({ page }) => {
  await open(page, false);
  await codeField(page).fill(SAVED);
  await runTest(page);
  await expect(saveCode(page)).toBeEnabled();
  await saveCode(page).click();
  await expect(codeSheet(page)).toHaveCount(0);
  await expect(skillSheet(page)).toBeVisible();
  await expect(skillSheet(page).getByText('Saved. Pixel can run its code from its next job.').first()).toBeVisible();
  await expect(skillSheet(page).getByRole('button', { name: "Pixel's code" })).toBeVisible();
  expect(await calls(page)).toContain('worker:saveCode');
  // the dialog closes onto Skill sheet's outcome line (DS › Sheet › Focus)
  await expect(skillSheet(page).locator('.ds-note[tabindex="-1"]')).toBeFocused();
});

// spec: add-pet-errands › Skill code flow › test from an earlier day
test('test from an earlier day: nothing is saved, «Save code» turns inactive with the new-day line, the field and the ticks stay; a new test brings it back', async ({ page }) => {
  await open(page, false, { saveCode: { fail: { status: 409, code: 'not_tested' } } });
  await codeField(page).fill(SAVED);
  await runTest(page);
  const dialog = codeSheet(page);
  await dialog.getByRole('checkbox', { name: 'openerFor' }).uncheck();
  await expect(saveCode(page)).toBeEnabled();
  await saveCode(page).click();
  await expect(dialog.getByText('A new day started since your last test. Run one test, then save.')).toBeVisible();
  await expect(codeSheet(page)).toBeVisible();
  await expect(saveCode(page)).toBeDisabled();
  await expect(codeField(page)).toHaveValue(SAVED);
  await expect(dialog.getByRole('checkbox', { name: 'openerFor' })).not.toBeChecked();
  expect(await calls(page)).toContain('worker:saveCode');
  await testRun(page).click();
  await expect(dialog.getByText('A new day started since your last test. Run one test, then save.')).toHaveCount(0);
  await expect(saveCode(page)).toBeEnabled();
});

// spec: add-pet-errands › Skill code flow › code removed
test('code removed: Skill sheet without the code and «Code removed. Pixel stops running it from its next job.»', async ({ page }) => {
  await open(page, true);
  await codeSheet(page).getByRole('button', { name: 'Remove code' }).click();
  await expect(codeSheet(page)).toHaveCount(0);
  await expect(skillSheet(page).getByText('Code removed. Pixel stops running it from its next job.').first()).toBeVisible();
  await expect(skillSheet(page).getByRole('button', { name: 'Add code' })).toBeVisible();
  await expect(skillSheet(page).locator('.ds-note[tabindex="-1"]')).toBeFocused();
});

// spec: add-pet-errands › Skill code sheet screen › error
test('error: the line and «Try again» when the save does not come back; the field keeps its text and the skill stays as it was', async ({ page }) => {
  await open(page, false, { testCode: { outcome: 'ok', output: '"ok"', functions: FUNCTIONS }, saveCode: { fail: { status: 0, code: 'unreachable' } } });
  await codeField(page).fill(SAVED);
  await runTest(page);
  await saveCode(page).click();
  const dialog = codeSheet(page);
  await expect(dialog.getByText(ERROR_LINE).first()).toBeVisible();
  await expect(codeField(page)).toHaveValue(SAVED);
  await setWorker(page, { saveCode: { code: { functions: FUNCTIONS } } });
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(codeSheet(page)).toHaveCount(0);
  await expect(skillSheet(page).getByText('Saved. Pixel can run its code from its next job.').first()).toBeVisible();
});

// spec: add-pet-errands › Skill code sheet screen › success × the session ends and sign-in returns
test('success × the session ends and sign-in returns: the ended-session line and «Sign in»; back, the sheet opens with the code, the function and the values as typed, no test outcome', async ({ page }) => {
  await open(page, false);
  await codeField(page).fill(EDITED);
  await fnField(page).fill('openerFor');
  await valuesField(page).fill('11, 3');
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await testRun(page).click();
  await expect(codeSheet(page).getByText(SESSION_LINE).first()).toBeVisible();
  expect((await calls(page)).filter((c) => c.includes('testCode'))).toEqual([]);
  await setWorker(page, { sessionExpired: false });
  await codeSheet(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(codeSheet(page)).toBeVisible();
  await expect(codeField(page)).toHaveValue(EDITED);
  await expect(fnField(page)).toHaveValue('openerFor');
  await expect(valuesField(page)).toHaveValue('11, 3');
  await expect(saveCode(page)).toBeDisabled();
});

// spec: add-pet-errands › Skill code sheet screen › success × reload
test('success × reload: a reload closes the sheet and what was typed is gone; the saved code comes back from the server', async ({ page }) => {
  await open(page, true);
  await codeField(page).fill(EDITED);
  await reloadHolding(page);
  await expect(page.getByRole('button', { name: `Pixel's skill: Good at ${LABEL}` })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: `Pixel's skill: Good at ${LABEL}` }).click();
  await skillSheet(page).getByRole('button', { name: "Pixel's code" }).click();
  await expect(codeField(page)).toHaveValue(SAVED);
  await expect(fnField(page)).toHaveValue('');
});

// spec: add-pet-errands › Skill code sheet screen › success × Esc
test('success × Esc: Esc closes the code sheet and Skill sheet under it, and the focus goes back to the skill badge', async ({ page }) => {
  await open(page, true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Pixel's skill: Good at ${LABEL}` })).toBeFocused();
});

// spec: add-pet-errands › Skill code sheet screen › success
test('success: Close keeps what was typed for the next opening while the page stands', async ({ page }) => {
  await open(page, false);
  await codeField(page).fill(EDITED);
  await codeSheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // closed, the focus goes back to what opened the sheets: the skill badge (DS › Sheet › Focus)
  await expect(page.getByRole('button', { name: `Pixel's skill: Good at ${LABEL}` })).toBeFocused();
  await page.getByRole('button', { name: `Pixel's skill: Good at ${LABEL}` }).click();
  await skillSheet(page).getByRole('button', { name: 'Add code' }).click();
  await expect(codeField(page)).toHaveValue(EDITED);
});
