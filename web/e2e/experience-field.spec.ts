import { expect, test } from '@playwright/test';
import { calls, lookAgain, openWith, PIXEL, setWorker, SIGNED_IN } from './helpers';
import type { ExperienceNotes } from '../src/seams/worker-types';

const ID = 'a'.repeat(24);
const NOTES: ExperienceNotes = { tokenId: '9', generation: 1, field: null, notes: [
  { id: ID, text: 'Rail operators often sell cheaper fares on their own sites than aggregators show.', proposedField: 'Worked on comparing train fares', sourceReportId: ID, sourceForm: 'find', at: Date.parse('2026-11-11T12:00:00Z'), approved: true },
] };
const fakes = (experience: ExperienceNotes = NOTES) => ({ auth: SIGNED_IN, worker: { owned: ['9'], pets: { '9': PIXEL }, experience } });

// spec: add-pet-experience › Field sheet screen › success
test('sheet shows exact wording and Escape keeps it private', async ({ page }) => {
  await openWith(page, '/pet/9/experience', fakes());
  await page.getByRole('button', { name: 'Publish field' }).click();
  const sheet = page.getByRole('dialog', { name: 'Publish field' });
  await expect(sheet.getByText('This field is public. It describes documented work, not certified expertise.')).toBeVisible();
  await expect(sheet.getByText('Worked on comparing train fares')).toBeVisible();
  await expect(sheet.getByRole('link', { name: /Find out · Nov 11, 2026/ })).toHaveAttribute('href', `/pet/9/verify/${ID}`);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect((await calls(page)).filter((name) => name === 'worker:publishExperienceField')).toHaveLength(0);
});

// spec: add-pet-experience › Experience approval flow › publish field
test('publication uses one approved note and announces the result', async ({ page }) => {
  await openWith(page, '/pet/9/experience', fakes());
  await page.getByRole('button', { name: 'Publish field' }).click();
  await page.getByRole('dialog', { name: 'Publish field' }).getByRole('button', { name: 'Publish field' }).click();
  await expect(page.getByText('Field published').first()).toBeVisible();
  await expect(page.locator(':focus')).toContainText('Field published');
  await expect(page.getByRole('button', { name: 'Publish field' })).toHaveCount(0);
  expect((await calls(page)).filter((name) => name === 'worker:publishExperienceField')).toHaveLength(1);
});

// spec: add-pet-experience › Field sheet screen › error
test('gift closes the sheet and hides private notes', async ({ page }) => {
  await openWith(page, '/pet/9/experience', fakes());
  await page.getByRole('button', { name: 'Publish field' }).click();
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(page.getByRole('dialog', { name: 'Publish field' })).toHaveCount(0);
  await expect(page.getByText('Pixel belongs to someone else now.').first()).toBeVisible();
});

// spec: add-pet-experience › Field sheet screen › success × publish pending / repeat tap
test('connection failure keeps the prior field and permits retry', async ({ page }) => {
  const prior: ExperienceNotes = { ...NOTES, field: { noteId: ID, wording: 'Worked on old fares', sourceReportId: ID }, notes: [
    ...NOTES.notes,
    { ...NOTES.notes[0]!, id: 'b'.repeat(24), sourceReportId: 'b'.repeat(24), proposedField: 'Worked on new fares' },
  ] };
  await openWith(page, '/pet/9/experience', fakes(prior));
  await page.getByRole('button', { name: 'Publish field' }).click();
  await expect(page.getByRole('dialog', { name: 'Publish field' }).getByText('Worked on new fares')).toBeVisible();
  await setWorker(page, { publishExperienceField: { fail: { status: 503, code: 'chain_unreachable' } } });
  await page.getByRole('dialog', { name: 'Publish field' }).getByRole('button', { name: 'Publish field' }).click();
  await expect(page.getByText("Field wasn't published. Check your connection and try again.").first()).toBeVisible();
  await expect(page.getByText('Worked on old fares')).toBeVisible();
  await setWorker(page, { publishExperienceField: undefined });
  await page.getByRole('dialog', { name: 'Publish field' }).getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Field published').first()).toBeVisible();
});

// spec: add-pet-experience › Field sheet screen › success × publish pending / repeat tap
test('pending publication ignores a second tap', async ({ page }) => {
  await openWith(page, '/pet/9/experience', fakes());
  await page.getByRole('button', { name: 'Publish field' }).click();
  await setWorker(page, { delayMs: 800 });
  const publish = page.getByRole('dialog', { name: 'Publish field' }).getByRole('button', { name: 'Publish field' });
  await publish.click();
  await publish.dispatchEvent('click');
  await expect(publish).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Field published').first()).toBeVisible();
  expect((await calls(page)).filter((name) => name === 'worker:publishExperienceField')).toHaveLength(1);
});

// spec: add-pet-experience › Field sheet screen › success × reload / site data erased
test('reload closes the unpublished sheet and refetches approval', async ({ page }) => {
  await openWith(page, '/pet/9/experience', fakes());
  await page.getByRole('button', { name: 'Publish field' }).click();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Publish field' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish field' })).toBeVisible();
});
