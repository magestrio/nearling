import { expect, test } from '@playwright/test';
import { openWith, OWNER, SIGNED_IN } from './helpers';

// spec: add-pet › Pet screen › success (владелец)
test('a page load asks no font host: Mona Sans comes from the game, with both of its axes', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => asked.push(r.url()));
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.getByRole('heading', { level: 1, name: 'Pixel' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect(asked.filter((url) => /fonts\.(googleapis|gstatic)\.com/.test(url))).toEqual([]);
  expect(asked.some((url) => url.endsWith('/fonts/mona-sans-latin.woff2'))).toBe(true);

  // the file has both axes: the same word is wider at wdth 125 than at 75, and at wght 900 than at 200
  const widths = await page.evaluate(async () => {
    await document.fonts.load('400 16px "Mona Sans"');
    const measure = (stretch: string, weight: number) => {
      const span = document.createElement('span');
      span.textContent = 'Nearling hatches';
      span.style.cssText = `font-family: "Mona Sans"; font-size: 64px; font-stretch: ${stretch}; font-weight: ${weight}; position: absolute; visibility: hidden`;
      document.body.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    };
    return { narrow: measure('75%', 400), wide: measure('125%', 400), light: measure('100%', 200), heavy: measure('100%', 900) };
  });
  expect(widths.wide).toBeGreaterThan(widths.narrow * 1.15);
  expect(widths.heavy).toBeGreaterThan(widths.light * 1.05);
});
