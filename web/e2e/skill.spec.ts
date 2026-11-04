import { expect, test, type Page } from '@playwright/test';
import { ASLEEP_PIXEL, BISCUIT, calls, drawn, lookAgain, OWNER, openWith, PIXEL, reloadHolding, setWorker, SIGNED_IN } from './helpers';

// Skill sheet and the label (add-pet-work › Skill sheet screen, Skill writing flow, Skill rule): the owner's badge under the pet's name
// opens the sheet; the label is on the page for every viewer. The fakes answer the three reads of the Worker.
test.use({ timezoneId: 'Etc/GMT-2' });

const LABEL = 'opening lines';
const INSTRUCTION = 'Give one surprising opening line, then say in one sentence why it works.';
const WRITTEN = { skill: { label: LABEL, instruction: INSTRUCTION } };
const TEACH = 'Teach Pixel a skill';
const SESSION_LINE = "You've been signed out. Sign in to pick up where you left off.";

const sheet = (page: Page) => page.getByRole('dialog');
const labelField = (page: Page) => page.getByLabel('What is Pixel good at?');
const instructionField = (page: Page) => page.getByLabel('How should Pixel do it?');
const save = (page: Page) => sheet(page).getByRole('button', { name: 'Save skill' });
const teachBadge = (page: Page) => page.getByRole('button', { name: TEACH });
const skilledBadge = (page: Page) => page.getByRole('button', { name: `Pixel's skill: Good at ${LABEL}` });

/** Pixel's page as its owner sees it, with a skill or without. */
const open = async (page: Page, skill: { label: string } | null = null, extra: Record<string, unknown> = {}, pixel: typeof PIXEL | typeof ASLEEP_PIXEL = PIXEL) =>
  openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: { ...OWNER, pets: { '9': { ...pixel, skill, owner: {} }, '2': BISCUIT }, skill: skill ? WRITTEN : { skill: null }, ...extra },
  });
const type = async (page: Page, label = LABEL, instruction = INSTRUCTION) => {
  await labelField(page).fill(label);
  await instructionField(page).fill(instruction);
};

// spec: add-pet-work › Skill sheet screen › success
test('success: the badge «Teach Pixel a skill» opens the sheet with both fields and their hints; «Save skill» is inactive until both have text', async ({ page }) => {
  await open(page);
  await teachBadge(page).click();
  await expect(sheet(page).getByRole('heading', { name: TEACH })).toBeVisible();
  await expect(labelField(page)).toHaveValue('');
  await expect(sheet(page).getByText('Anyone can see this — e.g. plot twists')).toBeVisible();
  await expect(sheet(page).getByText('Only you can read this.')).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    const widths = await page.evaluate(() => {
      const body = document.querySelector('.ds-sheet__body')!.getBoundingClientRect().width;
      const label = document.querySelector<HTMLInputElement>('.ds-sheet__body input.ds-field__input')!.getBoundingClientRect().width;
      const instruction = document.querySelector<HTMLTextAreaElement>('.ds-sheet__body textarea.ds-field__input')!.getBoundingClientRect().width;
      return { body, label, instruction };
    });
    expect(widths.label).toBeGreaterThan(widths.body * 0.8);
    expect(widths.instruction).toBeGreaterThan(widths.body * 0.8);
  }
  await expect(save(page)).toBeDisabled();
  await labelField(page).fill(LABEL);
  await expect(save(page)).toBeDisabled();
  await instructionField(page).fill(INSTRUCTION);
  await expect(save(page)).toBeEnabled();
  await expect(sheet(page).getByRole('button', { name: 'Forget this skill' })).toHaveCount(0);
  // the badge it makes stands beside the label's name, not saved
  await expect(sheet(page).getByText(`Good at ${LABEL}`)).toBeVisible();
});

