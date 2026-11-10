import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { viewportsOf } from './copy';
import { FRAMES_DIR, captureFrame, readManifestFrames, writeComposite } from './harness';
import type { ScreenFixture } from './fixtures';
import { BISCUIT, setWorker, SIGNED_IN } from '../helpers';

const pixel = { tokenId: '9', name: 'Pixel', asleep: false };
const ready = { open: true, ownedCount: 0, latestBirth: pixel, currentPet: null, knownPets: [pixel] };
const closed = { ...ready, open: false, reason: 'daily' as const, until: '2026-11-02T00:00:00.000Z' };
// the frames show the field at rest: no focus ring from the typing
const fillName = async (page: Page) => {
  const field = page.getByLabel('Name your pet');
  await field.fill('Pixel');
  await field.blur();
};
const common: Pick<ScreenFixture, 'route' | 'belowFold'> = {
  route: '/hatch',
  // The frame is at the top of the phone's scroll area; these controls exist below its fold.
  belowFold: ['Hatch my pet', 'Find a pet to ask', 'Visit {name}', 'Back to {friend_pet}', '{name} is asleep'],
};

// With a status line or a second exit link the pinned action area leaves the phone's form 10 px short: the frame draws the same,
// the AI notice's opener ends under the area's top edge by the 2.5 px of its 44 px hit box, its text whole and in view.
const tall: Pick<ScreenFixture, 'route' | 'belowFold'> = {
  ...common,
  belowFold: [...common.belowFold!, "Your words and your pet's memories about you and friends who feed it go to NEAR AI.", 'Read what goes to NEAR AI'],
};

const fixtures: Record<string, ScreenFixture> = {
  // spec: add-hatch-again › Hatch again screen › success
  'hatch-again-success': { ...common, fakes: { auth: SIGNED_IN, worker: { hatchStatus: ready } }, prepare: fillName },
  // spec: add-hatch-again › Hatch again screen › empty
  'hatch-again-empty': { ...common, fakes: { auth: SIGNED_IN, worker: { hatchStatus: ready } } },
  // spec: add-hatch-again › Hatch again screen › loading
  'hatch-again-loading': { ...tall, fakes: { auth: SIGNED_IN, worker: { hatchStatus: ready } }, prepare: async (page) => {
    await page.getByRole('link', { name: 'Visit Pixel' }).waitFor();
    await fillName(page);
    await setWorker(page, { hatchStatusDelayMs: 60_000 });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByText('Checking if hatching is open…').first().waitFor();
  } },
  // spec: add-hatch-again › Hatch again screen › signed-out
  'hatch-again-signed-out': { ...common, fakes: { worker: { hatchStatus: { open: true } } }, prepare: fillName },
  // spec: add-hatch-again › Hatch again screen › error
  'hatch-again-error': { ...tall, fakes: { auth: SIGNED_IN, worker: { hatchStatus: ready } }, prepare: async (page) => {
    await page.getByRole('link', { name: 'Visit Pixel' }).waitFor();
    await fillName(page);
    await setWorker(page, { hatchStatus: { fail: { status: 503, code: 'chain_unreachable' } } });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByText("We couldn't check hatching right now. Try again.").first().waitFor();
  } },
  // spec: add-hatch-again › Hatch again screen › birth paused
  'hatch-paused': { ...common, fakes: { auth: SIGNED_IN, worker: { hatchStatus: { ...ready, open: false, reason: 'budget' } } }, prepare: fillName },
  // spec: add-hatch-again › Hatch again screen › known pet asleep
  'hatch-known-asleep': { ...common, fakes: { auth: SIGNED_IN, worker: { hatchStatus: { ...ready, knownPets: [{ ...pixel, asleep: true }] } } } },
  // spec: add-hatch-again › Hatch again screen › friend's pet return
  'hatch-friend-return': { ...tall, route: '/hatch?from=2', fakes: { auth: SIGNED_IN, worker: { hatchStatus: ready, pets: { '2': BISCUIT } } }, prepare: async (page) => {
    await fillName(page);
    await page.getByRole('link', { name: 'Back to Biscuit' }).waitFor();
  } },
  // spec: add-hatch-again › Hatch again screen › already owns a pet
  'hatch-already': { ...common, fakes: { auth: SIGNED_IN, worker: { hatchStatus: { ...ready, ownedCount: 1, currentPet: pixel, already: pixel, knownPets: [] } } } },
  // spec: add-hatch-again › Repeat birth flow › no owned pet after gift
  'hatch-no-pets': { ...common, fakes: { auth: SIGNED_IN, worker: { hatchStatus: ready } }, prepare: fillName },
  // spec: add-hatch-again › Hatch again screen › birth closed for the day
  'hatch-no-pets-closed': { ...tall, route: '/hatch?from=2', fakes: { auth: SIGNED_IN, worker: { hatchStatus: closed, pets: { '2': BISCUIT } } }, prepare: async (page) => {
    await fillName(page);
    await page.getByRole('link', { name: 'Back to Biscuit' }).waitFor();
  } },
};

for (const frame of readManifestFrames().filter((item) => item.id in fixtures)) {
  for (const viewport of viewportsOf(frame)) {
    test(`${frame.id} · ${viewport}`, async ({ page, context }) => {
      const capture = await captureFrame(page, frame, viewport, fixtures[frame.id]!);
      if (fs.existsSync(path.join(FRAMES_DIR, `${frame.id}.${viewport}.png`))) {
        await writeComposite(context, frame, viewport, capture);
      }
      expect(fs.existsSync(capture)).toBe(true);
    });
  }
}
