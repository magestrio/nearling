import { drawFlat, type PetStageName, type PetState } from '../pet/flat';
import { unclearLine } from './lines';

// The Verdict card the browser draws (`Verdict card screen`): a square result card on a Canvas 2D, from the report's own facts — the
// claim, the verdict, the pet's name and picture, «{n} sources · {date}», the limit line and the pet's page link. It is uploaded
// nowhere: the player saves the image or hands it to the share menu. The pet is the flat drawing of the same data as the 3D pet
// (`pet/flat.ts`): it needs no WebGL and no frame of the live canvas, so a lost context or a tainted canvas cannot spoil the card. The
// colours and fonts are the page's own tokens, read from the element the card stands in.

export const CARD_SIZE = 1080;
const PAD = 72;
const PET_BOX = 320;

export type Verdict = 'True' | 'False' | 'Unclear';

export interface CardInput {
  name: string;
  claim: string;
  verdict: Verdict;
  sources: number;
  /** the day of the card, as `formatCardDate` words it */
  date: string;
  /** the pet's page, the link printed on the card: `example.com/pet/9` */
  link: string;
  pet: { tokenId: string; stage: PetStageName; state: PetState; outfit?: string; face?: string };
}

/** The words the card carries. The sheet's own preview (the DS `ShareCard`) reads the same ones. */
export interface CardFacts {
  name: string;
  form: string;
  claim: string;
  /** the stamp's word, or null for «Unclear» */
  stamp: 'True' | 'False' | null;
  /** «Unclear — {name} couldn't find enough to say either way.» in the stamp's place */
  line: string | null;
  meta: string;
  limit: string;
  link: string;
}

export const CARD_FORM = 'Is it true?';

export const limitLine = (name: string) => `${name}'s owner can check that ${name} wrote this verdict and nobody changed it — not that it's right.`;
export const cardError = "We couldn't make the card just now. Try again.";

/** «Nov 3, 2026». */
export function formatCardDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(at);
}

/** «{n} sources · {date}», «1 source · {date}». */
export const sourcesMeta = (n: number, date: string) => `${n} ${n === 1 ? 'source' : 'sources'} · ${date}`;

/** The pet's page as printed: its host and path without the scheme. */
export function printedLink(tokenId: string, origin: string = window.location.origin): string {
  const url = new URL(`/pet/${tokenId}`, origin);
  return `${url.host}${url.pathname}`;
}

/** The pet's page as shared: the whole address. */
export const sharedLink = (tokenId: string, origin: string = window.location.origin): string => new URL(`/pet/${tokenId}`, origin).toString();

export function cardFacts(input: Pick<CardInput, 'name' | 'claim' | 'verdict' | 'sources' | 'date' | 'link'>): CardFacts {
  return {
    name: input.name,
    form: CARD_FORM,
    claim: input.claim,
    stamp: input.verdict === 'Unclear' ? null : input.verdict,
    line: input.verdict === 'Unclear' ? unclearLine(input.name) : null,
    meta: sourcesMeta(input.sources, input.date),
    limit: limitLine(input.name),
    link: input.link,
  };
}

/** What the card is painted with, from the page's tokens. */
export interface Palette {
  ground: string;
  line: string;
  text: string;
  quiet: string;
  sans: string;
  mono: string;
}

/** The tokens as the element `from` computes them (`--color-bg-raised-2`, `--color-line-hairline`, `--color-text-primary`,
 *  `--color-text-secondary`, `--font-sans`, `--font-mono`). */
export function paletteOf(from: Element): Palette {
  const style = getComputedStyle(from);
  const get = (name: string) => style.getPropertyValue(name).trim();
  return {
    ground: get('--color-bg-raised-2'),
    line: get('--color-line-hairline'),
    text: get('--color-text-primary'),
    quiet: get('--color-text-secondary'),
    sans: get('--font-sans'),
    mono: get('--font-mono'),
  };
}

/** The surface the drawing needs of a 2D context. */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineJoin'
  | 'lineCap'
  | 'font'
  | 'textBaseline'
  | 'fillRect'
  | 'fillText'
  | 'measureText'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'stroke'
  | 'drawImage'
  | 'roundRect'
>;

/** `text` cut into lines no wider than `width` by `measure`, at most `max`: the last one ends in «…» when more was left. */
export function wrap(text: string, width: number, measure: (s: string) => number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (measure(next) <= width || current === '') {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1] ?? '';
  while (last && measure(`${last}…`) > width) last = last.slice(0, -1).trimEnd();
  kept[max - 1] = `${last}…`;
  return kept;
}

function stampMark(ctx: Ctx, verdict: 'True' | 'False', x: number, y: number, size: number): void {
  // the DS icons' paths (check: M5 12.5l4.5 4.5L19 7.5; close: two strokes) on a 24-unit grid
  const k = size / 24;
  const at = (px: number, py: number): [number, number] => [x + px * k, y + py * k];
  ctx.beginPath();
  if (verdict === 'True') {
    ctx.moveTo(...at(5, 12.5));
    ctx.lineTo(...at(9.5, 17));
    ctx.lineTo(...at(19, 7.5));
  } else {
    ctx.moveTo(...at(6, 6));
    ctx.lineTo(...at(18, 18));
    ctx.moveTo(...at(18, 6));
    ctx.lineTo(...at(6, 18));
  }
  ctx.stroke();
}

