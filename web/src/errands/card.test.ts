// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../pet/flat', () => ({ drawFlat: vi.fn() }));

import { cardFacts, CARD_SIZE, formatCardDate, limitLine, paintCard, printedLink, renderCard, sharedLink, sourcesMeta, wrap, type Ctx, type Palette } from './card';

// The Verdict card the browser draws (add-pet-errands › Verdict card screen): what the drawing holds, and that a browser which can't
// make it is the sheet's error.
const PALETTE: Palette = { ground: 'g', line: 'l', text: 't', quiet: 'q', sans: '"Mona Sans"', mono: 'monospace' };
const OCTOPUS = 'Octopuses have three hearts.';
const INPUT = { name: 'Pixel', claim: OCTOPUS, verdict: 'True' as const, sources: 2, date: 'Nov 3, 2026', link: 'example.com/pet/9' };

/** A 2D context that remembers what it was asked to write and to draw; a character is 10 wide. */
function recorder() {
  const texts: Array<{ text: string; font: string; fill: string; y: number }> = [];
  const calls: string[] = [];
  const images: Array<{ y: number; height: number }> = [];
  const ctx: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: 'miter',
    lineCap: 'butt',
    font: '',
    textBaseline: 'alphabetic',
    fillRect: () => calls.push('fillRect'),
    fillText: (text: string, _x: number, y: number) => {
      texts.push({ text, font: String(ctx.font), fill: String(ctx.fillStyle), y });
    },
    measureText: (s: string) => ({ width: s.length * 10 }) as TextMetrics,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    stroke: () => calls.push('stroke'),
    drawImage: (_image: unknown, _x: number, y: number, _width: number, height: number) => { calls.push('drawImage'); images.push({ y, height }); },
    roundRect: () => undefined,
  };
  return { ctx: ctx as unknown as Ctx, texts, calls, images };
}

describe('the words of the card', () => {
  // spec: add-pet-errands › Verdict card screen › success
  it('says «{n} sources · {date}» and «1 source · {date}», and the limit line with the pet\'s name', () => {
    expect(sourcesMeta(2, 'Nov 3, 2026')).toBe('2 sources · Nov 3, 2026');
    expect(sourcesMeta(1, 'Nov 3, 2026')).toBe('1 source · Nov 3, 2026');
    expect(limitLine('Pixel')).toBe("Pixel's owner can check that Pixel wrote this verdict and nobody changed it — not that it's right.");
  });

  // spec: add-pet-errands › Verdict card screen › success
  it('words the day like «Nov 3, 2026» and prints the pet\'s page without its scheme, sharing it whole', () => {
    expect(formatCardDate(new Date('2026-11-03T10:00:00Z'))).toBe('Nov 3, 2026');
    expect(printedLink('9', 'https://example.com')).toBe('example.com/pet/9');
    expect(printedLink('9', 'http://localhost:5173')).toBe('localhost:5173/pet/9');
    expect(sharedLink('9', 'https://example.com')).toBe('https://example.com/pet/9');
  });

  // spec: add-pet-errands › Verdict card screen › success
  it('carries the stamp for True and False, and the «Unclear — …» line, never a stamp, for Unclear', () => {
    expect(cardFacts(INPUT)).toMatchObject({ form: 'Is it true?', stamp: 'True', line: null, meta: '2 sources · Nov 3, 2026', link: 'example.com/pet/9' });
    expect(cardFacts({ ...INPUT, verdict: 'False' }).stamp).toBe('False');
    const unclear = cardFacts({ ...INPUT, verdict: 'Unclear', sources: 0 });
    expect(unclear.stamp).toBeNull();
    expect(unclear.line).toBe("Unclear — Pixel couldn't find enough to say either way.");
  });
});

