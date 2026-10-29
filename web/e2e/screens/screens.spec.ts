import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { viewportsOf } from './copy';
import { fixtures } from './fixtures';
import { FRAMES_DIR, captureFrame, readManifestFrames, writeComposite } from './harness';

// One test per frame that has a fixture, per viewport it keeps, titled `<frame-id> · <desktop|phone>`.
// The frame's anchor sits above its entry in fixtures.ts. design/ is the private side of the repo: a
// checkout without it has no manifest, hence no tests.
for (const frame of readManifestFrames()) {
  const fixture = fixtures[frame.id];
  if (!fixture) continue;
  for (const viewport of viewportsOf(frame)) {
    test(`${frame.id} · ${viewport}`, async ({ page, context }) => {
      const capture = await captureFrame(page, frame, viewport, fixture);
      if (fs.existsSync(path.join(FRAMES_DIR, `${frame.id}.${viewport}.png`))) {
        await writeComposite(context, frame, viewport, capture);
      }
    });
  }
}
