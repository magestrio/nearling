import { expect, test } from '@playwright/test';
import { CLOSED_NEW, openWith } from './helpers';
import { SAMPLE_SHOWCASE } from '../src/seams/showcase.sample';

const explorer = 'https://testnet.nearblocks.io/address/nearling-e2e.testnet';

// spec: add-account › Home screen › meadow
test('public meadow reads independently of admission and draws ten live pets with their chain state', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: { fail: { status: 0, code: 'unreachable' } } } });
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.locator('.ds-meadow__ground [role="listitem"]')).toHaveCount(10);
  await expect(page.locator('.ds-meadow__pet--hungry')).toHaveCount(1);
  await expect(page.locator('.ds-meadow__pet--asleep')).toHaveCount(2);
  await expect(page.locator('.ds-meadow__pet--teen')).toHaveCount(2);
  await expect(page.locator('.ds-meadow__pet--baby')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Waffle · full' })).toHaveAttribute('href', '/pet/49');
});

// spec: add-account › Home screen › meadow
test('public pets stay visible with closed admission', async ({ page }) => {
  await openWith(page, '/', { worker: { signIn: CLOSED_NEW } });
  await expect(page.getByRole('button', { name: 'Played here before? Sign in' })).toBeVisible();
  await expect(page.locator('.ds-meadow__ground [role="listitem"]')).toHaveCount(10);
  await page.reload();
  await expect(page.locator('.ds-meadow__ground [role="listitem"]')).toHaveCount(10);
});

// spec: add-account › Home screen › meadow
test('public pets arrive while admission is still loading', async ({ page }) => {
  await openWith(page, '/', { worker: { delayMs: 3_600_000 } });
  await expect(page.getByText('Opening the game…')).toBeVisible();
  await expect(page.locator('.ds-meadow__ground [role="listitem"]')).toHaveCount(10);
});

// spec: add-account › Home screen › meadow
test('phone shows five pets while the same public response has ten', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWith(page, '/', {});
  await expect(page.locator('.ds-meadow__ground [role="listitem"]:visible')).toHaveCount(5);
  await expect(page.getByRole('link', { name: 'Juniper · full' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tofu · full' })).toBeHidden();
});

// spec: add-account › Home screen › meadow numbers
test('numbers preserve grouping and precision and the explorer uses the configured contract in a new tab', async ({ page }) => {
  await openWith(page, '/', {});
  await expect(page.locator('.ds-meadow__stats')).toContainText('1,204 pets hatched');
  await expect(page.locator('.ds-meadow__stats')).toContainText('58,310 thoughts paid for');
  await expect(page.locator('.ds-meadow__stats')).toContainText('41.2 NEAR spent on thinking');
  await expect(page.getByRole('link', { name: 'See it on the NEAR explorer' })).toHaveAttribute('href', explorer);
  await expect(page.getByRole('link', { name: 'See it on the NEAR explorer' })).toHaveAttribute('target', '_blank');
});

// spec: add-account › Home screen › meadow numbers
test('one pet and one thought use singular, and under one NEAR uses two significant digits', async ({ page }) => {
  await openWith(page, '/', { worker: { showcase: { ...SAMPLE_SHOWCASE, numbers: { ...SAMPLE_SHOWCASE.numbers!, pets_hatched: 1, thoughts_paid: 1, spent: '420000000000000000000000' } } } });
  await expect(page.locator('.ds-meadow__stats')).toContainText('1 pet hatched');
  await expect(page.locator('.ds-meadow__stats')).toContainText('1 thought paid for');
  await expect(page.locator('.ds-meadow__stats')).toContainText('0.42 NEAR spent on thinking');
});

// spec: add-account › Home screen › pet on the meadow
test('the revealed tag stays open as the pointer moves from a pet onto it', async ({ page }) => {
  await openWith(page, '/', {});
  const link = page.getByRole('link', { name: 'Juniper · full' });
  const tag = link.locator('.ds-meadow__tag');
  await link.hover();
  await expect(tag).toBeVisible();
  await tag.hover();
  await expect(tag).toHaveCSS('pointer-events', 'auto');
  await expect(tag).toBeVisible();
});

// spec: add-account › Home screen › pet on the meadow
test('links take focus left to right, reveal a tag and navigate immediately on phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWith(page, '/', {});
  const links = page.locator('.ds-meadow__ground .ds-meadow__link:visible');
  await expect(links).toHaveCount(5);
  await expect(links.first()).toHaveAttribute('aria-label', 'Juniper · full');
  await links.first().focus();
  await expect(page.locator('.ds-meadow__tag').first()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(links.nth(1)).toBeFocused();
  await links.first().click();
  await expect(page).toHaveURL(/\/pet\/40$/);
});

// spec: add-account › Home screen › meadow × reduced motion
test('reduced motion begins with still pets and still z until Play motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWith(page, '/', {});
  await expect(page.locator('.ds-meadow--paused')).toBeVisible();
  await expect(page.locator('.ds-meadow__motion .ds-only--desktop button')).toHaveText('Play motion');
  await expect(page.locator('.ds-meadow__pet--asleep .ds-meadow__zz .ds-icon').first()).toHaveCSS('animation-name', 'none');
});

// spec: add-account › Home screen › pet on the meadow
test('forced colors keeps pet focus and tag boundaries visible', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openWith(page, '/', {});
  const link = page.getByRole('link', { name: 'Juniper · full' });
  await link.focus();
  await expect(link).toBeFocused();
  await expect(link.locator('.ds-meadow__tag')).toHaveCSS('border-top-style', 'solid');
  await expect(link).toHaveCSS('outline-style', 'solid');
});

