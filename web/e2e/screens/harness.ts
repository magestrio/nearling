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

// Mona Sans in the page before its first layout: the faces of web/src/ds/ds.css, their files read once per worker. Asked
// for over the network, the type came from a dev server busy with eight pages up to 12 s late (measured, add-pet-work fix
// round 3); landing after the conversation had settled on its newest line, it re-laid the text and the browser's scroll
// anchoring moved the log 2 px up with no change of size, which the log does not follow back — the capture then waited
// for an end the log no longer rested on. Same files, same descriptors: the page draws the same type.
type MonaFace = { family: string; data: string; descriptors: FontFaceDescriptors };
let monaFaces: MonaFace[] | undefined;
function readMonaFaces(): MonaFace[] {
  if (monaFaces) return monaFaces;
  const css = fs.readFileSync(path.join(REPO_ROOT, 'web', 'src', 'ds', 'ds.css'), 'utf8');
  const faces = Array.from(css.matchAll(/@font-face\s*\{([^}]*)\}/g), (m): MonaFace => {
    const body = m[1] ?? '';
    const get = (prop: string) => body.match(new RegExp(`${prop}:\\s*([^;]+);`))?.[1]?.trim() ?? '';
    const file = get('src').match(/url\('\/([^']+)'\)/)?.[1];
    if (!file) throw new Error(`no url() in an @font-face of ds.css: ${body}`);
    return {
      family: get('font-family').replace(/['"]/g, ''),
      data: fs.readFileSync(path.join(REPO_ROOT, 'web', 'public', file)).toString('base64'),
      // the CSS keyword as written in ds.css (`block`)
      descriptors: { style: get('font-style'), weight: get('font-weight'), stretch: get('font-stretch'), unicodeRange: get('unicode-range'), display: get('font-display') as FontDisplay },
    };
  });
  monaFaces = faces;
  return faces;
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
  await page.addInitScript((faces) => {
    for (const face of faces) {
      const bytes = Uint8Array.from(atob(face.data), (c) => c.charCodeAt(0));
      document.fonts.add(new FontFace(face.family, bytes, face.descriptors));
    }
  }, readMonaFaces());
  await page.goto(fixture.route);
  await page.evaluate(() => document.fonts.ready);
  if (fixture.prepare) await fixture.prepare(page);
  // The pet module installs this hook (in the e2e mode only): the pet, held on its still, has drawn.
  await page.evaluate(() => (globalThis as { __nearlingFreeze?: () => void }).__nearlingFreeze?.());
  if ((frame.scroll ?? 'top') === 'end') await scrollToEnd(page);
  else {
    // A sheet still sliding in makes the document taller for a moment, and Playwright's click on a control inside it scrolls
    // the page to bring that control into view (watch-empty-target came out 67 px down under load). The frame is at its top.
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  const elsewhere = new Set([...(fixture.otherChange ?? []).map((o) => o.line), ...(fixture.staleCopy ?? [])]);
  // a line the frame draws as a title and a body (a sheet named by the first sentence of its words) is two texts on the page: each
  // half is asserted, cut after the first sentence
  const splitCopy = new Set(fixture.splitCopy ?? []);
  const lines = (frame.copy ?? []).flatMap((line) => {
    if (!splitCopy.has(line) || elsewhere.has(line)) return [line];
    const cut = line.indexOf('. ') + 1;
    return [line.slice(0, cut), line.slice(cut + 1)];
  });
  for (const line of lines) {
    if (elsewhere.has(line)) continue;
    // a line is on the page as text, as a field's placeholder, or as the name of an icon-only control (the phone's «My pets»)
    const pattern = copyPattern(line);
    // One occurrence must actually be in the visible part of every scrolling ancestor and the viewport.
    // Playwright's visible filter alone also accepts text that has scrolled out of an inner sheet body.
    const candidates = page.getByText(pattern).or(page.getByPlaceholder(pattern)).or(page.locator('[aria-label]').and(page.getByLabel(pattern))).filter({ visible: true });
    if (fixture.hiddenCopy?.includes(line)) {
      await expect(page.getByText(pattern).first(), `copy «${line}» of ${frame.id} in the page's text for a screen reader`).toBeAttached();
      continue;
    }
    if (fixture.belowFold?.includes(line)) {
      await expect(candidates.and(page.locator(':not(.ds-hidden)')).first(), `copy «${line}» of ${frame.id} drawn below the fold`).toBeAttached();
      continue;
    }
    await expect.poll(() => candidates.evaluateAll((elements) => elements.some((el) => {
      if (el.closest('.ds-hidden, [aria-hidden="true"]')) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      let box = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        // a `display: contents` ancestor has no box: it clips nothing
        if (style.display === 'contents' || !/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) continue;
        const clip = parent.getBoundingClientRect();
        box = { left: Math.max(box.left, clip.left), top: Math.max(box.top, clip.top), right: Math.min(box.right, clip.right), bottom: Math.min(box.bottom, clip.bottom) };
      }
      return rect.left >= box.left - 1 && rect.top >= box.top - 1 && rect.right <= box.right + 1 && rect.bottom <= box.bottom + 1;
    })), { message: `copy «${line}» of ${frame.id} inside the visible scroll box` }).toBe(true);
  }

  // The fixture can replace its loading state after the first font wait. Wait for the faces
  // used by the final copy, then allow its new glyph layout to reach the paint pipeline.
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('440 20px "Mona Sans"'),
      document.fonts.load('640 24px "Mona Sans"'),
      document.fonts.load('720 52px "Mona Sans"'),
    ]);
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  fs.mkdirSync(CMP_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${frame.id}.${viewport}.png`);
  // The software rasterizer paints a page in tiles and the glyph atlas fills as text is first drawn: on a loaded machine a
  // screenshot can catch a heading or a name half painted (a letter missing, a line absent). The pet is frozen and the
  // fixtures leave nothing moving, so a settled page gives the same pixels twice in a row: the capture written is the first
  // one that equals the one before it (the last, after six tries — a blinking caret or a canvas that never rests).
  let previous = await page.screenshot();
  for (let tries = 0; tries < 6; tries += 1) {
    const next = await page.screenshot();
    const settled = next.equals(previous);
    previous = next;
    if (settled) break;
  }
  fs.writeFileSync(out, previous);
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