// spec: add-pet-work › Skill sheet screen › skill already written
test('skill already written: both fields hold the label and the instruction, with «Save skill» and «Forget this skill»', async ({ page }) => {
  await open(page, { label: LABEL });
  await skilledBadge(page).click();
  await expect(sheet(page).getByRole('heading', { name: "Pixel's skill" })).toBeVisible();
  await expect(labelField(page)).toHaveValue(LABEL);
  await expect(instructionField(page)).toHaveValue(INSTRUCTION);
  await expect(save(page)).toBeEnabled();
  await expect(sheet(page).getByRole('button', { name: 'Forget this skill' })).toBeVisible();
});

// spec: add-pet-work › Skill sheet screen › what the sheet says
test('what the sheet says: the two lines, the second with the reset time on the player\'s clock', async ({ page }) => {
  await open(page);
  await teachBadge(page).click();
  await expect(sheet(page).getByText("Pixel uses this only when it answers for others or runs your errands, never in your chats. Other players can't read it, but we send it to NEAR AI with each job, and a clever question could coax out the gist — so leave out anything secret.")).toBeVisible();
  await expect(sheet(page).getByText('The game sets what others pay in food: it climbs with each job today and resets at 02:00.')).toBeVisible();
});

// spec: add-pet-work › Skill sheet screen › error
test('error: the line and «Try again» alone; the page stays as it was; «Try again» opens the sheet', async ({ page }) => {
  await open(page, null, { skill: { fail: { status: 0, code: 'unreachable' } } });
  await teachBadge(page).click();
  await expect(sheet(page).getByText("We couldn't open Pixel's skill right now. Try again in a moment.").last()).toBeVisible();
  await expect(labelField(page)).toHaveCount(0);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  // spec: add-pet-work › Skill sheet screen › error × Try again
  await setWorker(page, { skill: { skill: null } });
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(labelField(page)).toBeVisible();
  await expect(sheet(page).getByText("We couldn't open Pixel's skill")).toHaveCount(0);
});

// spec: add-pet-work › Skill sheet screen › error × Try again
test('error × Try again: a skill that is there opens as «skill already written»', async ({ page }) => {
  await open(page, { label: LABEL }, { skill: { fail: { status: 503, code: 'chain_unreachable' } } });
  await skilledBadge(page).click();
  await expect(sheet(page).getByText("We couldn't open Pixel's skill").last()).toBeVisible();
  await setWorker(page, { skill: WRITTEN });
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(labelField(page)).toHaveValue(LABEL);
  await expect(sheet(page).getByRole('button', { name: 'Forget this skill' })).toBeVisible();
});

