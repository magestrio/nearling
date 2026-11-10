import { expect, test } from '@playwright/test';
import { ASLEEP_PIXEL, calls, drawn, openMore, openWith, OWNER, PIXEL, SIGNED_IN } from './helpers';

// spec: add-pet › Pet screen › success (владелец)
test('awake owner without a target opens Watch something', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  // the entry stands in the «More» menu (add-game-layout › Pet actions menu screen)
  await openMore(page);
  await expect(page.getByRole('menuitem', { name: 'Edit watch' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Watch something' }).click();
  await expect(page.getByRole('dialog', { name: 'Watch something' })).toBeVisible();
});

// spec: add-pet-errands › Daily watch flow › target on Pet screen
test('awake owner with a target sees it named and opens Edit watch', async ({ page }) => {
  const watched = { target: 'Rust compiler releases', kind: 'release' as const };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { ...OWNER.pets, '9': { ...PIXEL, watch: watched } } } });
  // the page draws the line in both layouts (the phone intro card is hidden at this width), so only the shown one counts
  await expect(drawn(page, 'Watching: Rust compiler releases')).toHaveCount(1);
  await openMore(page);
  await expect(page.getByRole('menuitem', { name: 'Watch something' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Edit watch' }).click();
  await expect(page.getByRole('dialog', { name: 'Watch something' })).toBeVisible();
});

// spec: add-pet-errands › Daily watch flow › target on Pet screen
test('a signed-out visitor sees the named target without owner controls', async ({ page }) => {
  await openWith(page, '/pet/9', { worker: { pets: { '9': { ...PIXEL, watch: { target: 'Rust compiler releases', kind: 'release' } } } } });
  await expect(page.getByText('Watching: Rust compiler releases')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit watch' })).toHaveCount(0);
});

// spec: add-pet › Pet screen › asleep (владелец)
// spec: add-pet-errands › Errand sheet screen › share while asleep
test('asleep owner can prepare a friend-funded search while ordinary Send stays unavailable', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': ASLEEP_PIXEL } } });
  await expect(page.getByRole('button', { name: 'Send Pixel on an errand' })).toHaveCount(0);
  await openMore(page);
  await expect(page.getByRole('menuitem', { name: 'Watch something' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Ask friends to fund an errand' }).click();
  const sheet = page.getByRole('dialog', { name: 'Send Pixel on an errand' });
  await sheet.getByRole('radio', { name: 'Find out' }).check();
  await sheet.getByLabel('What should Pixel find out?').fill('When does the next NEAR release ship?');
  await expect(sheet.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true');
  await expect(sheet.getByRole('button', { name: 'Share a job for friends to fund' })).not.toHaveAttribute('aria-disabled', 'true');
  expect((await calls(page)).some((name) => name.startsWith('worker:sendErrand'))).toBe(false);
});
