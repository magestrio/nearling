import { CARD_SIZE, paletteOf, petImage, wrap } from '../errands/card';
import type { CardSource } from '../seams/worker-types';
import { nameOf } from '../wardrobe/catalogue';

// The same Canvas 2D, token palette and flat pet picture used by the Verdict card. The sheet and PNG read one source object.
export const shareCardError = "We couldn't make this card. Try again.";
export const stageWord = (stage: 'baby' | 'teen' | 'adult') => ({ baby: 'Baby', teen: 'Teen', adult: 'Grown-up' })[stage];

export function showcaseFacts(source: CardSource, origin: string): { name: string; kind: CardSource['kind']; line?: string; stage?: string; outfit?: string; link: string } {
  const url = new URL(`/pet/${encodeURIComponent(source.tokenId)}`, origin);
  return {
    name: source.name,
    kind: source.kind,
    ...(source.kind === 'thought' ? { line: source.line } : {}),
    ...(source.kind === 'growth' ? { stage: stageWord(source.stage) } : {}),
    ...(source.kind === 'outfit' ? { outfit: nameOf(source.worn) } : {}),
    link: `${url.host}${url.pathname}`,
  };
}

export async function renderShowcaseCard(source: CardSource, pet: { stage: 'baby' | 'teen' | 'adult'; state: 'full' | 'hungry' | 'asleep'; worn: string | null | undefined }, from: Element, origin: string): Promise<Blob> {
  const palette = paletteOf(from);
  await Promise.all([`440 56px ${palette.sans}`, `620 48px ${palette.sans}`].map((font) => document.fonts.load(font).catch(() => [])));
  const facts = showcaseFacts(source, origin);
  const canvas = document.createElement('canvas');
  (canvas as HTMLCanvasElement & { __showcaseCard?: boolean }).__showcaseCard = true;
  canvas.width = CARD_SIZE;
  canvas.height = CARD_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d canvas');
  const pad = 72;
  const box = source.kind === 'thought' ? 320 : 520;
  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(2, 2, CARD_SIZE - 4, CARD_SIZE - 4, 40);
  ctx.stroke();
  ctx.textBaseline = 'alphabetic';
  const draw = (value: string, x: number, y: number, font: string, color: string) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  };
  draw(facts.name, pad, pad + 44, `620 48px ${palette.sans}`, palette.text);
  if (source.kind === 'thought' && facts.line) {
    let size = 56;
    let lines: string[] = [];
    do {
      ctx.font = `440 ${size}px ${palette.sans}`;
      lines = wrap(`“${facts.line}”`, CARD_SIZE - pad * 2, (value) => ctx.measureText(value).width, 10000);
      if (lines.length * size * 1.2 <= 360) break;
      size -= 2;
    } while (size >= 8);
    if (lines.length * size * 1.2 > 360) throw new Error('line does not fit card');
    lines.forEach((line, index) => draw(line, pad, pad + 170 + index * size * 1.2, `440 ${size}px ${palette.sans}`, palette.text));
  }
  const image = petImage({ tokenId: source.tokenId, stage: pet.stage, state: pet.state, outfit: pet.worn ?? undefined });
  // The thought's pet sits at the right under its words; growth and outfit centre it over their centred label.
  if (image) ctx.drawImage(image, source.kind === 'thought' ? CARD_SIZE - pad - box : (CARD_SIZE - box) / 2, source.kind === 'thought' ? CARD_SIZE - pad - 60 - box : 220, box, box);
  if (source.kind !== 'thought') {
    const moment = source.kind === 'growth' ? facts.stage : facts.outfit;
    if (moment) {
      ctx.font = `620 48px ${palette.sans}`;
      const x = (CARD_SIZE - ctx.measureText(moment).width) / 2;
      draw(moment, x, 220 + box + 85, `620 48px ${palette.sans}`, palette.text);
    }
  }
  draw(facts.link, pad, CARD_SIZE - pad, `440 28px ${palette.mono}`, palette.quiet);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('no image')), 'image/png'));
}