// spec: add-pet-work › Skill writing flow › skill saved
test('skill saved: the sheet closes, «Saved. Pixel will use this from its next job.» and the label on the page; a new text replaces the old', async ({ page }) => {
  await open(page);
  await teachBadge(page).click();
  await type(page);
  await save(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(drawn(page, 'Saved. Pixel will use this from its next job.').first()).toBeVisible();
  await expect(skilledBadge(page)).toBeVisible();
  await expect(page.getByText(TEACH)).toHaveCount(0);
  // the label is in the fake's state: it is the pet's now, for every look
  await skilledBadge(page).click();
  await instructionField(page).fill('A new text');
  await save(page).click();
  await expect(sheet(page)).toHaveCount(0);
  expect((await calls(page)).filter((c) => c === 'worker:saveSkill')).toHaveLength(2);
});

// spec: add-pet-work › Skill writing flow › label not accepted
test('label not accepted: «Let\'s pick different words.» under the label, nothing saved, both fields keep their text', async ({ page }) => {
  await open(page, null, { saveSkill: { fail: { status: 400, code: 'bad_label' } } });
  await teachBadge(page).click();
  await type(page, 'a bad word');
  await save(page).click();
  await expect(sheet(page).getByText("Let's pick different words.").first()).toBeVisible();
  await expect(labelField(page)).toHaveValue('a bad word');
  await expect(instructionField(page)).toHaveValue(INSTRUCTION);
  await expect(sheet(page)).toBeVisible();
  await expect(teachBadge(page)).toBeVisible();
});

// spec: add-pet-work › Skill writing flow › skill forgotten
test('skill forgotten: the label off the page, «Pixel forgot this skill. Changed your mind? Save it again before you close this.», the fields keep their text', async ({ page }) => {
  await open(page, { label: LABEL });
  await skilledBadge(page).click();
  await sheet(page).getByRole('button', { name: 'Forget this skill' }).click();
  await expect(sheet(page).getByText('Pixel forgot this skill. Changed your mind? Save it again before you close this.').first()).toBeVisible();
  await expect(labelField(page)).toHaveValue(LABEL);
  await expect(instructionField(page)).toHaveValue(INSTRUCTION);
  await expect(sheet(page).getByRole('button', { name: 'Forget this skill' })).toHaveCount(0);
  await expect(sheet(page).getByRole('heading', { name: "Pixel's skill" })).toBeVisible();
  await expect(save(page)).toBeEnabled();
  // closed, the page shows the dashed slot again
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(teachBadge(page)).toBeVisible();
});

// spec: add-pet-work › Skill writing flow › save failed
test('save failed: «We couldn\'t save that. Nothing\'s lost — try again.» and «Try again»; the fields keep their text; «Try again» saves', async ({ page }) => {
  await open(page, { label: LABEL }, { saveSkill: { fail: { status: 503, code: 'chain_unreachable' } } });
  await skilledBadge(page).click();
  await instructionField(page).fill(`${INSTRUCTION} End on a question.`);
  await save(page).click();
  await expect(sheet(page).getByText("We couldn't save that. Nothing's lost — try again.").first()).toBeVisible();
  await expect(instructionField(page)).toHaveValue(`${INSTRUCTION} End on a question.`);
  await expect(skilledBadge(page)).toBeVisible();
  await setWorker(page, { saveSkill: undefined });
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(drawn(page, 'Saved. Pixel will use this from its next job.').first()).toBeVisible();
  // a failed «Forget this skill» says the same
  await skilledBadge(page).click();
  await setWorker(page, { forgetSkill: { fail: { status: 503, code: 'chain_unreachable' } } });
  await sheet(page).getByRole('button', { name: 'Forget this skill' }).click();
  await expect(sheet(page).getByText("We couldn't save that. Nothing's lost — try again.").first()).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: 'Forget this skill' })).toBeVisible();
});

// spec: add-pet-work › Skill rule › label on the pet's page
test('label on the pet\'s page: «Good at {label}» beside the name for a visitor, a guest and the owner asleep, inert; a pet with none has no line', async ({ page }) => {
  // a guest on a friend's skilled pet: the label, no button
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': { ...BISCUIT, skill: { label: 'weather' } } } } });
  await expect(page.getByText('Good at weather')).toBeVisible();
  await expect(page.getByRole('button', { name: /Good at weather/ })).toHaveCount(0);
  // a visitor with no session
  await openWith(page, '/pet/2', { worker: { pets: { '2': { ...BISCUIT, skill: { label: 'weather' } } } } });
  await expect(page.getByText('Good at weather')).toBeVisible();
  // the owner's asleep pet: the label alone, no opener
  await open(page, { label: LABEL }, {}, ASLEEP_PIXEL);
  await expect(page.getByText(`Good at ${LABEL}`)).toBeVisible();
  await expect(skilledBadge(page)).toHaveCount(0);
  // no skill: nothing for anyone else
  await openWith(page, '/pet/2', { auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL, '2': BISCUIT } } });
  await expect(page.getByText(/Good at/)).toHaveCount(0);
});

// spec: add-pet-work › Skill sheet screen › success × close
test('success × close: the sheet closes, typed text goes with no question, nothing is saved', async ({ page }) => {
  await open(page);
  await teachBadge(page).click();
  await type(page);
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(teachBadge(page)).toBeFocused();
  await teachBadge(page).click();
  await expect(labelField(page)).toHaveValue('');
  expect((await calls(page)).filter((c) => c.includes('saveSkill'))).toEqual([]);
});

