import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { viewportsOf } from './copy';
import { FRAMES_DIR, captureFrame, readManifestFrames, writeComposite } from './harness';
import type { ScreenFixture } from './fixtures';
import { SIGNED_IN } from '../helpers';

const pixel = { tokenId: '9', name: 'Pixel', asleep: false };
const petless = { accountId: 'a'.repeat(64), hatched: pixel, latestBirth: pixel, currentPet: null,
  ownedCount: 0, knownPets: [pixel], birth: { open: true } };
const common = { route: '/' };

const fixtures: Record<string, ScreenFixture> = {
  // spec: add-hatch-again › Petless Home screen › empty
  'home-petless-empty': { ...common, fakes: { auth: SIGNED_IN, worker: { me: { ...petless, knownPets: [] } } } },
  // spec: add-hatch-again › Petless Home screen › loading
  'home-petless-loading': { ...common, fakes: { auth: SIGNED_IN, worker: { me: petless, meDelayMs: 60_000 } } },
  // spec: add-hatch-again › Petless Home screen › error
  'home-petless-error': { ...common, fakes: { auth: SIGNED_IN, worker: { me: { fail: { status: 503, code: 'chain_unreachable' } } } } },
  // spec: add-hatch-again › Petless Home screen › success
  'home-petless-success': { ...common, fakes: { auth: SIGNED_IN, worker: { me: petless } } },
  // spec: add-hatch-again › Petless Home screen › signed-out
  'home-petless-signed-out': { ...common, fakes: {} },
  // spec: add-hatch-again › Petless Home screen › closed birth
  'home-petless-closed-birth': { ...common, fakes: { auth: SIGNED_IN, worker: { me: { ...petless, birth: { open: false, reason: 'budget' } } } } },
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