/** Paints the card on `ctx` (`CARD_SIZE` square): name and form, the claim in quotes, the verdict and the pet, then the foot. */
export function paintCard(ctx: Ctx, facts: CardFacts, palette: Palette, pet: CanvasImageSource | null): void {
  const width = CARD_SIZE - PAD * 2;
  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(2, 2, CARD_SIZE - 4, CARD_SIZE - 4, 40);
  ctx.stroke();
  ctx.textBaseline = 'alphabetic';

  const text = (value: string, x: number, y: number, font: string, color: string) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  };
  const measureIn = (font: string) => (s: string) => {
    ctx.font = font;
    return ctx.measureText(s).width;
  };

  // who: the name over the form
  text(facts.name, PAD, PAD + 44, `620 48px ${palette.sans}`, palette.text);
  text(facts.form, PAD, PAD + 90, `440 30px ${palette.sans}`, palette.quiet);

  // Reserve the foot and the full pet before deciding how many claim lines fit.
  const limitFont = `440 28px ${palette.sans}`;
  const limit = wrap(facts.limit, width, measureIn(limitFont), 3);
  const footerTop = CARD_SIZE - PAD - 30 - limit.length * 38 - 44;
  const momentTop = Math.min(600, footerTop - PET_BOX - 24);

  // the claim, in quotes
  const claimFont = `440 56px ${palette.sans}`;
  const claimLines = Math.max(1, Math.min(5, Math.floor((momentTop - 20 - (PAD + 190)) / 74)));
  const claim = wrap(`“${facts.claim}”`, width, measureIn(claimFont), claimLines);
  let y = PAD + 190;
  for (const line of claim) {
    text(line, PAD, y, claimFont, palette.text);
    y += 74;
  }

  // the moment: the stamp (a word and a mark) or the «Unclear — …» line, the pet beside it
  const room = pet ? width - PET_BOX - 40 : width;
  if (facts.stamp) {
    const word = facts.stamp;
    const font = `680 84px ${palette.sans}`;
    ctx.font = font;
    const wordWidth = ctx.measureText(word).width;
    const boxW = 48 * 2 + 72 + 20 + wordWidth;
    const boxH = 136;
    const boxY = momentTop + (PET_BOX - boxH);
    ctx.strokeStyle = palette.text;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(PAD, boxY, boxW, boxH, 28);
    ctx.stroke();
    ctx.lineWidth = 9;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    stampMark(ctx, facts.stamp, PAD + 48, boxY + (boxH - 72) / 2, 72);
    text(word, PAD + 48 + 72 + 20, boxY + 96, font, palette.text);
  } else if (facts.line) {
    const font = `620 40px ${palette.sans}`;
    const lines = wrap(facts.line, room, measureIn(font), 4);
    let ly = momentTop + PET_BOX - lines.length * 54 + 40;
    for (const line of lines) {
      text(line, PAD, ly, font, palette.text);
      ly += 54;
    }
  }
  if (pet) ctx.drawImage(pet, CARD_SIZE - PAD - PET_BOX, momentTop, PET_BOX, PET_BOX);

  // the foot: the number of sources and the day, the limit line, the pet's page
  let fy = footerTop;
  text(facts.meta, PAD, fy, `440 30px ${palette.sans}`, palette.text);
  fy += 48;
  for (const line of limit) {
    text(line, PAD, fy, limitFont, palette.quiet);
    fy += 38;
  }
  text(facts.link, PAD, CARD_SIZE - PAD, `440 28px ${palette.mono}`, palette.quiet);
}

/** The pet's flat drawing on a canvas of its own, transparent; null when the browser has no 2D canvas for it. */
export function petImage(pet: CardInput['pet']): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = PET_BOX;
  canvas.height = PET_BOX;
  drawFlat(canvas, { tokenId: pet.tokenId, stage: pet.stage, state: pet.state, outfit: pet.outfit, face: pet.face });
  return canvas;
}

/** The card as a PNG. A browser that can't give a 2D canvas, or an image from it, is the sheet's `error`. */
export async function renderCard(input: CardInput, from: Element): Promise<Blob> {
  const palette = paletteOf(from);
  // the type must be in before the first stroke of text; a face that is not there falls back to the page's other faces
  await Promise.all([`680 84px ${palette.sans}`, `440 56px ${palette.sans}`, `620 48px ${palette.sans}`].map((font) => document.fonts.load(font).catch(() => [])));
  const canvas = document.createElement('canvas');
  canvas.width = CARD_SIZE;
  canvas.height = CARD_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d canvas');
  paintCard(ctx, cardFacts(input), palette, petImage(input.pet));
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no image'))), 'image/png');
  });
}
