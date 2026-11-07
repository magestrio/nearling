import { expect, test } from '@playwright/test';
import { openWith, OWNER, PIXEL, SIGNED_IN } from './helpers';
import type { ExperienceNotes, WorkRecord } from '../src/seams/worker-types';

const experience: ExperienceNotes = { tokenId: '9', generation: 1, field: null, notes: [
  { id: 'a'.repeat(24), text: 'A note', proposedField: 'Worked on train fares', sourceReportId: 'a'.repeat(24), at: 1, approved: false },
] };
const record: WorkRecord = { tokenId: '9', counts: { paidHires: 1, completedErrands: 1, countedSince: 1 }, field: null, receipts: [] };
async function openDialog(page: Parameters<typeof openWith>[0], hasExperience: boolean) {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { ...OWNER.pets, '9': PIXEL },
    experience: hasExperience ? experience : { ...experience, notes: [] },
    workRecord: hasExperience ? record : { ...record, counts: { ...record.counts, paidHires: 0, completedErrands: 0 } } } });
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
}

// spec: add-pet-experience › Experience clear flow › clear warning
test('every pet gets the chain wording; experienced pet sees the work history warning before Clear memory', async ({ page }) => {
  await openDialog(page, true);
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText(/what's on the chain about Pixel stays public forever/)).toBeVisible();
  const warning = dialog.getByText('Work notes and the public field will be erased. Paid work counts and receipts stay public forever.');
  await expect(warning).toBeVisible();
  expect(await warning.evaluate((element) => {
    const clear = Array.from(element.closest('[role="alertdialog"]')!.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Clear memory');
    return clear ? Boolean(element.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
  })).toBe(true);
});

// spec: add-pet-experience › Experience clear flow › memory cleared
test('clear result names erased notes and retained public history', async ({ page }) => {
  await openDialog(page, true);
  await page.getByText('Work notes and the public field will be erased. Paid work counts and receipts stay public forever.').waitFor();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear memory' }).click();
  await expect(page.getByRole('log')).toContainText('Experience notes cleared. Public work history remains.');
});

// spec: add-pet-experience › Experience clear flow › clear warning
test('failed preliminary reads keep the experience warning visible at consent', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER,
    experience: { fail: { status: 503, code: 'unreachable' } },
    workRecord: { fail: { status: 503, code: 'chain_unreachable' } },
  } });
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: "Clear Pixel's memory" }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('Work notes and the public field will be erased. Paid work counts and receipts stay public forever.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Clear memory' })).toBeVisible();
});