// spec: add-pet-work › Skill sheet screen › success × reload
test('success × reload: a reload closes the sheet and the typed text is gone', async ({ page }) => {
  await open(page);
  await teachBadge(page).click();
  await type(page);
  await reloadHolding(page);
  await expect(teachBadge(page)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await teachBadge(page).click();
  await expect(labelField(page)).toHaveValue('');
});

// spec: add-pet-work › Skill sheet screen › success × pet asleep
test('success × pet asleep: the pet falls asleep with the sheet open — the sheet stays and saving still works', async ({ page }) => {
  await open(page);
  await teachBadge(page).click();
  await type(page);
  await setWorker(page, { pets: { '9': { ...ASLEEP_PIXEL, skill: null, owner: {} }, '2': BISCUIT } });
  await lookAgain(page);
  await expect(page.getByText('Pixel is asleep. A meal will wake Pixel up.').first()).toBeVisible();
  await expect(sheet(page)).toBeVisible();
  await save(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText(`Good at ${LABEL}`)).toBeVisible();
});

// spec: add-pet-work › Skill data › forgotten × sheet open
test('forgotten × sheet open: the memory is cleared elsewhere, the skill is gone — the fields keep their text and a save writes a new one', async ({ page }) => {
  await open(page, { label: LABEL });
  await skilledBadge(page).click();
  await expect(labelField(page)).toHaveValue(LABEL);
  // the clear erased the skill on the server; this tab's sheet holds the text it read
  await setWorker(page, { skill: { skill: null }, pets: { '9': { ...PIXEL, skill: null, owner: {} }, '2': BISCUIT } });
  await lookAgain(page);
  await expect(labelField(page)).toHaveValue(LABEL);
  await expect(instructionField(page)).toHaveValue(INSTRUCTION);
  await save(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(skilledBadge(page)).toBeVisible();
});

// spec: add-account › Sign-in return data › вход со ссылки подарка
test('sheet after sign-in: a save after the session ended shows the line and «Sign in»; after the sign-in the sheet is open again with both fields as typed, unsaved', async ({ page }) => {
  await open(page);
  await teachBadge(page).click();
  await type(page);
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await save(page).click();
  await expect(sheet(page).getByText(SESSION_LINE).first()).toBeVisible();
  expect((await calls(page)).filter((c) => c.includes('saveSkill'))).toEqual([]);
  await expect(labelField(page)).toHaveValue(LABEL);
  await setWorker(page, { sessionExpired: false });
  await sheet(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(sheet(page).getByRole('heading', { name: TEACH })).toBeVisible();
  await expect(labelField(page)).toHaveValue(LABEL);
  await expect(instructionField(page)).toHaveValue(INSTRUCTION);
  expect((await calls(page)).filter((c) => c.includes('saveSkill'))).toEqual([]);
  // the owner's line takes none of it
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveValue('');
});

// spec: add-account › Sign-in return data › место потерялось
test('sheet after sign-in with the place lost: neither the sheet nor the text comes back', async ({ page }) => {
  // the return lands with no place in the tab: the client leads the player as from Home, to the current pet
  await page.addInitScript(() => {
    const original = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => {
      if (String(url) === '/') sessionStorage.removeItem('nearling.returnPlace');
      original(data, unused, url);
    };
  });
  await open(page, null, { me: { accountId: 'a'.repeat(64), hatched: { tokenId: '9', name: 'Pixel' }, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 } });
  await teachBadge(page).click();
  await type(page);
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await save(page).click();
  await expect(sheet(page).getByText(SESSION_LINE).first()).toBeVisible();
  await setWorker(page, { sessionExpired: false });
  await sheet(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(teachBadge(page)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveValue('');
});