// spec: add-account › Home screen › asleep
test('sleeping pet stays linked, dimmed and shows two still z under Pause motion', async ({ page }) => {
  await openWith(page, '/', {});
  const sleeper = page.getByRole('link', { name: 'Lumen · asleep — out of food' });
  await expect(sleeper).toHaveAttribute('href', '/pet/47');
  await expect(sleeper.locator('.ds-meadow__zz .ds-icon')).toHaveCount(2);
  await page.locator('.ds-meadow__motion .ds-only--desktop button').click();
  await expect(page.locator('.ds-meadow--paused')).toBeVisible();
  await expect(page.locator('.ds-meadow__motion .ds-only--desktop button')).toHaveText('Play motion');
});

// spec: add-account › Home screen › meadow loading
test('a late Showcase read leaves empty number space while admission already works', async ({ page }) => {
  await openWith(page, '/', { worker: { showcaseDelayMs: 1200 } });
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toBeVisible();
  await expect(page.locator('.ds-meadow__stats--loading')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.ds-meadow__pet')).toHaveCount(0);
  await expect(page.locator('.ds-meadow__stats')).toContainText('1,204 pets hatched');
});

// spec: add-account › Home screen › meadow unavailable
test('a failed or empty public read leaves ground and explorer without a numbers line', async ({ page }) => {
  await openWith(page, '/', { worker: { showcase: { fail: { status: 503, code: 'chain_unreachable' } } } });
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toBeVisible();
  await expect(page.locator('.ds-meadow__ground')).toBeVisible();
  await expect(page.locator('.ds-meadow__pet')).toHaveCount(0);
  await expect(page.locator('.ds-meadow__stats')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'See it on the NEAR explorer' })).toBeVisible();
  await expect(page.locator('.ds-meadow__motion')).toHaveCount(0);
});

// spec: add-account › Home screen › meadow unavailable
test('no pet yet also keeps the ground and explorer without numbers', async ({ page }) => {
  await openWith(page, '/', { worker: { showcase: { pets: [], numbers: null } } });
  await expect(page.getByRole('link', { name: 'Hatch your pet' })).toBeVisible();
  await expect(page.locator('.ds-meadow__ground')).toBeVisible();
  await expect(page.locator('.ds-meadow__stats')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'See it on the NEAR explorer' })).toBeVisible();
});

// spec: add-account › Home screen › meadow × Pause motion / Play motion
test('motion choice survives a reload and the phone icon keeps its accessible name', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWith(page, '/', {});
  await page.locator('.ds-meadow__motion .ds-only--phone button').click();
  await expect(page.locator('.ds-meadow--paused')).toBeVisible();
  await page.reload();
  await expect(page.locator('.ds-meadow__motion .ds-only--phone button')).toHaveAttribute('aria-label', 'Play motion');
  await expect(page.locator('.ds-meadow--paused')).toBeVisible();
});

// spec: add-account › Home screen › meadow × tab hidden and back
test('a hidden tab and return keep the viewer motion choice', async ({ page }) => {
  await openWith(page, '/', {});
  await page.getByRole('button', { name: 'Pause motion' }).click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.ds-meadow--paused')).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('button', { name: 'Play motion' })).toBeVisible();
});
