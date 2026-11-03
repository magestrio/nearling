import { expect, test, type Page } from '@playwright/test';
import { calls, openWith, OWNER, SIGNED_IN } from './helpers';

const refuseWebGL = (page: Page) =>
  page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
      return (original as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof original;
  });

/** How the page can fail after `canUseWebGL` said yes, or say no to only one kind of context. */
const contextFails = (page: Page, how: 'webgl2-only' | 'after-the-probe') =>
  page.addInitScript((mode) => {
    const original = HTMLCanvasElement.prototype.getContext;
    let asked = 0;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      if (kind === 'webgl2') {
        asked += 1;
        if (mode === 'webgl2-only' || asked > 1) return null;
      }
      return (original as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof original;
  }, how);

// spec: add-pet › Pet screen › WebGL недоступен
test('WebGL недоступен: a browser with WebGL 1 only gets the drawing, not a blank page (three.js asks for WebGL 2)', async ({ page }) => {
  await contextFails(page, 'webgl2-only');
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.locator('[data-illustration]')).toHaveAttribute('data-view', 'flat');
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
});

// spec: add-pet › Pet screen › WebGL недоступен
test('WebGL недоступен: a context that fails after the probe passed ends in the drawing too', async ({ page }) => {
  await contextFails(page, 'after-the-probe');
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  await expect(page.locator('[data-illustration]')).toHaveAttribute('data-view', 'flat');
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await expect(page.getByRole('button', { name: /Pause motion|Play motion/ })).toHaveCount(0);
});

// spec: add-pet › Pet screen › WebGL недоступен
test('WebGL недоступен: a scene that throws takes the pet, not the page', async ({ page }) => {
  const broken = { ...OWNER, pets: { ...OWNER.pets, '9': { ...OWNER.pets['9'], stage: 'Baby' as 'baby' } } };
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: broken });
  await expect(page.getByPlaceholder('Talk to Pixel…')).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Start with the chart, then.');
});

// spec: add-pet › Pet screen › WebGL недоступен
test('WebGL недоступен: the pet is a flat drawing, it does not move, and the conversation and the actions work', async ({ page }) => {
  await refuseWebGL(page);
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, petState: { pending: true } } });
  const figure = page.locator('[data-illustration]');
  await expect(figure).toHaveAttribute('data-view', 'flat');
  await expect(figure.locator('canvas')).toHaveCount(1);
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
  // the drawing is not painted blank
  const painted = await figure.locator('canvas').evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) return true;
    return false;
  });
  expect(painted).toBe(true);
  // it doesn't move, so there is nothing to pause
  await expect(page.getByRole('button', { name: /Pause motion|Play motion/ })).toHaveCount(0);
  // the actions work
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Today' })).toBeVisible();
  const field = page.getByPlaceholder('Talk to Pixel…');
  await field.fill('Can you hear me?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Can you hear me?');
  expect(await calls(page)).toContain('worker:say');
});

// spec: add-pet › Pet screen › WebGL недоступен × контекст потерян посреди игры
test('WebGL недоступен × контекст потерян посреди игры: the same pet in the same state as a flat drawing, the actions work', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: OWNER });
  const figure = page.locator('[data-illustration]');
  await expect(figure).toHaveAttribute('data-view', '3d');
  await expect(page.getByRole('button', { name: 'Pause motion' })).toBeVisible();
  await page.getByPlaceholder('Talk to Pixel…').fill('still here');
  // the context is the one the canvas was created with: give the scene its first frames before it goes
  await page.waitForTimeout(1000);
  const lost = await page.evaluate(() => {
    const gl = (document.querySelector('[data-illustration] canvas') as HTMLCanvasElement).getContext('webgl2')!;
    gl.getExtension('WEBGL_lose_context')!.loseContext();
    return gl.isContextLost();
  });
  // the line three.js prints later («WEBGL_lose_context extension not supported») is its own cleanup on a context
  // already gone: a lost context hands out no extensions
  expect(lost).toBe(true);
  await expect(figure).toHaveAttribute('data-view', 'flat');
  await expect(page.getByRole('img', { name: 'Pixel, full' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Pause motion|Play motion/ })).toHaveCount(0);
  // what was typed stays and sends
  await expect(page.getByPlaceholder('Talk to Pixel…')).toHaveValue('still here');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('still here');
});
