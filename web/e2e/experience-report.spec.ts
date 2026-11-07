import { expect, test } from '@playwright/test';
import { calls, lookAgain, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';
import { THINK_ID, verificationFakes } from './verification.fixtures';
import type { ExperienceNotes, VerificationThought } from '../src/seams/worker-types';

const report = { form: 'find' as const, sources: [], verdict: null, searches: 3, priceCents: 1.4, missed: [] };
const lines = [
  { id: 'e1:you', who: 'player' as const, kicker: 'find' as const, text: 'Compare train fares', at: 1 },
  { id: 'e1', who: 'pet' as const, text: 'The operator site lists a lower fare.', report, at: 2 },
];
async function openReport(page: Parameters<typeof openWith>[0], hasNote: boolean) {
  const proof = verificationFakes({ variant: 'errand' }).worker!.verificationThoughts![THINK_ID] as VerificationThought;
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { ...OWNER.pets, '9': PIXEL },
    conversation: { lines, more: false, before: null },
    verificationThoughts: { e1: { ...proof, id: 'e1', paidWork: true, containsWorkNote: hasNote } } } });
}

// spec: add-pet-experience › Experience capture flow › eligible report
test('paid report with a signed work note links to owner review beside its price', async ({ page }) => {
  await openReport(page, true);
  await expect(page.getByText('New work note')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review experience' }).last()).toHaveAttribute('href', '/pet/9/experience');
});

// spec: add-pet-experience › Experience capture flow › output budget leaves no note
test('paid report without a signed note names the missing note beside the report', async ({ page }) => {
  await openReport(page, false);
  await expect(page.getByText('No work note this time')).toBeVisible();
  await expect(page.getByText('New work note')).toHaveCount(0);
});

// spec: add-pet-experience › Experience capture flow › eligible report
test('a report that arrives before billing gains its note footer after the debit settles', async ({ page }) => {
  const proof = verificationFakes({ variant: 'errand' }).worker!.verificationThoughts![THINK_ID] as VerificationThought;
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { ...OWNER.pets, '9': PIXEL },
    conversation: { lines, more: false, before: null },
    verificationThoughts: { e1: { ...proof, id: 'e1', paidWork: false, containsWorkNote: true } },
  } });
  await expect(page.getByText('New work note')).toHaveCount(0);
  await setWorker(page, { verificationThoughts: { e1: {
    ...proof, id: 'e1', paidWork: true, containsWorkNote: true,
  } } });
  await expect(page.getByText('New work note')).toBeVisible();
});

// spec: add-pet-experience › Experience capture flow › no paid report
test('an older billed report with no experience marker stops checking its receipt', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-11T12:00:00Z') });
  const proof = verificationFakes({ variant: 'errand' }).worker!.verificationThoughts![THINK_ID] as VerificationThought;
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { ...OWNER.pets, '9': PIXEL },
    conversation: { lines, more: false, before: null },
    verificationThoughts: { e1: { ...proof, id: 'e1', status: 'billed', paidWork: false, containsWorkNote: false } },
  } });
  await expect(page.getByText('No work note this time')).toBeVisible();
  await page.clock.runFor(3_000);
  expect((await calls(page)).filter((name) => name === 'worker:verificationThought:e1')).toHaveLength(1);
});

// spec: add-pet-experience › Experience record contract › storage pool cannot cover first count
test('pool refusal replaces the report price and keeps note outcomes hidden', async ({ page }) => {
  const proof = verificationFakes({ variant: 'errand' }).worker!.verificationThoughts![THINK_ID] as VerificationThought;
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { ...OWNER.pets, '9': PIXEL },
    conversation: { lines, more: false, before: null },
    verificationThoughts: { e1: { ...proof, id: 'e1', billing: 'refused', code: 'pool_empty', paidWork: false } },
  } });
  await expect(page.getByText('Work is paused. Nothing was spent.')).toBeVisible();
  await expect(page.getByText('3 searches · 1.4¢')).toHaveCount(0);
  await expect(page.getByText('New work note')).toHaveCount(0);
  await expect(page.getByText('No work note this time')).toHaveCount(0);
});

// spec: add-pet-experience › Experience capture flow › seventh note
test('replacing the oldest of six notes announces the replacement on owner review', async ({ page }) => {
  const notes = Array.from({ length: 6 }, (_, i) => ({ id: `${i + 1}`.repeat(24), text: `Work note ${i + 1}`,
    proposedField: 'Worked on train fares', sourceReportId: `${i + 1}`.repeat(24), at: i + 1, approved: i === 0 }));
  const experience: ExperienceNotes = { tokenId: '9', generation: 1, field: null, notes };
  await openWith(page, '/pet/9/experience', { auth: SIGNED_IN, worker: { ...OWNER, experience } });
  await expect(page.getByText('Work note 1', { exact: true })).toBeVisible();
  await setWorker(page, { experience: { ...experience, notes: [
    { ...notes[0]!, id: '7'.repeat(24), text: 'Work note 7' }, ...notes.slice(1),
  ] } });
  await lookAgain(page);
  await expect(page.getByText('Oldest note replaced').first()).toBeVisible();
  await expect(page.getByText('Work note 1')).toHaveCount(0);
});
