import { expect, test } from '@playwright/test';
import { calls, inCard, lookAgain, openCard, openWith, PIXEL, setWorker, SIGNED_IN } from './helpers';
import type { ExperienceNotes } from '../src/seams/worker-types';

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const NOTES: ExperienceNotes = { tokenId: '9', generation: 2, field: null, notes: [
  { id: A, text: 'Rail operators often sell cheaper fares on their own sites than aggregators show.', proposedField: 'Worked on comparing train fares', sourceReportId: A, sourceForm: 'find', at: Date.parse('2026-11-11T12:00:00Z'), approved: true },
  { id: B, text: 'Is it true? checks go faster when the claim names a date and a place.', proposedField: 'Worked on checking claims', sourceReportId: B, sourceForm: 'check', at: Date.parse('2026-11-11T11:00:00Z'), approved: false },
] };
const worker = (experience: ExperienceNotes | { fail: { status: number; code: string } } = NOTES) => ({ owned: ['9'], pets: { '9': { ...PIXEL, worn: 'thinking-cap' as const } }, experience });

// spec: add-pet-experience › Experience notes screen › success
test('owner reads source reports and changes one approval', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: worker() });
  await openCard(page);
  await inCard(page).getByRole('link', { name: 'Review experience' }).click();
  await expect(page.getByText(NOTES.notes[0]!.text).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Find out · Nov 11, 2026/ }).first()).toHaveAttribute('href', `/pet/9/verify/${A}`);
  await page.getByRole('button', { name: /Use in outside answers for/ }).click();
  await expect(page.getByText('Used in outside answers').first()).toBeVisible();
  expect((await calls(page)).filter((name) => name === 'worker:approveExperience')).toHaveLength(1);
});

// spec: add-pet-experience › Experience approval flow › revoke note
test('revoking a note hides its backed field and makes it private again', async ({ page }) => {
  await openWith(page, '/pet/9/experience', { auth: SIGNED_IN, worker: worker({ ...NOTES, field: { noteId: A, wording: 'Worked on comparing train fares', sourceReportId: A } }) });
  await page.getByRole('button', { name: /Stop using for/ }).click();
  await expect(page.getByText('Private again').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish field' })).toHaveCount(0);
});

// spec: add-pet-experience › Experience notes screen › empty
test('empty notes lead to the existing errand sheet', async ({ page }) => {
  await openWith(page, '/pet/9/experience', { auth: SIGNED_IN, worker: worker({ ...NOTES, notes: [] }) });
  await expect(page.getByText('No work notes yet. A completed paid errand may leave one here.')).toBeVisible();
  await page.getByRole('button', { name: 'Send an errand' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

// spec: add-pet-experience › Experience notes screen › error
test('failed read shows retry without approval controls', async ({ page }) => {
  await openWith(page, '/pet/9/experience', { auth: SIGNED_IN, worker: worker({ fail: { status: 503, code: 'chain_unreachable' } }) });
  await expect(page.getByText("Experience couldn't load. Try again.").first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Use in outside answers/ })).toHaveCount(0);
  await setWorker(page, { experience: NOTES });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(NOTES.notes[0]!.text).first()).toBeVisible();
});

// spec: add-pet-experience › Experience notes screen › signed-out
test('signed-out entry keeps private text hidden', async ({ page }) => {
  await openWith(page, '/pet/9/experience', { worker: worker() });
  await expect(page.getByText("Sign in to review Pixel's notes").first()).toBeVisible();
  await expect(page.getByText(NOTES.notes[0]!.text)).toHaveCount(0);
  expect((await calls(page)).filter((name) => name === 'worker:experience')).toHaveLength(0);
});

// spec: add-pet-experience › Experience notes screen › signed-out × sign-in return
test('Google return restores the notes route only for the current owner', async ({ page }) => {
  await openWith(page, '/pet/9/experience', { worker: worker() });
  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9\/experience$/);
  await expect(page.getByText(NOTES.notes[0]!.text).first()).toBeVisible();
});

// spec: add-pet-experience › Experience notes screen › signed-out × gift before sign-in return
test('a gift before return leaves no private note on the restored route', async ({ page }) => {
  await openWith(page, '/pet/9/experience', { worker: { ...worker(), owned: [] } });
  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByText(NOTES.notes[0]!.text)).toHaveCount(0);
});

// spec: add-pet-experience › Experience notes screen › asleep
test('an asleep pet keeps notes readable and offers the existing feed path', async ({ page }) => {
  await openWith(page, '/pet/9/experience', { auth: SIGNED_IN, worker: { ...worker(), pets: { '9': { ...PIXEL, fullness: { state: 'asleep' as const, level: 0 } } } } });
  await expect(page.getByText('Pixel is asleep. Feed Pixel to send another errand.')).toBeVisible();
  await expect(page.getByText(NOTES.notes[0]!.text).first()).toBeVisible();
  await page.getByRole('button', { name: 'Feed Pixel' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

// spec: add-pet-experience › Experience approval flow › lost ownership
test('a gift hides private notes and refuses a former-owner action', async ({ page }) => {
  await openWith(page, '/pet/9/experience', { auth: SIGNED_IN, worker: worker() });
  await expect(page.getByText(NOTES.notes[0]!.text).first()).toBeVisible();
  await setWorker(page, { owned: [] });
  await lookAgain(page);
  await expect(page.getByText('Pixel belongs to someone else now.').first()).toBeVisible();
  await expect(page.getByText(NOTES.notes[0]!.text)).toHaveCount(0);
});