describe('what the drawing holds', () => {
  // spec: add-pet-errands › Verdict card screen › success
  it('paints the name, the form, the claim in quotes, the stamp, the sources and day, the limit line and the pet\'s page, and the pet\'s picture', () => {
    const { ctx, texts, calls } = recorder();
    paintCard(ctx, cardFacts(INPUT), PALETTE, {} as CanvasImageSource);
    const words = texts.map((t) => t.text);
    expect(words).toContain('Pixel');
    expect(words).toContain('Is it true?');
    expect(words.join(' ')).toContain(`“${OCTOPUS}”`);
    expect(words).toContain('True');
    expect(words).toContain('2 sources · Nov 3, 2026');
    expect(words.join(' ')).toContain('owner can check that Pixel wrote this verdict');
    expect(words).toContain('example.com/pet/9');
    expect(calls).toContain('drawImage');
    expect(calls.filter((c) => c === 'fillRect')).toHaveLength(1);
    // the type is Mona Sans, the link is mono, the colours are the palette's
    expect(texts.find((t) => t.text === 'Pixel')?.font).toContain('"Mona Sans"');
    expect(texts.find((t) => t.text === 'example.com/pet/9')?.font).toContain('monospace');
    expect(texts.find((t) => t.text === 'Pixel')?.fill).toBe('t');
    expect(texts.find((t) => t.text === 'Is it true?')?.fill).toBe('q');
  });

  // spec: add-pet-errands › Verdict card screen › success
  it('paints the «Unclear — …» line where the stamp stands, and no stamp word', () => {
    const { ctx, texts } = recorder();
    paintCard(ctx, cardFacts({ ...INPUT, verdict: 'Unclear' }), PALETTE, null);
    const words = texts.map((t) => t.text).join(' ');
    expect(words).toContain('Unclear — Pixel');
    expect(texts.map((t) => t.text)).not.toContain('True');
    expect(texts.map((t) => t.text)).not.toContain('False');
  });

  // spec: add-pet-errands › Verdict card screen › success
  it('cuts a long claim into at most five lines inside the card, ending in an ellipsis', () => {
    const measure = (s: string) => s.length * 10;
    const lines = wrap('word '.repeat(300), CARD_SIZE - 144, measure, 5);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)!.endsWith('…')).toBe(true);
    expect(Math.max(...lines.map(measure))).toBeLessThanOrEqual(CARD_SIZE - 144);
    expect(wrap('one two', 1000, measure, 5)).toEqual(['one two']);
    // a word wider than the line stands alone rather than looping
    expect(wrap('abcdefghij', 30, measure, 5)).toEqual(['abcdefghij']);
  });

  // spec: add-pet-errands › Verdict card screen › success × a long claim
  it('keeps a long claim, the verdict and the pet above the sources and link', () => {
    const { ctx, texts, images } = recorder();
    paintCard(ctx, cardFacts({ ...INPUT, claim: 'The moon is made of blue cheese and the sun is a giant candle. '.repeat(10) }), PALETTE, {} as CanvasImageSource);
    const footer = texts.find((t) => t.text === INPUT.link)!;
    const sources = texts.find((t) => t.text === '2 sources · Nov 3, 2026')!;
    const verdict = texts.find((t) => t.text === 'True')!;
    const claim = texts.filter((t) => t.text.startsWith('“') || t.text.includes('blue cheese'));
    expect(Math.max(...claim.map((t) => t.y))).toBeLessThan(verdict.y);
    expect(verdict.y).toBeLessThan(sources.y);
    expect(images[0]!.y + images[0]!.height).toBeLessThan(sources.y);
    expect(sources.y).toBeLessThan(footer.y);
  });
});

describe('a browser that can\'t make the card', () => {
  afterEach(() => vi.restoreAllMocks());

  // spec: add-pet-errands › Verdict card screen › error
  it('rejects when there is no 2D canvas', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(renderCard({ ...INPUT, pet: { tokenId: '9', stage: 'adult', state: 'full' } }, document.body)).rejects.toThrow();
  });

  // spec: add-pet-errands › Verdict card screen › error
  it('rejects when the canvas gives no image (toBlob returns null)', async () => {
    const { ctx } = recorder();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(null));
    Object.defineProperty(document, 'fonts', { value: { load: () => Promise.resolve([]) }, configurable: true });
    await expect(renderCard({ ...INPUT, pet: { tokenId: '9', stage: 'adult', state: 'full' } }, document.body)).rejects.toThrow('no image');
  });

  // spec: add-pet-errands › Verdict card screen › success
  it('gives the PNG the canvas made', async () => {
    const { ctx } = recorder();
    const png = new Blob(['x'], { type: 'image/png' });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(png));
    Object.defineProperty(document, 'fonts', { value: { load: () => Promise.resolve([]) }, configurable: true });
    await expect(renderCard({ ...INPUT, pet: { tokenId: '9', stage: 'adult', state: 'full' } }, document.body)).resolves.toBe(png);
  });
});
