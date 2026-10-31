import { expect, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyPattern, VIEWPORTS, type ManifestFrame, type ViewportName } from './copy';
import type { ScreenFixture } from './fixtures';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const MANIFEST_PATH = path.join(REPO_ROOT, 'design', 'bundle', 'manifest.json');
export const FRAMES_DIR = path.join(REPO_ROOT, 'design', 'frames');
export const OUT_DIR = path.join(REPO_ROOT, 'build', 'screens');
export const CMP_DIR = path.join(OUT_DIR, 'cmp');

export function readManifestFrames(): ManifestFrame[] {
  if (!fs.existsSync(MANIFEST_PATH)) return [];
  return (JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { frames: ManifestFrame[] }).frames;
}

/** The frame's own scroll, as design/bundle/frame.js does it: the first inner column that scrolls, else the document. */
async function scrollToEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-frame] *'))) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        el.scrollTop = el.scrollHeight;
        return;
      }
    }
    const doc = document.scrollingElement;
    if (doc && doc.scrollHeight > window.innerHeight + 1) window.scrollTo(0, doc.scrollHeight);
  });
}

/** Brings the real client to the frame's state, freezes the pet, checks the frame's copy and writes the capture. */
export async function captureFrame(page: Page, frame: ManifestFrame, viewport: ViewportName, fixture: ScreenFixture): Promise<string> {
  await page.setViewportSize(VIEWPORTS[viewport]);
  await page.addInitScript((fakes) => {
    (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__ = fakes;
  }, { pet: { hold: true }, ...fixture.fakes });
  if (fixture.beforeLoad) await fixture.beforeLoad(page);
  await page.goto(fixture.route);
  await page.evaluate(() => document.fonts.ready);
  if (fixture.prepare) await fixture.prepare(page);
  // The pet module installs this hook (in the e2e mode only): the pet, held on its still, has drawn.
  await page.evaluate(() => (globalThis as { __nearlingFreeze?: () => void }).__nearlingFreeze?.());
  if ((frame.scroll ?? 'top') === 'end') await scrollToEnd(page);

  const elsewhere = new Set([...(fixture.otherChange ?? []).map((o) => o.line), ...(fixture.staleCopy ?? [])]);
  for (const line of frame.copy ?? []) {
    if (elsewhere.has(line)) continue;
    // a line is on the page as text, or as a field's placeholder
    const pattern = copyPattern(line);
    // the frame may carry the line twice, one copy per viewport (the desktop's foot, the phone's card): one visible is enough
    await expect(page.getByText(pattern).or(page.getByPlaceholder(pattern)).filter({ visible: true }).first(), `copy «${line}» of ${frame.id}`).toBeVisible();
  }

  fs.mkdirSync(CMP_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${frame.id}.${viewport}.png`);
  // Chromium headless on software GL: the first screenshot of a page with a WebGL canvas comes out without it (measured
  // in the build of add-pet); the one after is right
  if ((await page.locator('canvas').count()) > 0) await page.screenshot({ type: 'jpeg', quality: 1 });
  await page.screenshot({ path: out });
  return out;
}

/** The frame's PNG left, the capture right, written by a page of its own: no image library. */
export async function writeComposite(context: BrowserContext, frame: ManifestFrame, viewport: ViewportName, capturePath: string): Promise<string> {
  const framePath = path.join(FRAMES_DIR, `${frame.id}.${viewport}.png`);
  const size = VIEWPORTS[viewport];
  const uri = (file: string) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  const page = await context.newPage();
  await page.setViewportSize({ width: size.width * 2, height: size.height });
  await page.setContent(
    `<body style="margin:0;display:flex;background:#222"><img src="${uri(framePath)}" style="width:${size.width}px;height:${size.height}px"><img src="${uri(capturePath)}" style="width:${size.width}px;height:${size.height}px"></body>`,
  );
  const out = path.join(CMP_DIR, `${frame.id}.${viewport}.png`);
  await page.screenshot({ path: out });
  await page.close();
  return out;
}
