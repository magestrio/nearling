import { expect, test } from '@playwright/test';
import { openWith } from './helpers';
import { THINK_ID, verificationFakes } from './verification.fixtures';
import type { VerificationThought } from '../src/seams/worker-types';

// spec: add-pet-experience › Experience report disclosure data › receipt publication
test('exact-byte publication warns of the signed work note before the owner publishes', async ({ page }) => {
  const fakes = verificationFakes({ variant: 'errand' });
  const row = fakes.worker!.verificationThoughts![THINK_ID] as VerificationThought;
  fakes.worker!.verificationThoughts![THINK_ID] = { ...row, containsWorkNote: true,
    publicationWarning: "This may reveal Pixel's work note along with the report." };
  await openWith(page, `/pet/9/verify/${THINK_ID}`, fakes);
  await page.getByRole('button', { name: 'Share exact bytes' }).click();
  await expect(page.getByRole('dialog').getByText("This may reveal Pixel's work note along with the report.")).toBeVisible();
});

// spec: add-pet-experience › Experience claim rule › public proof opened
test('a public paid-work receipt says what the check cannot prove', async ({ page }) => {
  const fakes = verificationFakes({ signedOut: true, variant: 'worker' });
  const row = fakes.worker!.verificationThoughts![THINK_ID] as VerificationThought;
  fakes.worker!.verificationThoughts![THINK_ID] = { ...row, paidWork: true };
  await openWith(page, `/pet/9/verify/${THINK_ID}`, fakes);
  // The panel renders once per breakpoint (Only on phone / desktop); one is display:none.
  await expect(page.locator('p:visible', { hasText: 'A receipt records paid work. It does not prove the answer was correct.' })).toHaveCount(1);
});
